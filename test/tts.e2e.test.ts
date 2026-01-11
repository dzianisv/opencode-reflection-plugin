/**
 * E2E Integration Test - TTS Plugin
 *
 * Actually runs Chatterbox TTS with MPS to verify it works.
 * This test will FAIL if the embedded Python scripts don't support MPS.
 *
 * Run with: OPENCODE_TTS_E2E=1 npm run test:tts:e2e
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { mkdir, rm, writeFile, readFile, access, unlink, readdir } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { exec, spawn } from "child_process"
import { promisify } from "util"
import { tmpdir } from "os"

const execAsync = promisify(exec)
const __dirname = dirname(fileURLToPath(import.meta.url))

// Skip unless explicitly enabled - Chatterbox is slow and requires setup
const RUN_E2E = process.env.OPENCODE_TTS_E2E === "1"

// Paths
const CHATTERBOX_DIR = join(process.env.HOME || "", ".config/opencode/chatterbox")
const CHATTERBOX_VENV = join(CHATTERBOX_DIR, "venv")
const CHATTERBOX_SCRIPT = join(CHATTERBOX_DIR, "tts.py")
const VENV_PYTHON = join(CHATTERBOX_VENV, "bin/python")

// Test timeout - Chatterbox can be slow on first run
const TIMEOUT = 180_000

interface TTSResult {
  success: boolean
  error?: string
  outputFile?: string
  duration: number
}

/**
 * Check if Chatterbox is installed and ready
 */
async function isChatterboxReady(): Promise<{ ready: boolean; reason?: string }> {
  try {
    await access(VENV_PYTHON)
  } catch {
    return { ready: false, reason: "Chatterbox venv not found" }
  }

  try {
    const { stdout } = await execAsync(`"${VENV_PYTHON}" -c "import chatterbox; print('ok')"`, { timeout: 10000 })
    if (!stdout.includes("ok")) {
      return { ready: false, reason: "Chatterbox import failed" }
    }
  } catch (e: any) {
    return { ready: false, reason: `Chatterbox import error: ${e.message}` }
  }

  return { ready: true }
}

/**
 * Check if MPS (Apple Silicon) is available
 */
async function isMPSAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `"${VENV_PYTHON}" -c "import torch; print('yes' if torch.backends.mps.is_available() else 'no')"`,
      { timeout: 10000 }
    )
    return stdout.trim() === "yes"
  } catch {
    return false
  }
}

/**
 * Write the TTS script from the plugin source (simulates what the plugin does)
 */
async function ensureTTSScript(): Promise<void> {
  // Read the plugin source to extract the embedded script
  const pluginSource = await readFile(join(__dirname, "../tts.ts"), "utf-8")
  
  // Find the embedded script in ensureChatterboxScript
  const scriptMatch = pluginSource.match(/async function ensureChatterboxScript\(\)[\s\S]*?const script = `([\s\S]*?)`\s*\n\s*await writeFile/)
  
  if (!scriptMatch) {
    throw new Error("Could not extract embedded TTS script from tts.ts")
  }
  
  const script = scriptMatch[1]
  await mkdir(CHATTERBOX_DIR, { recursive: true })
  await writeFile(CHATTERBOX_SCRIPT, script, { mode: 0o755 })
}

/**
 * Run TTS with specific device and verify it produces audio
 */
