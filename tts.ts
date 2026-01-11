/**
 * TTS (Text-to-Speech) Plugin for OpenCode
 *
 * Reads the final answer aloud when the agent finishes.
 * Supports multiple TTS engines:
 *   - coqui: Coqui TTS - supports multiple models (bark, xtts_v2, tortoise, etc.)
 *   - chatterbox: High-quality neural TTS (auto-installed in virtualenv)
 *   - os: Native OS TTS (macOS `say` command)
 * 
 * Toggle TTS on/off:
 *   /tts       - toggle
 *   /tts on    - enable
 *   /tts off   - disable
 * 
 * Configure engine in ~/.config/opencode/tts.json:
 *   { "enabled": true, "engine": "coqui", "coqui": { "model": "bark" } }
 * 
 * Or set environment variables:
 *   TTS_DISABLED=1     - disable TTS
 *   TTS_ENGINE=coqui   - use Coqui TTS
 *   TTS_ENGINE=os      - use OS TTS
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

// Global speech lock - prevents multiple agents from speaking simultaneously
const SPEECH_LOCK_PATH = join(homedir(), ".config", "opencode", "speech.lock")
const SPEECH_LOCK_TIMEOUT = 120000  // Max speech duration (2 minutes)
const SPEECH_QUEUE_DIR = join(homedir(), ".config", "opencode", "speech-queue")

// Unique identifier for this process instance
const PROCESS_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`

// TTS Engine types
type TTSEngine = "coqui" | "chatterbox" | "os"

// Coqui TTS model types
type CoquiModel = "bark" | "xtts_v2" | "tortoise" | "vits" | "jenny"

interface TTSConfig {
  enabled?: boolean
  engine?: TTSEngine
  // OS TTS options (macOS/Linux)
  os?: {
    voice?: string                    // Voice name (e.g., "Samantha", "Alex"). Run `say -v ?` on macOS to list voices
    rate?: number                     // Speaking rate in words per minute (default: 200)
  }
  // Coqui TTS options (supports bark, xtts_v2, tortoise, vits, etc.)
  coqui?: {
    model?: CoquiModel                // Model to use: "bark", "xtts_v2", "tortoise", "vits" (default: "xtts_v2")
    device?: "cuda" | "cpu" | "mps"   // GPU, CPU, or Apple Silicon (default: auto-detect)
    // XTTS-specific options  
    voiceRef?: string                 // Path to reference voice clip for cloning (XTTS)
    language?: string                 // Language code for XTTS (default: "en")
    speaker?: string                  // Speaker name for XTTS (default: "Ana Florence")
    serverMode?: boolean              // Keep model loaded for fast subsequent requests (default: true)
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

// ==================== CHATTERBOX ====================

const CHATTERBOX_DIR = join(homedir(), ".config", "opencode", "chatterbox")
const CHATTERBOX_VENV = join(CHATTERBOX_DIR, "venv")
const CHATTERBOX_SCRIPT = join(CHATTERBOX_DIR, "tts.py")
const CHATTERBOX_SERVER_SCRIPT = join(CHATTERBOX_DIR, "tts_server.py")
const CHATTERBOX_SOCKET = join(CHATTERBOX_DIR, "tts.sock")
const CHATTERBOX_LOCK = join(CHATTERBOX_DIR, "server.lock")
const CHATTERBOX_PID = join(CHATTERBOX_DIR, "server.pid")

let chatterboxInstalled: boolean | null = null
let chatterboxSetupAttempted = false

// ==================== COQUI TTS ====================

const COQUI_DIR = join(homedir(), ".config", "opencode", "coqui")
const COQUI_VENV = join(COQUI_DIR, "venv")
const COQUI_SCRIPT = join(COQUI_DIR, "tts.py")
const COQUI_SERVER_SCRIPT = join(COQUI_DIR, "tts_server.py")
const COQUI_SOCKET = join(COQUI_DIR, "tts.sock")
const COQUI_LOCK = join(COQUI_DIR, "server.lock")
const COQUI_PID = join(COQUI_DIR, "server.pid")

let coquiInstalled: boolean | null = null
let coquiSetupAttempted = false

/**
 * Load TTS configuration from file
 */
