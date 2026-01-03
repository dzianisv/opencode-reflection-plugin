/**
 * Manual TTS Test - Actually speaks text to verify TTS works
 * 
 * Run with: npm run test:tts:manual
 * 
 * Options via environment variables:
 *   TTS_ENGINE=chatterbox  - Use Chatterbox (default)
 *   TTS_ENGINE=os          - Use OS TTS (macOS say)
 */

import { exec, spawn } from "child_process"
import { promisify } from "util"
import { writeFile, unlink, access } from "fs/promises"
import { join } from "path"
import { homedir, tmpdir } from "os"

const execAsync = promisify(exec)

const MAX_SPEECH_LENGTH = 1000

type TTSEngine = "chatterbox" | "os"

function cleanTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "code block omitted")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#]+/g, "")
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/\/[\w./-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

// Chatterbox Python script
const CHATTERBOX_SCRIPT = `#!/usr/bin/env python3
import sys
import argparse

def main():
    parser = argparse.ArgumentParser(description="Chatterbox TTS")
    parser.add_argument("text", help="Text to synthesize")
    parser.add_argument("--output", "-o", required=True, help="Output WAV file")
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    parser.add_argument("--exaggeration", type=float, default=0.5)
    parser.add_argument("--turbo", action="store_true", help="Use Turbo model")
    args = parser.parse_args()
    
    try:
        import torchaudio as ta
        
        if args.turbo:
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            model = ChatterboxTurboTTS.from_pretrained(device=args.device)
        else:
            from chatterbox.tts import ChatterboxTTS
            model = ChatterboxTTS.from_pretrained(device=args.device)
        
        wav = model.generate(args.text, exaggeration=args.exaggeration)
        ta.save(args.output, wav, model.sr)
        print(f"Saved to {args.output}")
        
    except ImportError as e:
        print(f"Error: Missing dependency - {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
`

async function isChatterboxAvailable(): Promise<boolean> {
  try {
    await execAsync('python3 -c "import chatterbox; print(\'ok\')"', { timeout: 10000 })
    return true
  } catch {
    return false
  }
}

async function speakWithChatterbox(text: string): Promise<boolean> {
  const scriptPath = join(tmpdir(), "chatterbox_tts_test.py")
  const outputPath = join(tmpdir(), `tts_test_${Date.now()}.wav`)
  
  // Write script
  await writeFile(scriptPath, CHATTERBOX_SCRIPT, { mode: 0o755 })
  
  return new Promise((resolve) => {
    // Try cuda first, fall back to cpu
    const proc = spawn("python3", [
      scriptPath,
      "--output", outputPath,
      "--device", "cuda",
      "--exaggeration", "0.5",
      text
    ])
    
    let stderr = ""
    proc.stderr?.on("data", (data) => {
      stderr += data.toString()
    })
    
    proc.on("close", async (code) => {
      if (code !== 0) {
        // Try CPU if CUDA failed
        if (stderr.includes("cuda") || stderr.includes("CUDA")) {
          console.log("[TTS] CUDA not available, trying CPU...")
          const cpuProc = spawn("python3", [
            scriptPath,
            "--output", outputPath,
            "--device", "cpu",
            "--exaggeration", "0.5",
            text
          ])
          
          let cpuStderr = ""
          cpuProc.stderr?.on("data", (data) => {
            cpuStderr += data.toString()
          })
          
          cpuProc.on("close", async (cpuCode) => {
            if (cpuCode !== 0) {
              console.error("[TTS] Chatterbox failed:", cpuStderr)
              resolve(false)
              return
            }
            await playAndCleanup(outputPath, resolve)
          })
          return
        }
        
        console.error("[TTS] Chatterbox failed:", stderr)
        resolve(false)
        return
      }
      
      await playAndCleanup(outputPath, resolve)
    })
  })
}

async function playAndCleanup(outputPath: string, resolve: (value: boolean) => void) {
  try {
    await execAsync(`afplay "${outputPath}"`)
    await unlink(outputPath).catch(() => {})
    resolve(true)
  } catch (error) {
    console.error("[TTS] Failed to play audio:", error)
    await unlink(outputPath).catch(() => {})
    resolve(false)
  }
}

async function speakWithOS(text: string): Promise<void> {
  const escaped = text.replace(/'/g, "'\\''")
  try {
    console.log(`[TTS] Speaking with OS TTS: "${text.slice(0, 50)}..."`)
    await execAsync(`say -r 200 '${escaped}'`)
    console.log("[TTS] Done speaking")
  } catch (error) {
    console.error("[TTS] Failed to speak:", error)
  }
}

async function speak(text: string, engine: TTSEngine): Promise<void> {
  const cleaned = cleanTextForSpeech(text)
  if (!cleaned) return

  const toSpeak = cleaned.length > MAX_SPEECH_LENGTH
    ? cleaned.slice(0, MAX_SPEECH_LENGTH) + "... message truncated."
    : cleaned

  if (engine === "chatterbox") {
    console.log(`[TTS] Speaking with Chatterbox: "${toSpeak.slice(0, 50)}..."`)
    const success = await speakWithChatterbox(toSpeak)
    if (success) {
      console.log("[TTS] Done speaking")
      return
    }
    console.log("[TTS] Chatterbox failed, falling back to OS TTS")
  }
  
  await speakWithOS(toSpeak)
}

// Test cases
const testCases = [
  {
    name: "Simple text",
    input: "Hello! The TTS plugin is working correctly."
  },
  {
    name: "With code block",
    input: `I've created a function for you:
\`\`\`typescript
function greet(name: string) {
  return "Hello " + name;
}
\`\`\`
The function takes a name and returns a greeting.`
  },
  {
    name: "With markdown",
    input: "Here's the **important** information: the task is *complete* and all tests pass."
  },
  {
    name: "With URL and path",
    input: "Check the file /Users/test/project/src/index.ts and visit https://github.com/sst/opencode for docs."
  }
]

async function main() {
  console.log("=== TTS Manual Test ===\n")
  
  // Check which engine to use
  const requestedEngine = (process.env.TTS_ENGINE as TTSEngine) || "chatterbox"
  let engine: TTSEngine = requestedEngine
  
  console.log(`Requested engine: ${requestedEngine}`)
  
  // Check if say command exists (needed for OS TTS and fallback)
  try {
    await execAsync("which say")
    console.log("✓ OS TTS (macOS say) available")
  } catch {
    console.error("✗ OS TTS not available - 'say' command not found")
    if (engine === "os") {
      console.error("ERROR: OS TTS requested but not available")
      process.exit(1)
    }
  }
  
  // Check if Chatterbox is available
  if (engine === "chatterbox") {
    const chatterboxAvailable = await isChatterboxAvailable()
    if (chatterboxAvailable) {
      console.log("✓ Chatterbox available")
    } else {
      console.log("✗ Chatterbox not available (pip install chatterbox-tts)")
      console.log("  Falling back to OS TTS")
      engine = "os"
    }
  }
  
  console.log(`\nUsing engine: ${engine}\n`)

  for (const test of testCases) {
    console.log(`\n--- Test: ${test.name} ---`)
    console.log(`Input: ${test.input.slice(0, 80)}...`)
    console.log(`Cleaned: ${cleanTextForSpeech(test.input).slice(0, 80)}...`)
    await speak(test.input, engine)
    
    // Small pause between tests
    await new Promise(r => setTimeout(r, 500))
  }

  console.log("\n=== All tests complete ===")
}

main()