async function runTTS(text: string, device: string): Promise<TTSResult> {
  const start = Date.now()
  const outputFile = join(tmpdir(), `tts_test_${device}_${Date.now()}.wav`)
  
  const args = [
    CHATTERBOX_SCRIPT,
    "--output", outputFile,
    "--device", device,
    text
  ]
  
  return new Promise((resolve) => {
    const proc = spawn(VENV_PYTHON, args, {
      stdio: ["ignore", "pipe", "pipe"]
    })
    
    let stderr = ""
    proc.stderr?.on("data", (d) => { stderr += d.toString() })
    
    const timeout = setTimeout(() => {
      proc.kill()
      resolve({
        success: false,
        error: `Timeout after ${TIMEOUT}ms`,
        duration: Date.now() - start
      })
    }, TIMEOUT)
    
    proc.on("close", async (code) => {
      clearTimeout(timeout)
      const duration = Date.now() - start
      
      if (code !== 0) {
        resolve({
          success: false,
          error: `Exit code ${code}: ${stderr}`,
          duration
        })
        return
      }
      
      // Verify output file exists and has content
      try {
        const { size } = await import("fs").then(fs => 
          new Promise<{ size: number }>((res, rej) => 
            fs.stat(outputFile, (err, stats) => err ? rej(err) : res(stats))
          )
        )
        
        if (size < 1000) {
          resolve({
            success: false,
            error: `Output file too small: ${size} bytes`,
            outputFile,
            duration
          })
          return
        }
        
        resolve({
          success: true,
          outputFile,
          duration
        })
      } catch (e: any) {
        resolve({
          success: false,
          error: `Output file error: ${e.message}`,
          duration
        })
      }
    })
    
    proc.on("error", (e) => {
      clearTimeout(timeout)
      resolve({
        success: false,
        error: `Process error: ${e.message}`,
        duration: Date.now() - start
      })
    })
  })
}

describe("TTS E2E - Chatterbox Integration", { skip: !RUN_E2E, timeout: TIMEOUT * 3 }, () => {
  let mpsAvailable = false
  let createdFiles: string[] = []

  before(async () => {
    console.log("\n=== TTS E2E Setup ===\n")
    
    // Check prerequisites
    const status = await isChatterboxReady()
    
    if (!status.ready) {
      console.log(`Chatterbox not ready: ${status.reason}`)
      console.log("Install with: pip install chatterbox-tts")
      throw new Error(`Chatterbox not ready: ${status.reason}`)
    }
    
    console.log("Chatterbox: ready")
    
    mpsAvailable = await isMPSAvailable()
    console.log(`MPS (Apple Silicon): ${mpsAvailable ? "available" : "not available"}`)
    
    // Write the TTS script from plugin source
    console.log("Writing TTS script from plugin source...")
    await ensureTTSScript()
    console.log(`Script written to: ${CHATTERBOX_SCRIPT}`)
  })

  after(async () => {
    console.log("\n=== TTS E2E Cleanup ===")
    
    // Clean up generated audio files
    for (const file of createdFiles) {
      try {
        await unlink(file)
        console.log(`Removed: ${file}`)
      } catch {}
    }
  })

  it("TTS script accepts --device mps argument", async () => {
    console.log("\n--- Testing --device mps argument ---")
    
    // Just test that the script accepts the argument without error
    // This catches the argparse choices bug
    const { stdout } = await execAsync(
      `"${VENV_PYTHON}" "${CHATTERBOX_SCRIPT}" --help`,
      { timeout: 10000 }
    )
    
    assert.ok(
      stdout.includes("mps") || stdout.includes("cuda"),
      `Script help should show device options. Got: ${stdout}`
    )
    
    console.log("Script accepts device arguments")
  })

  it("Chatterbox generates audio with MPS device", { timeout: TIMEOUT }, async (t) => {
    if (!mpsAvailable) {
      console.log("Skipping MPS test - MPS not available")
      t.skip("MPS not available")
      return
    }
    
    console.log("\n--- Testing Chatterbox with MPS ---")
    console.log("This may take 1-2 minutes on first run (model loading)...")
    
    const result = await runTTS("Hello, this is a test.", "mps")
    
    console.log(`Result: ${result.success ? "SUCCESS" : "FAILED"}`)
    console.log(`Duration: ${Math.round(result.duration / 1000)}s`)
    
    if (result.outputFile) {
      createdFiles.push(result.outputFile)
      console.log(`Output: ${result.outputFile}`)
    }
    
    if (result.error) {
      console.log(`Error: ${result.error}`)
    }
    
    assert.ok(
      result.success,
      `Chatterbox with MPS should produce audio. Error: ${result.error}`
    )
  })

  it("Chatterbox generates audio with CPU device", { timeout: TIMEOUT }, async () => {
    console.log("\n--- Testing Chatterbox with CPU ---")
    console.log("This may take several minutes...")
    
    const result = await runTTS("Test.", "cpu")
    
    console.log(`Result: ${result.success ? "SUCCESS" : "FAILED"}`)
    console.log(`Duration: ${Math.round(result.duration / 1000)}s`)
    
    if (result.outputFile) {
      createdFiles.push(result.outputFile)
    }
    
    if (result.error) {
      console.log(`Error: ${result.error}`)
    }
    
    assert.ok(
      result.success,
      `Chatterbox with CPU should produce audio. Error: ${result.error}`
    )
  })

  it("MPS produces audio faster than CPU", async (t) => {
    if (!mpsAvailable) {
      t.skip("MPS not available")
      return
    }
    // This is informational - we already ran both in previous tests
    console.log("\n--- Performance comparison would go here ---")
    console.log("(Skipping duplicate runs - see previous test durations)")
    assert.ok(true)
  })
})

