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
  // OS TTS options (macOS/Linux)
  os?: {
    voice?: string                    // Voice name (e.g., "Samantha", "Alex"). Run `say -v ?` on macOS to list voices
    rate?: number                     // Speaking rate in words per minute (default: 200)
  }
  // Chatterbox-specific options
  chatterbox?: {
    device?: "cuda" | "cpu" | "mps"   // GPU, CPU, or Apple Silicon (default: auto-detect)
    voiceRef?: string                 // Path to reference voice clip for cloning (REQUIRED for custom voice)
    exaggeration?: number             // Emotion exaggeration (0.0-1.0)
    useTurbo?: boolean                // Use Turbo model for 10x faster inference
    serverMode?: boolean              // Keep model loaded for fast subsequent requests (default: true)
  }
}

// Cache for chatterbox setup check (not availability - that depends on config)
let chatterboxInstalled: boolean | null = null
let chatterboxSetupAttempted = false

/**
 * Load TTS configuration from file
 */
async function loadConfig(): Promise<TTSConfig> {
  try {
    const content = await readFile(TTS_CONFIG_PATH, "utf-8")
    return JSON.parse(content)
  } catch {
    // Default config - use OS TTS with Samantha voice (female, macOS)
    return { 
      enabled: true, 
      engine: "os",
      os: {
        voice: "Samantha",
        rate: 200
      }
    }
  }
}

/**
 * Check if TTS is enabled
 */
async function isEnabled(): Promise<boolean> {
  if (process.env.TTS_DISABLED === "1") return false
  const config = await loadConfig()
  return config.enabled !== false
}

/**
 * Get the TTS engine to use
 */
async function getEngine(): Promise<TTSEngine> {
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
      if (stdout.includes("3.11")) return py
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
  const venvPython = join(CHATTERBOX_VENV, "bin", "python")
  try {
    const { stdout } = await execAsync(`"${venvPython}" -c "import torch; print(torch.cuda.is_available())"`, { timeout: 30000 })
    return stdout.trim() === "True"
  } catch {
    return false
  }
}

/**
 * Setup Chatterbox virtual environment and install dependencies
 */
async function setupChatterbox(): Promise<boolean> {
  if (chatterboxSetupAttempted) return chatterboxInstalled === true
  chatterboxSetupAttempted = true
  
  const python = await findPython311()
  if (!python) return false
  
  try {
    await mkdir(CHATTERBOX_DIR, { recursive: true })
    
    const venvPython = join(CHATTERBOX_VENV, "bin", "python")
    try {
      await access(venvPython)
      const { stdout } = await execAsync(`"${venvPython}" -c "import chatterbox; print('ok')"`, { timeout: 10000 })
      if (stdout.includes("ok")) {
        await ensureChatterboxScript()
        chatterboxInstalled = true
        return true
      }
    } catch {
      // Need to create/setup venv
    }
    
    // Create venv
    await execAsync(`"${python}" -m venv "${CHATTERBOX_VENV}"`, { timeout: 60000 })
    
    // Install chatterbox-tts
    const pip = join(CHATTERBOX_VENV, "bin", "pip")
    await execAsync(`"${pip}" install --upgrade pip`, { timeout: 120000 })
    await execAsync(`"${pip}" install chatterbox-tts`, { timeout: 600000 })
    
    await ensureChatterboxScript()
    chatterboxInstalled = true
    return true
  } catch {
    chatterboxInstalled = false
    return false
  }
}

// Chatterbox server state
const CHATTERBOX_SERVER_SCRIPT = join(CHATTERBOX_DIR, "tts_server.py")
const CHATTERBOX_SOCKET = join(CHATTERBOX_DIR, "tts.sock")
let chatterboxServerProcess: ReturnType<typeof spawn> | null = null

/**
 * Ensure the Chatterbox Python helper script exists (one-shot mode)
 */
