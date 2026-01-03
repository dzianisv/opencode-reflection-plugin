/**
 * TTS (Text-to-Speech) Plugin for OpenCode
 *
 * Reads the final answer aloud when the agent finishes.
 * Supports multiple TTS engines:
 *   - chatterbox: High-quality neural TTS (auto-installed in virtualenv)
 *   - os: Native OS TTS (macOS `say` command)
 * 
 * Toggle TTS on/off:
 *   /tts       - toggle
 *   /tts on    - enable
 *   /tts off   - disable
 * 
 * Configure engine in ~/.config/opencode/tts.json:
 *   { "enabled": true, "engine": "chatterbox" }
 * 
 * Or set environment variables:
 *   TTS_DISABLED=1    - disable TTS
 *   TTS_ENGINE=os     - use OS TTS instead of chatterbox
 */

import type { Plugin } from "@opencode-ai/plugin"
import { exec, spawn } from "child_process"
import { promisify } from "util"
import { readFile, writeFile, access, unlink, mkdir } from "fs/promises"
import { join } from "path"
import { homedir, tmpdir, platform } from "os"

const execAsync = promisify(exec)

// Maximum characters to read (to avoid very long speeches)
const MAX_SPEECH_LENGTH = 1000

// Track sessions we've already spoken for
const spokenSessions = new Set<string>()

// Config file path for persistent TTS settings
const TTS_CONFIG_PATH = join(homedir(), ".config", "opencode", "tts.json")

// Chatterbox installation directory
const CHATTERBOX_DIR = join(homedir(), ".config", "opencode", "chatterbox")
const CHATTERBOX_VENV = join(CHATTERBOX_DIR, "venv")
const CHATTERBOX_SCRIPT = join(CHATTERBOX_DIR, "tts.py")

// TTS Engine types
type TTSEngine = "chatterbox" | "os"

interface TTSConfig {
  enabled?: boolean
  engine?: TTSEngine
  // Chatterbox-specific options
  chatterbox?: {
    device?: "cuda" | "cpu"           // GPU or CPU (default: cuda, falls back to cpu)
    voiceRef?: string                 // Path to reference voice clip for cloning
    exaggeration?: number             // Emotion exaggeration (0.0-1.0)
    useTurbo?: boolean                // Use Turbo model for lower latency
  }
}

// Cache for chatterbox availability check
let chatterboxAvailable: boolean | null = null
let chatterboxSetupAttempted = false
let hasCudaGpu: boolean | null = null

/**
 * Load TTS configuration from file
 */
async function loadConfig(): Promise<TTSConfig> {
  try {
    const content = await readFile(TTS_CONFIG_PATH, "utf-8")
    return JSON.parse(content)
  } catch {
    // Default config
    return { enabled: true, engine: "chatterbox" }
  }
}

/**
 * Check if TTS is enabled
 */
async function isEnabled(): Promise<boolean> {
  // Env var takes precedence
  if (process.env.TTS_DISABLED === "1") return false
  
  const config = await loadConfig()
  return config.enabled !== false
}

/**
 * Get the TTS engine to use
 */
async function getEngine(): Promise<TTSEngine> {
  // Env var takes precedence
  if (process.env.TTS_ENGINE === "os") return "os"
  if (process.env.TTS_ENGINE === "chatterbox") return "chatterbox"
  
  const config = await loadConfig()
  return config.engine || "chatterbox"
}

/**
 * Find Python 3.11 (required for Chatterbox)
 */
async function findPython311(): Promise<string | null> {
  const candidates = ["python3.11", "/opt/homebrew/bin/python3.11", "/usr/local/bin/python3.11"]
  
  for (const py of candidates) {
    try {
      const { stdout } = await execAsync(`${py} --version 2>/dev/null`)
      if (stdout.includes("3.11")) {
        return py
      }
    } catch {
      // Try next
    }
  }
  return null
}

/**
 * Check if CUDA GPU is available
 */
async function checkCudaAvailable(): Promise<boolean> {
  if (hasCudaGpu !== null) return hasCudaGpu
  
  const venvPython = join(CHATTERBOX_VENV, "bin", "python")
  try {
    const { stdout } = await execAsync(`"${venvPython}" -c "import torch; print(torch.cuda.is_available())"`, { timeout: 30000 })
    hasCudaGpu = stdout.trim() === "True"
    return hasCudaGpu
  } catch {
    hasCudaGpu = false
    return false
  }
}

/**
 * Setup Chatterbox virtual environment and install dependencies
 */