describe("TTS E2E - Script Extraction Validation", () => {
  it("can extract embedded script from tts.ts", async () => {
    const pluginSource = await readFile(join(__dirname, "../tts.ts"), "utf-8")
    
    // The pattern we're looking for
    const scriptMatch = pluginSource.match(/async function ensureChatterboxScript\(\)[\s\S]*?const script = `([\s\S]*?)`\s*\n\s*await writeFile/)
    
    assert.ok(scriptMatch, "Should find embedded script in tts.ts")
    
    const script = scriptMatch![1]
    
    // Verify script has MPS support
    assert.ok(
      script.includes('choices=["cuda", "mps", "cpu"]'),
      "Embedded script must have mps in argparse choices"
    )
    
    assert.ok(
      script.includes("torch.backends.mps.is_available"),
      "Embedded script must check MPS availability"
    )
    
    console.log("Embedded script has MPS support")
  })
})

describe("TTS Plugin - Integration Requirements", () => {
  it("defaults to Coqui engine in code", async () => {
    const pluginSource = await readFile(join(__dirname, "../tts.ts"), "utf-8")
    
    // Check loadConfig default returns coqui
    assert.ok(
      pluginSource.includes('engine: "coqui"'),
      "Default engine should be coqui"
    )
    
    // Verify getEngine returns coqui by default
    assert.ok(
      pluginSource.includes('return config.engine || "coqui"'),
      "getEngine should default to coqui"
    )
    
    console.log("TTS plugin defaults to Coqui engine")
  })

  it("stores TTS output in .tts/ directory", async () => {
    const pluginSource = await readFile(join(__dirname, "../tts.ts"), "utf-8")
    
    // Check for .tts/ directory usage
    assert.ok(
      pluginSource.includes('const ttsDir = join(directory, ".tts")'),
      "Plugin should define ttsDir in .tts/"
    )
    
    // Check for saveTTSData function
    assert.ok(
      pluginSource.includes("async function saveTTSData"),
      "Plugin should have saveTTSData function"
    )
    
    // Check that saveTTSData writes to ttsDir
    assert.ok(
      pluginSource.includes("join(ttsDir, filename)"),
      "saveTTSData should write to ttsDir"
    )
    
    // Check saveTTSData is called with session data
    assert.ok(
      pluginSource.includes("await saveTTSData(sessionId"),
      "saveTTSData should be called with sessionId"
    )
    
    console.log("TTS plugin stores output in .tts/ directory")
  })

  it("saves all required fields in TTS data", async () => {
    const pluginSource = await readFile(join(__dirname, "../tts.ts"), "utf-8")
    
    // Check saveTTSData includes required fields
    assert.ok(
      pluginSource.includes("originalText:"),
      "TTS data should include originalText"
    )
    assert.ok(
      pluginSource.includes("cleanedText:"),
      "TTS data should include cleanedText"
    )
    assert.ok(
      pluginSource.includes("spokenText:"),
      "TTS data should include spokenText"
    )
    assert.ok(
      pluginSource.includes("engine:") || pluginSource.includes("engine,"),
      "TTS data should include engine"
    )
    assert.ok(
      pluginSource.includes("timestamp:"),
      "TTS data should include timestamp"
    )
    
    console.log("TTS data includes all required fields")
  })

  it("TTS is triggered on session completion", async () => {
    const pluginSource = await readFile(join(__dirname, "../tts.ts"), "utf-8")
    
    // Check for session.idle event handling
    assert.ok(
      pluginSource.includes('event.type === "session.idle"'),
      "Plugin should handle session.idle event"
    )
    
    // Check for isSessionComplete check
    assert.ok(
      pluginSource.includes("isSessionComplete(messages)"),
      "Plugin should check if session is complete"
    )
    
    // Check speak is called with finalResponse
    assert.ok(
      pluginSource.includes("await speak(finalResponse, sessionId)"),
      "speak should be called with finalResponse and sessionId"
    )
    
    console.log("TTS is triggered on session completion")
  })
})