async function loadConfig(): Promise<TTSConfig> {
  try {
    const content = await readFile(TTS_CONFIG_PATH, "utf-8")
    return JSON.parse(content)
  } catch {
    return { 
      enabled: true, 
      engine: "coqui",
      coqui: {
        model: "xtts_v2",
        device: "mps",
        language: "en",
        serverMode: true
      },
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
  if (process.env.TTS_ENGINE === "coqui") return "coqui"
  if (process.env.TTS_ENGINE === "chatterbox") return "chatterbox"
  const config = await loadConfig()
  return config.engine || "coqui"
}

// ==================== SPEECH LOCK (Cross-Process Queue) ====================

/**
 * Speech queue implementation using file-based locking.
 * Ensures multiple OpenCode sessions speak one at a time in FIFO order.
 * 
 * How it works:
 * 1. Each speech request creates a ticket file in SPEECH_QUEUE_DIR with timestamp
 * 2. Process waits until its ticket is the oldest (first in queue)
 * 3. Process acquires the lock, speaks, then releases lock and removes ticket
 * 4. Stale tickets (older than SPEECH_LOCK_TIMEOUT) are auto-cleaned
 */

interface SpeechTicket {
  processId: string
  timestamp: number
  sessionId: string
}

async function ensureQueueDir(): Promise<void> {
  try {
    await mkdir(SPEECH_QUEUE_DIR, { recursive: true })
  } catch {}
}

async function createSpeechTicket(sessionId: string): Promise<string> {
  await ensureQueueDir()
  const timestamp = Date.now()
  const ticketId = `${timestamp}-${PROCESS_ID}-${sessionId}`
  const ticketPath = join(SPEECH_QUEUE_DIR, `${ticketId}.ticket`)
  const ticket: SpeechTicket = {
    processId: PROCESS_ID,
    timestamp,
    sessionId
  }
  await writeFile(ticketPath, JSON.stringify(ticket))
  return ticketId
}

async function removeSpeechTicket(ticketId: string): Promise<void> {
  const ticketPath = join(SPEECH_QUEUE_DIR, `${ticketId}.ticket`)
  await unlink(ticketPath).catch(() => {})
}

async function getQueuedTickets(): Promise<{ id: string; ticket: SpeechTicket }[]> {
  await ensureQueueDir()
  const { readdir } = await import("fs/promises")
  try {
    const files = await readdir(SPEECH_QUEUE_DIR)
    const tickets: { id: string; ticket: SpeechTicket }[] = []
    
    for (const file of files) {
      if (!file.endsWith(".ticket")) continue
      const ticketId = file.replace(".ticket", "")
      const ticketPath = join(SPEECH_QUEUE_DIR, file)
      try {
        const content = await readFile(ticketPath, "utf-8")
        const ticket = JSON.parse(content) as SpeechTicket
        
        // Clean up stale tickets (older than timeout)
        if (Date.now() - ticket.timestamp > SPEECH_LOCK_TIMEOUT) {
          await unlink(ticketPath).catch(() => {})
          continue
        }
        
        tickets.push({ id: ticketId, ticket })
      } catch {
        // Invalid ticket, remove it
        await unlink(ticketPath).catch(() => {})
      }
    }
    
    // Sort by timestamp (FIFO)
    tickets.sort((a, b) => a.ticket.timestamp - b.ticket.timestamp)
    return tickets
  } catch {
    return []
  }
}

async function isMyTurn(ticketId: string): Promise<boolean> {
  const tickets = await getQueuedTickets()
  if (tickets.length === 0) return false
  return tickets[0].id === ticketId
}

async function acquireSpeechLock(ticketId: string): Promise<boolean> {
  // Only acquire lock if it's our turn in the queue
  if (!(await isMyTurn(ticketId))) {
    return false
  }
  
  const lockContent = JSON.stringify({
    processId: PROCESS_ID,
    ticketId,
    timestamp: Date.now()
  })
  
  try {
    const { open } = await import("fs/promises")
    const handle = await open(SPEECH_LOCK_PATH, "wx")
    await handle.writeFile(lockContent)
    await handle.close()
    return true
  } catch (e: any) {
    if (e.code === "EEXIST") {
      // Lock exists - check if it's stale
      try {
        const content = await readFile(SPEECH_LOCK_PATH, "utf-8")
        const lock = JSON.parse(content)
        if (Date.now() - lock.timestamp > SPEECH_LOCK_TIMEOUT) {
          // Stale lock, remove it and try again
          await unlink(SPEECH_LOCK_PATH).catch(() => {})
          return acquireSpeechLock(ticketId)
        }
      } catch {
        // Corrupted lock file, remove and retry
        await unlink(SPEECH_LOCK_PATH).catch(() => {})
        return acquireSpeechLock(ticketId)
      }
    }
    return false
  }
}

async function releaseSpeechLock(ticketId: string): Promise<void> {
  // Only release if we own the lock
  try {
    const content = await readFile(SPEECH_LOCK_PATH, "utf-8")
    const lock = JSON.parse(content)
    if (lock.processId === PROCESS_ID && lock.ticketId === ticketId) {
      await unlink(SPEECH_LOCK_PATH).catch(() => {})
    }
  } catch {
    // Lock doesn't exist or is corrupted, nothing to release
  }
}

async function waitForSpeechTurn(ticketId: string, timeoutMs: number = 180000): Promise<boolean> {
  const startTime = Date.now()
  
  while (Date.now() - startTime < timeoutMs) {
    // First wait for our turn in the queue
    if (await isMyTurn(ticketId)) {
      // Then try to acquire the lock
      if (await acquireSpeechLock(ticketId)) {
        return true
      }
    }
    // Wait before retrying
    await new Promise(r => setTimeout(r, 500))
  }
  
  // Timeout - remove our ticket and give up
  await removeSpeechTicket(ticketId)
  return false
}

// ==================== UTILITY FUNCTIONS ====================

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

async function findPython3(): Promise<string | null> {
  // Coqui TTS requires Python 3.9-3.11 (not 3.12+)
  const candidates = [
    "python3.11", "python3.10", "python3.9",
    "/opt/homebrew/bin/python3.11", "/opt/homebrew/bin/python3.10", "/opt/homebrew/bin/python3.9",
    "/usr/local/bin/python3.11", "/usr/local/bin/python3.10", "/usr/local/bin/python3.9"
  ]
  for (const py of candidates) {
    try {
      const { stdout } = await execAsync(`${py} --version 2>/dev/null`)
      if (stdout.includes("Python 3.11") || stdout.includes("Python 3.10") || stdout.includes("Python 3.9")) {
        return py
      }
    } catch {
      // Try next
    }
  }
  return null
}

// ==================== CHATTERBOX SETUP ====================

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
    
    await execAsync(`"${python}" -m venv "${CHATTERBOX_VENV}"`, { timeout: 60000 })
    
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

async function ensureChatterboxScript(): Promise<void> {
  const script = `#!/usr/bin/env python3
"""Chatterbox TTS helper script for OpenCode."""
import sys
import argparse

def main():
    parser = argparse.ArgumentParser(description="Chatterbox TTS")
    parser.add_argument("text", help="Text to synthesize")
    parser.add_argument("--output", "-o", required=True, help="Output WAV file")
    parser.add_argument("--device", default="cuda", choices=["cuda", "mps", "cpu"])
    parser.add_argument("--voice", help="Reference voice audio path")
    parser.add_argument("--exaggeration", type=float, default=0.5)
    parser.add_argument("--turbo", action="store_true", help="Use Turbo model")
    args = parser.parse_args()
    
    try:
        import torch
        import torchaudio as ta
        
        device = args.device
        if device == "cuda" and not torch.cuda.is_available():
            device = "mps" if torch.backends.mps.is_available() else "cpu"
        elif device == "mps" and not torch.backends.mps.is_available():
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

async function ensureChatterboxServerScript(): Promise<void> {
  const script = `#!/usr/bin/env python3
"""Chatterbox TTS Server for OpenCode."""
import sys
import os
import json
import socket
import argparse

def main():
    parser = argparse.ArgumentParser(description="Chatterbox TTS Server")
    parser.add_argument("--socket", required=True, help="Unix socket path")
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu", "mps"])
    parser.add_argument("--turbo", action="store_true", help="Use Turbo model")
    parser.add_argument("--voice", help="Default reference voice audio path")
    args = parser.parse_args()
    
    import torch
    import torchaudio as ta
    
    device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        if torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    
    print(f"Loading model on {device}...", file=sys.stderr)
    
    if args.turbo:
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        model = ChatterboxTurboTTS.from_pretrained(device=device)
    else:
        from chatterbox.tts import ChatterboxTTS
        model = ChatterboxTTS.from_pretrained(device=device)
    
    default_voice = args.voice
    
    if os.path.exists(args.socket):
        os.unlink(args.socket)
    
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

async function isChatterboxServerRunning(): Promise<boolean> {
  try {
    await access(CHATTERBOX_SOCKET)
    const net = await import("net")
    return new Promise((resolve) => {
      const client = net.createConnection(CHATTERBOX_SOCKET, () => {
        client.destroy()
        resolve(true)
      })
      client.on("error", () => resolve(false))
      setTimeout(() => {
        client.destroy()
        resolve(false)
      }, 1000)
    })
  } catch {
    return false
  }
}

async function acquireChatterboxLock(): Promise<boolean> {
  const lockContent = `${process.pid}\n${Date.now()}`
  try {
    const { open } = await import("fs/promises")
    const handle = await open(CHATTERBOX_LOCK, "wx")
    await handle.writeFile(lockContent)
    await handle.close()
    return true
  } catch (e: any) {
    if (e.code === "EEXIST") {
      try {
        const content = await readFile(CHATTERBOX_LOCK, "utf-8")
        const timestamp = parseInt(content.split("\n")[1] || "0", 10)
        if (Date.now() - timestamp > 120000) {
          await unlink(CHATTERBOX_LOCK)
          return acquireChatterboxLock()
        }
      } catch {
        await unlink(CHATTERBOX_LOCK).catch(() => {})
        return acquireChatterboxLock()
      }
    }
    return false
  }
}

async function releaseChatterboxLock(): Promise<void> {
  await unlink(CHATTERBOX_LOCK).catch(() => {})
}

async function startChatterboxServer(config: TTSConfig): Promise<boolean> {
  if (await isChatterboxServerRunning()) {
    return true
  }
  
  if (!(await acquireChatterboxLock())) {
    const startTime = Date.now()
    while (Date.now() - startTime < 120000) {
      await new Promise(r => setTimeout(r, 1000))
      if (await isChatterboxServerRunning()) {
        return true
      }
    }
    return false
  }
  
  try {
    if (await isChatterboxServerRunning()) {
      return true
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
    
    try {
      await unlink(CHATTERBOX_SOCKET)
    } catch {}
    
    const serverProcess = spawn(venvPython, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    
    if (serverProcess.pid) {
      await writeFile(CHATTERBOX_PID, String(serverProcess.pid))
    }
    
    serverProcess.unref()
    
    const startTime = Date.now()
    while (Date.now() - startTime < 120000) {
      if (await isChatterboxServerRunning()) {
        return true
      }
      await new Promise(r => setTimeout(r, 500))
    }
    
    return false
  } finally {
    await releaseChatterboxLock()
  }
}

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
    
    setTimeout(() => {
      client.destroy()
      resolve(false)
    }, 120000)
  })
}

async function isChatterboxAvailable(config: TTSConfig): Promise<boolean> {
  const installed = await setupChatterbox()
  if (!installed) return false
  
  const device = config.chatterbox?.device || "cuda"
  if (device === "cpu" || device === "mps") return true
  
  const venvPython = join(CHATTERBOX_VENV, "bin", "python")
  try {
    const { stdout } = await execAsync(`"${venvPython}" -c "import torch; print(torch.cuda.is_available())"`, { timeout: 30000 })
    return stdout.trim() === "True"
  } catch {
    return false
  }
}

async function speakWithChatterbox(text: string, config: TTSConfig): Promise<boolean> {
  const opts = config.chatterbox || {}
  const useServer = opts.serverMode !== false
  
  if (useServer) {
    const serverReady = await startChatterboxServer(config)
    if (serverReady) {
      const success = await speakWithChatterboxServer(text, config)
      if (success) return true
    }
  }
  
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

// ==================== COQUI TTS SETUP ====================

async function setupCoqui(): Promise<boolean> {
  if (coquiSetupAttempted) return coquiInstalled === true
  coquiSetupAttempted = true
  
  const python = await findPython3()
  if (!python) return false
  
  try {
    await mkdir(COQUI_DIR, { recursive: true })
    
    const venvPython = join(COQUI_VENV, "bin", "python")
    try {
      await access(venvPython)
      const { stdout } = await execAsync(`"${venvPython}" -c "from TTS.api import TTS; print('ok')"`, { timeout: 30000 })
      if (stdout.includes("ok")) {
        await ensureCoquiScript()
        coquiInstalled = true
        return true
      }
    } catch {
      // Need to create/setup venv
    }
    
    await execAsync(`"${python}" -m venv "${COQUI_VENV}"`, { timeout: 60000 })
    
    const pip = join(COQUI_VENV, "bin", "pip")
    await execAsync(`"${pip}" install --upgrade pip`, { timeout: 120000 })
    // Pin transformers<4.50 due to breaking API changes in 4.50+
    await execAsync(`"${pip}" install TTS "transformers<4.50"`, { timeout: 600000 })
    
    await ensureCoquiScript()
    coquiInstalled = true
    return true
  } catch {
    coquiInstalled = false
    return false
  }
}

async function ensureCoquiScript(): Promise<void> {
  const script = `#!/usr/bin/env python3
"""Coqui TTS helper script for OpenCode. Supports multiple models."""
import sys
import argparse

def main():
    parser = argparse.ArgumentParser(description="Coqui TTS")
    parser.add_argument("text", help="Text to synthesize")
    parser.add_argument("--output", "-o", required=True, help="Output WAV file")
    parser.add_argument("--model", default="xtts_v2", choices=["bark", "xtts_v2", "tortoise", "vits", "jenny"])
    parser.add_argument("--device", default="cuda", choices=["cuda", "mps", "cpu"])
    parser.add_argument("--voice-ref", help="Reference voice audio path (for XTTS voice cloning)")
    parser.add_argument("--language", default="en", help="Language code (for XTTS)")
    parser.add_argument("--speaker", default="Ana Florence", help="Speaker name for XTTS (e.g., 'Ana Florence', 'Claribel Dervla')")
    args = parser.parse_args()
    
    try:
        import torch
        
        # Workaround for PyTorch 2.6+ weights_only security change
        _original_load = torch.load
        def patched_load(*a, **kw):
            if 'weights_only' not in kw:
                kw['weights_only'] = False
            return _original_load(*a, **kw)
        torch.load = patched_load
        
        device = args.device
        if device == "cuda" and not torch.cuda.is_available():
            device = "mps" if torch.backends.mps.is_available() else "cpu"
        elif device == "mps" and not torch.backends.mps.is_available():
            device = "cpu"
        
        from TTS.api import TTS
        
        if args.model == "bark":
            # Bark: use random speaker
            tts = TTS("tts_models/multilingual/multi-dataset/bark")
            tts = tts.to(device)
            tts.tts_to_file(text=args.text, file_path=args.output)
        elif args.model == "xtts_v2":
            tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
            tts = tts.to(device)
            if args.voice_ref:
                tts.tts_to_file(
                    text=args.text,
                    file_path=args.output,
                    speaker_wav=args.voice_ref,
                    language=args.language
                )
            else:
                tts.tts_to_file(
                    text=args.text,
                    file_path=args.output,
                    speaker=args.speaker,
                    language=args.language
                )
        elif args.model == "tortoise":
            tts = TTS("tts_models/en/multi-dataset/tortoise-v2")
            tts = tts.to(device)
            tts.tts_to_file(text=args.text, file_path=args.output)
        elif args.model == "vits":
            tts = TTS("tts_models/en/ljspeech/vits")
            tts = tts.to(device)
            tts.tts_to_file(text=args.text, file_path=args.output)
        elif args.model == "jenny":
            tts = TTS("tts_models/en/jenny/jenny")
            tts = tts.to(device)
            tts.tts_to_file(text=args.text, file_path=args.output)
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
`
  await writeFile(COQUI_SCRIPT, script, { mode: 0o755 })
}

async function ensureCoquiServerScript(): Promise<void> {
  const script = `#!/usr/bin/env python3
"""Coqui TTS Server for OpenCode. Keeps model loaded for fast inference."""
import sys
import os
import json
import socket
import argparse

def main():
    parser = argparse.ArgumentParser(description="Coqui TTS Server")
    parser.add_argument("--socket", required=True, help="Unix socket path")
    parser.add_argument("--model", default="xtts_v2", choices=["bark", "xtts_v2", "tortoise", "vits", "jenny"])
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu", "mps"])
    parser.add_argument("--voice-ref", help="Default reference voice (for XTTS)")
    parser.add_argument("--speaker", default="Ana Florence", help="Default XTTS speaker")
    parser.add_argument("--language", default="en", help="Default language")
    args = parser.parse_args()
    
    import torch
    
    # Workaround for PyTorch 2.6+ weights_only security change
    _original_load = torch.load
    def patched_load(*a, **kw):
        if 'weights_only' not in kw:
            kw['weights_only'] = False
        return _original_load(*a, **kw)
    torch.load = patched_load
    
    device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        if torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    
    print(f"Loading Coqui TTS model '{args.model}' on {device}...", file=sys.stderr)
    
    from TTS.api import TTS
    
    if args.model == "bark":
        tts = TTS("tts_models/multilingual/multi-dataset/bark")
    elif args.model == "xtts_v2":
        tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
    elif args.model == "tortoise":
        tts = TTS("tts_models/en/multi-dataset/tortoise-v2")
    elif args.model == "vits":
        tts = TTS("tts_models/en/ljspeech/vits")
    elif args.model == "jenny":
        tts = TTS("tts_models/en/jenny/jenny")
    
    tts = tts.to(device)
    print(f"Model loaded on {device}", file=sys.stderr)
    
    if os.path.exists(args.socket):
        os.unlink(args.socket)
    
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
            voice_ref = request.get("voice_ref") or args.voice_ref
            speaker = request.get("speaker") or args.speaker
            language = request.get("language") or args.language
            
            if args.model == "bark":
                tts.tts_to_file(text=text, file_path=output)
            elif args.model == "xtts_v2":
                if voice_ref:
                    tts.tts_to_file(text=text, file_path=output, speaker_wav=voice_ref, language=language)
                else:
                    tts.tts_to_file(text=text, file_path=output, speaker=speaker, language=language)
            else:
                tts.tts_to_file(text=text, file_path=output)
            
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
  await writeFile(COQUI_SERVER_SCRIPT, script, { mode: 0o755 })
}

async function isCoquiServerRunning(): Promise<boolean> {
  try {
    await access(COQUI_SOCKET)
    const net = await import("net")
    return new Promise((resolve) => {
      const client = net.createConnection(COQUI_SOCKET, () => {
        client.destroy()
        resolve(true)
      })
      client.on("error", () => resolve(false))
      setTimeout(() => {
        client.destroy()
        resolve(false)
      }, 1000)
    })
  } catch {
    return false
  }
}

async function acquireCoquiLock(): Promise<boolean> {
  const lockContent = `${process.pid}\n${Date.now()}`
  try {
    const { open } = await import("fs/promises")
    const handle = await open(COQUI_LOCK, "wx")
    await handle.writeFile(lockContent)
    await handle.close()
    return true
  } catch (e: any) {
    if (e.code === "EEXIST") {
      try {
        const content = await readFile(COQUI_LOCK, "utf-8")
        const timestamp = parseInt(content.split("\n")[1] || "0", 10)
        if (Date.now() - timestamp > 120000) {
          await unlink(COQUI_LOCK)
          return acquireCoquiLock()
        }
      } catch {
        await unlink(COQUI_LOCK).catch(() => {})
        return acquireCoquiLock()
      }
    }
    return false
  }
}

async function releaseCoquiLock(): Promise<void> {
  await unlink(COQUI_LOCK).catch(() => {})
}

async function startCoquiServer(config: TTSConfig): Promise<boolean> {
  if (await isCoquiServerRunning()) {
    return true
  }
  
  if (!(await acquireCoquiLock())) {
    const startTime = Date.now()
    while (Date.now() - startTime < 120000) {
      await new Promise(r => setTimeout(r, 1000))
      if (await isCoquiServerRunning()) {
        return true
      }
    }
    return false
  }
  
  try {
    if (await isCoquiServerRunning()) {
      return true
    }
    
    await ensureCoquiServerScript()
    
    const venvPython = join(COQUI_VENV, "bin", "python")
    const opts = config.coqui || {}
    const device = opts.device || "cuda"
    const model = opts.model || "xtts_v2"
    
    const args = [
      COQUI_SERVER_SCRIPT,
      "--socket", COQUI_SOCKET,
      "--model", model,
      "--device", device,
    ]
    
    if (opts.voiceRef) {
      args.push("--voice-ref", opts.voiceRef)
    }
    
    if (opts.speaker) {
      args.push("--speaker", opts.speaker)
    }
    
    if (opts.language) {
      args.push("--language", opts.language)
    }
    
    try {
      await unlink(COQUI_SOCKET)
    } catch {}
    
    const serverProcess = spawn(venvPython, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    
    if (serverProcess.pid) {
      await writeFile(COQUI_PID, String(serverProcess.pid))
    }
    
    serverProcess.unref()
    
    const startTime = Date.now()
    while (Date.now() - startTime < 180000) {  // 3 minutes for model download
      if (await isCoquiServerRunning()) {
        return true
      }
      await new Promise(r => setTimeout(r, 500))
    }
    
    return false
  } finally {
    await releaseCoquiLock()
  }
}

async function speakWithCoquiServer(text: string, config: TTSConfig): Promise<boolean> {
  const net = await import("net")
  const opts = config.coqui || {}
  const outputPath = join(tmpdir(), `opencode_coqui_${Date.now()}.wav`)
  
  return new Promise((resolve) => {
    const client = net.createConnection(COQUI_SOCKET, () => {
      const request = JSON.stringify({
        text,
        output: outputPath,
        voice_ref: opts.voiceRef,
        speaker: opts.speaker,
        language: opts.language || "en",
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
    
    setTimeout(() => {
      client.destroy()
      resolve(false)
    }, 120000)
  })
}

async function isCoquiAvailable(config: TTSConfig): Promise<boolean> {
  const installed = await setupCoqui()
  if (!installed) return false
  
  const device = config.coqui?.device || "cuda"
  if (device === "cpu" || device === "mps") return true
  
  const venvPython = join(COQUI_VENV, "bin", "python")
  try {
    const { stdout } = await execAsync(`"${venvPython}" -c "import torch; print(torch.cuda.is_available())"`, { timeout: 30000 })
    return stdout.trim() === "True"
  } catch {
    return false
  }
}

async function speakWithCoqui(text: string, config: TTSConfig): Promise<boolean> {
  const opts = config.coqui || {}
  const useServer = opts.serverMode !== false
  
  if (useServer) {
    const serverReady = await startCoquiServer(config)
    if (serverReady) {
      const success = await speakWithCoquiServer(text, config)
      if (success) return true
    }
  }
  
  // One-shot mode
  const venvPython = join(COQUI_VENV, "bin", "python")
  const device = opts.device || "cuda"
  const model = opts.model || "xtts_v2"
  const outputPath = join(tmpdir(), `opencode_coqui_${Date.now()}.wav`)
  
  const args = [
    COQUI_SCRIPT,
    "--output", outputPath,
    "--model", model,
    "--device", device,
  ]
  
  if (opts.voiceRef) {
    args.push("--voice-ref", opts.voiceRef)
  }
  
  if (opts.speaker) {
    args.push("--speaker", opts.speaker)
  }
  
  if (opts.language) {
    args.push("--language", opts.language)
  }
  
  args.push(text)
  
  return new Promise((resolve) => {
    const proc = spawn(venvPython, args)
    
    const timeout = device === "cpu" ? 300000 : 180000
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

// ==================== OS TTS ====================

async function speakWithOS(text: string, config: TTSConfig): Promise<boolean> {
  const escaped = text.replace(/'/g, "'\\''")
  const opts = config.os || {}
  const voice = opts.voice || "Samantha"
  const rate = opts.rate || 200
  
  try {
    if (platform() === "darwin") {
      await execAsync(`say -v "${voice}" -r ${rate} '${escaped}'`)
    } else {
      await execAsync(`espeak '${escaped}'`)
    }
    return true
  } catch {
    return false
  }
}

// ==================== PLUGIN ====================

export const TTSPlugin: Plugin = async ({ client, directory }) => {
  // Directory for storing TTS output data
  const ttsDir = join(directory, ".tts")

  async function ensureTTSDir(): Promise<void> {
    try {
      await mkdir(ttsDir, { recursive: true })
    } catch {}
  }

  async function saveTTSData(sessionId: string, data: {
    originalText: string
    cleanedText: string
    spokenText: string
    engine: string
    timestamp: string
  }): Promise<void> {
    await ensureTTSDir()
    const filename = `${sessionId.slice(0, 8)}_${Date.now()}.json`
    const filepath = join(ttsDir, filename)
    try {
      await writeFile(filepath, JSON.stringify(data, null, 2))
    } catch {}
  }

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

  async function speak(text: string, sessionId: string): Promise<void> {
    const cleaned = cleanTextForSpeech(text)
    if (!cleaned) return

    const toSpeak = cleaned.length > MAX_SPEECH_LENGTH
      ? cleaned.slice(0, MAX_SPEECH_LENGTH) + "... message truncated."
      : cleaned

    // Create a ticket and wait for our turn in the speech queue
    const ticketId = await createSpeechTicket(sessionId)
    const gotTurn = await waitForSpeechTurn(ticketId, 180000) // 3 min timeout
    if (!gotTurn) {
      await debugLog(`Failed to acquire speech turn for ${sessionId}`)
      return
    }

    try {
      const config = await loadConfig()
      const engine = await getEngine()
      
      // Save TTS data to .tts/ directory
      await saveTTSData(sessionId, {
        originalText: text,
        cleanedText: cleaned,
        spokenText: toSpeak,
        engine,
        timestamp: new Date().toISOString()
      })
      
      if (engine === "coqui") {
        const available = await isCoquiAvailable(config)
        if (available) {
          const success = await speakWithCoqui(toSpeak, config)
          if (success) {
            return
          }
        }
      }
      
      if (engine === "chatterbox") {
        const available = await isChatterboxAvailable(config)
        if (available) {
          const success = await speakWithChatterbox(toSpeak, config)
          if (success) {
            return
          }
        }
      }
      
      // OS TTS (fallback or explicit choice)
      await speakWithOS(toSpeak, config)
    } finally {
      await releaseSpeechLock(ticketId)
      await removeSpeechTicket(ticketId)
    }
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

  // Debug log file for TTS diagnostics
  const debugLogPath = join(directory, ".tts-debug.log")
  
  async function debugLog(msg: string): Promise<void> {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] ${msg}\n`
    try {
      const { appendFile } = await import("fs/promises")
      await appendFile(debugLogPath, line)
    } catch {}
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        await debugLog(`session.idle fired for ${sessionId}`)
        
        const enabled = await isEnabled()
        if (!enabled) {
          await debugLog(`TTS disabled, skipping`)
          return
        }

        if (!sessionId || typeof sessionId !== "string") {
          await debugLog(`Invalid sessionId: ${sessionId}`)
          return
        }

        if (spokenSessions.has(sessionId)) {
          await debugLog(`Already spoken for ${sessionId}`)
          return
        }

        try {
          const { data: messages } = await client.session.messages({ path: { id: sessionId } })
          await debugLog(`Got ${messages?.length || 0} messages`)
          
          if (!messages || messages.length < 2) {
            await debugLog(`Not enough messages, skipping`)
            return
          }
          
          if (isJudgeSession(messages)) {
            await debugLog(`Judge session detected, skipping`)
            return
          }
          
          const complete = isSessionComplete(messages)
          await debugLog(`Session complete: ${complete}`)
          
          // Log the last assistant message structure for debugging
          const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
          if (lastAssistant) {
            await debugLog(`Last assistant msg.info: ${JSON.stringify(lastAssistant.info || {})}`)
          }
          
          if (!complete) {
            await debugLog(`Session not complete, skipping`)
            return
          }

          const finalResponse = extractFinalResponse(messages)
          await debugLog(`Final response length: ${finalResponse?.length || 0}`)
          
          if (finalResponse) {
            spokenSessions.add(sessionId)
            await debugLog(`Speaking now...`)
            await speak(finalResponse, sessionId)
            await debugLog(`Speech complete`)
          }
        } catch (e: any) {
          await debugLog(`Error: ${e?.message || e}`)
        }
      }
    }
  }
}

export default TTSPlugin