async function setupChatterbox(): Promise<boolean> {
  if (chatterboxSetupAttempted) return chatterboxAvailable === true
  chatterboxSetupAttempted = true
  
  const python = await findPython311()
  if (!python) {
    console.error("[TTS] Python 3.11 not found. Install with: brew install python@3.11")
    return false
  }
  
  try {
    // Create directory
    await mkdir(CHATTERBOX_DIR, { recursive: true })
    
    // Check if venv exists
    const venvPython = join(CHATTERBOX_VENV, "bin", "python")
    try {
      await access(venvPython)
      // Venv exists, check if chatterbox is installed
      const { stdout } = await execAsync(`"${venvPython}" -c "import chatterbox; print('ok')"`, { timeout: 10000 })
      if (stdout.includes("ok")) {
        await ensureChatterboxScript()
        return true
      }
    } catch {
      // Need to create/setup venv
    }
    
    console.log("[TTS] Setting up Chatterbox TTS (one-time install)...")
    
    // Create venv
    await execAsync(`"${python}" -m venv "${CHATTERBOX_VENV}"`, { timeout: 60000 })
    
    // Install chatterbox-tts
    const pip = join(CHATTERBOX_VENV, "bin", "pip")
    console.log("[TTS] Installing chatterbox-tts (this may take a few minutes)...")
    await execAsync(`"${pip}" install --upgrade pip`, { timeout: 120000 })
    await execAsync(`"${pip}" install chatterbox-tts`, { timeout: 600000 }) // 10 min timeout
    
    // Create the TTS script
    await ensureChatterboxScript()
    
    console.log("[TTS] Chatterbox setup complete!")
    return true
  } catch (error) {
    console.error("[TTS] Failed to setup Chatterbox:", error)
    return false
  }
}

/**
 * Ensure the Chatterbox Python helper script exists
 */
async function ensureChatterboxScript(): Promise<void> {
  const script = `#!/usr/bin/env python3
"""
Chatterbox TTS helper script for OpenCode.
Usage: python tts.py [options] "text to speak"
"""

import sys
import argparse

def main():
    parser = argparse.ArgumentParser(description="Chatterbox TTS")
    parser.add_argument("text", help="Text to synthesize")
    parser.add_argument("--output", "-o", required=True, help="Output WAV file")
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    parser.add_argument("--voice", help="Reference voice audio path")
    parser.add_argument("--exaggeration", type=float, default=0.5)
    parser.add_argument("--turbo", action="store_true", help="Use Turbo model")
    args = parser.parse_args()
    
    try:
        import torch
        import torchaudio as ta
        
        # Auto-detect device
        device = args.device
        if device == "cuda" and not torch.cuda.is_available():
            device = "cpu"
        
        if args.turbo:
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            model = ChatterboxTurboTTS.from_pretrained(device=device)
        else:
            from chatterbox.tts import ChatterboxTTS
            model = ChatterboxTTS.from_pretrained(device=device)
        
        # Generate speech
        if args.voice:
            wav = model.generate(
                args.text,
                audio_prompt_path=args.voice,
                exaggeration=args.exaggeration
            )
        else:
            wav = model.generate(args.text, exaggeration=args.exaggeration)
        
        # Save to file
        ta.save(args.output, wav, model.sr)
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
`
  await writeFile(CHATTERBOX_SCRIPT, script, { mode: 0o755 })
}

/**
 * Check if Chatterbox is available and practical to use
 */
async function isChatterboxAvailable(config: TTSConfig): Promise<boolean> {
  if (chatterboxAvailable !== null) return chatterboxAvailable
  
  // Try to setup if not already attempted
  const installed = await setupChatterbox()
  if (!installed) {
    chatterboxAvailable = false
    return false
  }
  
  // Check if GPU is available
  const hasGpu = await checkCudaAvailable()
  const forceCpu = config.chatterbox?.device === "cpu"
  
  if (!hasGpu && !forceCpu) {
    console.log("[TTS] Chatterbox installed but no GPU detected - using OS TTS")
    console.log("[TTS] To force CPU mode (slow), set chatterbox.device to 'cpu' in ~/.config/opencode/tts.json")
    chatterboxAvailable = false
    return false
  }
  
  if (!hasGpu && forceCpu) {
    console.log("[TTS] Running Chatterbox on CPU (this will be slow, ~2-3 min per sentence)")
  }
  
  chatterboxAvailable = true
  return true
}

/**
 * Speak using Chatterbox TTS
 */