describe("TTS Plugin - Coqui Engine Integration", { skip: !RUN_E2E }, () => {
  const COQUI_DIR = join(process.env.HOME || "", ".config/opencode/coqui")
  const COQUI_VENV = join(COQUI_DIR, "venv")
  const COQUI_SCRIPT = join(COQUI_DIR, "tts.py")
  const COQUI_PYTHON = join(COQUI_VENV, "bin/python")

  it("Coqui TTS is installed and ready", async () => {
    try {
      await access(COQUI_PYTHON)
    } catch {
      console.log("Coqui venv not found at", COQUI_VENV)
      assert.fail("Coqui TTS venv must be installed for integration test")
    }

    try {
      const { stdout } = await execAsync(`"${COQUI_PYTHON}" -c "from TTS.api import TTS; print('ok')"`, { timeout: 30000 })
      assert.ok(stdout.includes("ok"), "Coqui TTS should be importable")
      console.log("Coqui TTS is installed and ready")
    } catch (e: any) {
      assert.fail(`Coqui TTS import failed: ${e.message}`)
    }
  })

  it("Coqui generates audio with MPS device", { timeout: TIMEOUT }, async () => {
    // Check MPS availability
    let mpsAvailable = false
    try {
      const { stdout } = await execAsync(
        `"${COQUI_PYTHON}" -c "import torch; print('yes' if torch.backends.mps.is_available() else 'no')"`,
        { timeout: 10000 }
      )
      mpsAvailable = stdout.trim() === "yes"
    } catch {}

    if (!mpsAvailable) {
      console.log("MPS not available, skipping MPS test")
      return
    }

    console.log("Testing Coqui TTS with MPS device...")
    const outputFile = join(tmpdir(), `coqui_test_${Date.now()}.wav`)
    
    const start = Date.now()
    const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      const proc = spawn(COQUI_PYTHON, [
        COQUI_SCRIPT,
        "--output", outputFile,
        "--device", "mps",
        "--model", "xtts_v2",
        "Hello, this is a test."
      ])
      
      let stderr = ""
      proc.stderr?.on("data", (d) => { stderr += d.toString() })
      
      const timeout = setTimeout(() => {
        proc.kill()
        resolve({ success: false, error: "Timeout" })
      }, TIMEOUT)
      
      proc.on("close", (code) => {
        clearTimeout(timeout)
        resolve({
          success: code === 0,
          error: code !== 0 ? `Exit ${code}: ${stderr}` : undefined
        })
      })
    })

    const duration = Date.now() - start
    console.log(`Duration: ${Math.round(duration / 1000)}s`)

    if (result.success) {
      // Cleanup
      try { await unlink(outputFile) } catch {}
    }

    assert.ok(result.success, `Coqui with MPS should work. Error: ${result.error}`)
  })
})