async function ensureChatterboxScript(): Promise<void> {
  const script = `#!/usr/bin/env python3
"""Chatterbox TTS helper script for OpenCode (one-shot mode)."""
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
        
        device = args.device
        if device == "cuda" and not torch.cuda.is_available():
            device = "cpu"
        
        if args.turbo:
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            model = ChatterboxTurboTTS.from_pretrained(device=device)
        else:
            from chatterbox.tts import ChatterboxTTS
            model = ChatterboxTTS.from_pretrained(device=device)
        
        if args.voice:
            wav = model.generate(args.text, audio_prompt_path=args.voice, exaggeration=args.exaggeration)
        else:
            wav = model.generate(args.text, exaggeration=args.exaggeration)
        
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
 * Ensure the Chatterbox TTS server script exists (persistent mode - keeps model loaded)
 */
async function ensureChatterboxServerScript(): Promise<void> {
  const script = `#!/usr/bin/env python3
"""
Chatterbox TTS Server for OpenCode.
Keeps model loaded in memory for fast inference.
Communicates via Unix socket for low latency.
"""
import sys
import os
import json
import socket
import argparse

def main():
    parser = argparse.ArgumentParser(description="Chatterbox TTS Server")
    parser.add_argument("--socket", required=True, help="Unix socket path")
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu", "mps"])
    parser.add_argument("--turbo", action="store_true", help="Use Turbo model (10x faster)")
    parser.add_argument("--voice", help="Default reference voice audio path")
    args = parser.parse_args()
    
    import torch
    import torchaudio as ta
    
    # Auto-detect best device
    device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        if torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    
    print(f"Loading model on {device}...", file=sys.stderr)
    
    # Load model once at startup
    if args.turbo:
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        model = ChatterboxTurboTTS.from_pretrained(device=device)
        print("Turbo model loaded (10x faster inference)", file=sys.stderr)
    else:
        from chatterbox.tts import ChatterboxTTS
        model = ChatterboxTTS.from_pretrained(device=device)
        print("Standard model loaded", file=sys.stderr)
    
    default_voice = args.voice
    
    # Remove old socket if exists
    if os.path.exists(args.socket):
        os.unlink(args.socket)
    
    # Create Unix socket server
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(args.socket)
    server.listen(1)
    os.chmod(args.socket, 0o600)
    
    print(f"TTS server ready on {args.socket}", file=sys.stderr)
    sys.stderr.flush()
    
    while True:
        try:
            conn, _ = server.accept()
            data = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
                if b"\\n" in data:
                    break
            
            request = json.loads(data.decode().strip())
            text = request.get("text", "")
            output = request.get("output", "/tmp/tts_output.wav")
            voice = request.get("voice") or default_voice
            exaggeration = request.get("exaggeration", 0.5)
            
            # Generate speech
            if voice:
                wav = model.generate(text, audio_prompt_path=voice, exaggeration=exaggeration)
            else:
                wav = model.generate(text, exaggeration=exaggeration)
            
            ta.save(output, wav, model.sr)
            
            conn.sendall(json.dumps({"success": True, "output": output}).encode() + b"\\n")
            conn.close()
        except Exception as e:
            try:
                conn.sendall(json.dumps({"success": False, "error": str(e)}).encode() + b"\\n")
                conn.close()
            except:
                pass

if __name__ == "__main__":
    main()
`
  await writeFile(CHATTERBOX_SERVER_SCRIPT, script, { mode: 0o755 })
}

/**
 * Start the Chatterbox TTS server (keeps model loaded for fast inference)
 */
async function startChatterboxServer(config: TTSConfig): Promise<boolean> {
  if (chatterboxServerProcess) {
    // Check if still running
    try {
      await access(CHATTERBOX_SOCKET)
      return true
    } catch {
      // Socket gone, restart server
      chatterboxServerProcess.kill()
      chatterboxServerProcess = null
    }
  }
  
  await ensureChatterboxServerScript()
  
  const venvPython = join(CHATTERBOX_VENV, "bin", "python")
  const opts = config.chatterbox || {}
  const device = opts.device || "cuda"
  
  const args = [
    CHATTERBOX_SERVER_SCRIPT,
    "--socket", CHATTERBOX_SOCKET,
    "--device", device,
  ]
  
  if (opts.useTurbo) {
    args.push("--turbo")
  }
  
  if (opts.voiceRef) {
    args.push("--voice", opts.voiceRef)
  }
  
  // Remove old socket
  try {
    await unlink(CHATTERBOX_SOCKET)
  } catch {}
  
  chatterboxServerProcess = spawn(venvPython, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  })
  
  // Wait for server to be ready (up to 60s for model loading)
  const startTime = Date.now()
  while (Date.now() - startTime < 60000) {
    try {
      await access(CHATTERBOX_SOCKET)
      return true
    } catch {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  
  return false
}

/**
 * Send TTS request to the running server (fast path)
 */
async function speakWithChatterboxServer(text: string, config: TTSConfig): Promise<boolean> {
  const net = await import("net")
  const opts = config.chatterbox || {}
  const outputPath = join(tmpdir(), `opencode_tts_${Date.now()}.wav`)
  
  return new Promise((resolve) => {
    const client = net.createConnection(CHATTERBOX_SOCKET, () => {
      const request = JSON.stringify({
        text,
        output: outputPath,
        voice: opts.voiceRef,
        exaggeration: opts.exaggeration ?? 0.5,
      }) + "\n"
      client.write(request)
    })
    
    let response = ""
    client.on("data", (data) => {
      response += data.toString()
    })
    
    client.on("end", async () => {
      try {
        const result = JSON.parse(response.trim())
        if (!result.success) {
          resolve(false)
          return
        }
        
        // Play audio
        if (platform() === "darwin") {
          await execAsync(`afplay "${outputPath}"`)
        } else {
          try {
            await execAsync(`paplay "${outputPath}"`)
          } catch {
            await execAsync(`aplay "${outputPath}"`)
          }
        }
        await unlink(outputPath).catch(() => {})
        resolve(true)
      } catch {
        resolve(false)
      }
    })
    
    client.on("error", () => {
      resolve(false)
    })
    
    // Timeout
    setTimeout(() => {
      client.destroy()
      resolve(false)
    }, 120000)
  })
}

/**
 * Check if Chatterbox is available for use
 */
async function isChatterboxAvailable(config: TTSConfig): Promise<boolean> {
  const installed = await setupChatterbox()
  if (!installed) return false
  
  const hasGpu = await checkCudaAvailable()
  const forceCpu = config.chatterbox?.device === "cpu"
  
  // Use Chatterbox if we have GPU or CPU is explicitly requested
  return hasGpu || forceCpu
}

/**
 * Speak using Chatterbox TTS
 */
async function speakWithChatterbox(text: string, config: TTSConfig): Promise<boolean> {
  const opts = config.chatterbox || {}
  const useServer = opts.serverMode !== false  // Default to server mode for speed
  
  // Try server mode first (fast path - model stays loaded)
  if (useServer) {
    const serverReady = await startChatterboxServer(config)
    if (serverReady) {
      const success = await speakWithChatterboxServer(text, config)
      if (success) return true
      // Server failed, fall through to one-shot mode
    }
  }
  
  // One-shot mode (slower - reloads model each time)
  const venvPython = join(CHATTERBOX_VENV, "bin", "python")
  const device = opts.device || "cuda"
  const outputPath = join(tmpdir(), `opencode_tts_${Date.now()}.wav`)
  
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
    const proc = spawn(venvPython, args)
    
    // Set timeout for CPU mode (can take 3+ minutes)
    const timeout = device === "cpu" ? 300000 : 120000
    const timer = setTimeout(() => {
      proc.kill()
      resolve(false)
    }, timeout)
    
    proc.on("close", async (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve(false)
        return
      }
      
      try {
        if (platform() === "darwin") {
          await execAsync(`afplay "${outputPath}"`)
        } else {
          try {
            await execAsync(`paplay "${outputPath}"`)
          } catch {
            await execAsync(`aplay "${outputPath}"`)
          }
        }
        await unlink(outputPath).catch(() => {})
        resolve(true)
      } catch {
        await unlink(outputPath).catch(() => {})
        resolve(false)
      }
    })
    
    proc.on("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/**
 * Speak using OS TTS (macOS `say` command, Linux espeak)
 */
async function speakWithOS(text: string, config: TTSConfig): Promise<boolean> {
  const escaped = text.replace(/'/g, "'\\''")
  const opts = config.os || {}
  const voice = opts.voice || "Samantha"  // Female voice by default
  const rate = opts.rate || 200
  
  try {
    if (platform() === "darwin") {
      await execAsync(`say -v "${voice}" -r ${rate} '${escaped}'`)
    } else {
      // Linux: espeak
      await execAsync(`espeak '${escaped}'`)
    }
    return true
  } catch {
    return false
  }
}

export const TTSPlugin: Plugin = async ({ client, directory }) => {
  function extractFinalResponse(messages: any[]): string | null {
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

  async function speak(text: string): Promise<void> {
    const cleaned = cleanTextForSpeech(text)
    if (!cleaned) return

    const toSpeak = cleaned.length > MAX_SPEECH_LENGTH
      ? cleaned.slice(0, MAX_SPEECH_LENGTH) + "... message truncated."
      : cleaned

    const config = await loadConfig()
    const engine = await getEngine()
    
    if (engine === "chatterbox") {
      const available = await isChatterboxAvailable(config)
      if (available) {
        const success = await speakWithChatterbox(toSpeak, config)
        if (success) return
      }
    }
    
    // OS TTS (fallback or explicit choice)
    await speakWithOS(toSpeak, config)
  }

  function isSessionComplete(messages: any[]): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.info?.role === "assistant") {
        return !!(msg.info?.time as any)?.completed
      }
    }
    return false
  }

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
      if (!(await isEnabled())) return

      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        if (!sessionId || typeof sessionId !== "string") return

        if (spokenSessions.has(sessionId)) return

        try {
          const { data: messages } = await client.session.messages({ path: { id: sessionId } })
          if (!messages || messages.length < 2) return
          if (isJudgeSession(messages)) return
          if (!isSessionComplete(messages)) return

          const finalResponse = extractFinalResponse(messages)
          if (finalResponse) {
            spokenSessions.add(sessionId)
            await speak(finalResponse)
          }
        } catch {
          // Silently fail
        }
      }
    }
  }
}

export default TTSPlugin