async function speakWithChatterbox(text: string, config: TTSConfig): Promise<boolean> {
  const venvPython = join(CHATTERBOX_VENV, "bin", "python")
  const opts = config.chatterbox || {}
  const device = opts.device || "cuda"
  const outputPath = join(tmpdir(), `opencode_tts_${Date.now()}.wav`)
  
  // Build command arguments
  const args = [
    CHATTERBOX_SCRIPT,
    "--output", outputPath,
    "--device", device,
  ]
  
  if (opts.voiceRef) {
    args.push("--voice", opts.voiceRef)
  }
  
  if (opts.exaggeration !== undefined) {
    args.push("--exaggeration", opts.exaggeration.toString())
  }
  
  if (opts.useTurbo) {
    args.push("--turbo")
  }
  
  args.push(text)
  
  return new Promise((resolve) => {
    const proc = spawn(venvPython, args, {
      timeout: 120000, // 2 minute timeout for generation (first run downloads model)
    })
    
    let stderr = ""
    proc.stderr?.on("data", (data) => {
      stderr += data.toString()
    })
    
    proc.on("close", async (code) => {
      if (code !== 0) {
        console.error("[TTS] Chatterbox failed:", stderr)
        resolve(false)
        return
      }
      
      // Play the generated audio
      try {
        if (platform() === "darwin") {
          await execAsync(`afplay "${outputPath}"`)
        } else {
          // Linux: try aplay or paplay
          try {
            await execAsync(`paplay "${outputPath}"`)
          } catch {
            await execAsync(`aplay "${outputPath}"`)
          }
        }
        await unlink(outputPath).catch(() => {})
        resolve(true)
      } catch (error) {
        console.error("[TTS] Failed to play audio:", error)
        await unlink(outputPath).catch(() => {})
        resolve(false)
      }
    })
    
    proc.on("error", (error) => {
      console.error("[TTS] Failed to spawn Chatterbox:", error)
      resolve(false)
    })
  })
}

/**
 * Speak using OS TTS (macOS `say` command)
 */
async function speakWithOS(text: string): Promise<boolean> {
  // Escape single quotes for shell
  const escaped = text.replace(/'/g, "'\\''")
  
  try {
    if (platform() === "darwin") {
      // macOS: use say command
      await execAsync(`say -r 200 '${escaped}'`)
    } else {
      // Linux: try espeak
      await execAsync(`espeak '${escaped}'`)
    }
    return true
  } catch (error) {
    console.error("[TTS] OS TTS failed:", error)
    return false
  }
}

export const TTSPlugin: Plugin = async ({ client, directory }) => {
  /**
   * Extract the final assistant response from session messages
   */
  function extractFinalResponse(messages: any[]): string | null {
    // Find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role === "assistant") {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            return part.text
          }
        }
      }
    }
    return null
  }

  /**
   * Clean text for TTS - remove markdown, code blocks, etc.
   */
  function cleanTextForSpeech(text: string): string {
    return text
      // Remove code blocks
      .replace(/```[\s\S]*?```/g, "code block omitted")
      // Remove inline code
      .replace(/`[^`]+`/g, "")
      // Remove markdown links, keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove markdown formatting
      .replace(/[*_~#]+/g, "")
      // Remove URLs
      .replace(/https?:\/\/[^\s]+/g, "")
      // Remove file paths
      .replace(/\/[\w./-]+/g, "")
      // Collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
  }

  /**
   * Main speak function - tries preferred engine, falls back to OS TTS
   */
  async function speak(text: string): Promise<void> {
    const cleaned = cleanTextForSpeech(text)
    if (!cleaned) return

    // Truncate if too long
    const toSpeak = cleaned.length > MAX_SPEECH_LENGTH
      ? cleaned.slice(0, MAX_SPEECH_LENGTH) + "... message truncated."
      : cleaned

    const config = await loadConfig()
    const engine = await getEngine()
    
    if (engine === "chatterbox") {
      // Check if Chatterbox is available (will auto-install if needed)
      const available = await isChatterboxAvailable(config)
      
      if (available) {
        const success = await speakWithChatterbox(toSpeak, config)
        if (success) return
        // Fall through to OS TTS on failure
        console.error("[TTS] Chatterbox failed, falling back to OS TTS")
      } else {
        console.error("[TTS] Chatterbox not available, falling back to OS TTS")
      }
    }
    
    // OS TTS (fallback or explicit choice)
    await speakWithOS(toSpeak)
  }

  /**
   * Check if the session has completed (last assistant message is done)
   */
  function isSessionComplete(messages: any[]): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role === "assistant") {
        return !!(msg.info?.time as any)?.completed
      }
    }
    return false
  }

  /**
   * Skip judge/reflection sessions
   */
  function isJudgeSession(messages: any[]): boolean {
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text?.includes("TASK VERIFICATION")) {
          return true
        }
      }
    }
    return false
  }

  return {
    event: async ({ event }) => {
      // Check if TTS is enabled (re-reads config file each time)
      if (!(await isEnabled())) return

      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        if (!sessionId || typeof sessionId !== "string") return

        // Don't speak for same session twice
        if (spokenSessions.has(sessionId)) return

        try {
          const { data: messages } = await client.session.messages({ path: { id: sessionId } })
          if (!messages || messages.length < 2) return

          // Skip judge sessions
          if (isJudgeSession(messages)) return

          // Check if session is actually complete
          if (!isSessionComplete(messages)) return

          // Extract and speak the final response
          const finalResponse = extractFinalResponse(messages)
          if (finalResponse) {
            spokenSessions.add(sessionId)
            await speak(finalResponse)
          }
        } catch (error) {
          // Silently fail
        }
      }
    }
  }
}

export default TTSPlugin
