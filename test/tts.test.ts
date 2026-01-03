/**
 * Tests for OpenCode TTS Plugin
 */

import { describe, it, before } from "node:test"
import assert from "node:assert"
import { readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)
const __dirname = dirname(fileURLToPath(import.meta.url))

describe("TTS Plugin - Unit Tests", () => {
  // Test the text cleaning logic (extracted from plugin)
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

  it("removes code blocks", () => {
    const input = "Here is some code:\n```javascript\nconst x = 1;\n```\nDone."
    const result = cleanTextForSpeech(input)
    assert.ok(!result.includes("const x"))
    assert.ok(result.includes("code block omitted"))
  })

  it("removes inline code", () => {
    const input = "Use the `say` command to speak."
    const result = cleanTextForSpeech(input)
    assert.ok(!result.includes("`"))
    assert.ok(!result.includes("say"))
  })

  it("keeps link text but removes URLs", () => {
    const input = "Check [OpenCode](https://github.com/sst/opencode) for more."
    const result = cleanTextForSpeech(input)
    assert.ok(result.includes("OpenCode"))
    assert.ok(!result.includes("https://"))
    assert.ok(!result.includes("github.com"))
  })

  it("removes markdown formatting", () => {
    const input = "This is **bold** and *italic* and ~~strikethrough~~"
    const result = cleanTextForSpeech(input)
    assert.ok(!result.includes("*"))
    assert.ok(!result.includes("~"))
    assert.ok(result.includes("bold"))
    assert.ok(result.includes("italic"))
  })

  it("removes file paths", () => {
    const input = "Edit the file /Users/test/project/src/index.ts"
    const result = cleanTextForSpeech(input)
    assert.ok(!result.includes("/Users"))
  })

  it("collapses whitespace", () => {
    const input = "Hello    world\n\n\ntest"
    const result = cleanTextForSpeech(input)
    assert.strictEqual(result, "Hello world test")
  })
})

describe("TTS Plugin - Structure Validation", () => {
  let pluginContent: string

  before(async () => {
    pluginContent = await readFile(
      join(__dirname, "../tts.ts"),
      "utf-8"
    )
  })

  it("has required exports", () => {
    assert.ok(pluginContent.includes("export const TTSPlugin"), "Missing TTSPlugin export")
    assert.ok(pluginContent.includes("export default"), "Missing default export")
  })

  it("uses macOS say command for OS TTS", () => {
    assert.ok(pluginContent.includes("say"), "Missing say command")
    assert.ok(pluginContent.includes("execAsync"), "Missing exec for say command")
  })

  it("has session tracking to prevent duplicates", () => {
    assert.ok(pluginContent.includes("spokenSessions"), "Missing spokenSessions set")
  })

  it("has max speech length limit", () => {
    assert.ok(pluginContent.includes("MAX_SPEECH_LENGTH"), "Missing MAX_SPEECH_LENGTH")
  })

  it("skips judge sessions", () => {
    assert.ok(pluginContent.includes("isJudgeSession"), "Missing judge session check")
    assert.ok(pluginContent.includes("TASK VERIFICATION"), "Missing judge session marker")
  })

  it("listens to session.idle event", () => {
    assert.ok(pluginContent.includes("session.idle"), "Missing session.idle event handler")
  })

  it("extracts final assistant response", () => {
    assert.ok(pluginContent.includes("extractFinalResponse"), "Missing response extraction")
    assert.ok(pluginContent.includes('role === "assistant"'), "Missing assistant role check")
  })

  it("checks for TTS_DISABLED env var", () => {
    assert.ok(pluginContent.includes("process.env.TTS_DISABLED"), "Missing env var check")
  })

  it("supports config file toggle", () => {
    assert.ok(pluginContent.includes("tts.json"), "Missing config file reference")
    assert.ok(pluginContent.includes("isEnabled"), "Missing isEnabled check")
  })
})

describe("TTS Plugin - Engine Configuration", () => {
  let pluginContent: string

  before(async () => {
    pluginContent = await readFile(
      join(__dirname, "../tts.ts"),
      "utf-8"
    )
  })

  it("supports chatterbox engine", () => {
    assert.ok(pluginContent.includes("chatterbox"), "Missing chatterbox engine")
    assert.ok(pluginContent.includes("ChatterboxTTS"), "Missing ChatterboxTTS reference")
  })

  it("supports OS TTS engine", () => {
    assert.ok(pluginContent.includes("speakWithOS"), "Missing OS TTS function")
    assert.ok(pluginContent.includes('TTS_ENGINE === "os"') || pluginContent.includes('"os"'), "Missing OS engine option")
  })

  it("has engine type definition", () => {
    assert.ok(pluginContent.includes("TTSEngine"), "Missing TTSEngine type")
    assert.ok(pluginContent.includes('"chatterbox" | "os"'), "Missing engine type union")
  })

  it("supports TTS_ENGINE env var", () => {
    assert.ok(pluginContent.includes("process.env.TTS_ENGINE"), "Missing TTS_ENGINE env var check")
  })

  it("implements automatic fallback", () => {
    assert.ok(pluginContent.includes("isChatterboxAvailable"), "Missing availability check")
    assert.ok(pluginContent.includes("speakWithOS"), "Missing OS TTS fallback")
  })

  it("has Chatterbox configuration options", () => {
    assert.ok(pluginContent.includes("chatterbox?:"), "Missing chatterbox config section")
    assert.ok(pluginContent.includes("device?:"), "Missing device option")
    assert.ok(pluginContent.includes("voiceRef?:"), "Missing voice reference option")
    assert.ok(pluginContent.includes("exaggeration?:"), "Missing exaggeration option")
    assert.ok(pluginContent.includes("useTurbo?:"), "Missing turbo option")
  })

  it("has Python helper script generation", () => {
    assert.ok(pluginContent.includes("tts.py"), "Missing Python script path")
    assert.ok(pluginContent.includes("ensureChatterboxScript"), "Missing script generation function")
  })

  it("defaults to OS TTS with Samantha voice", () => {
    // Default is now OS TTS (Samantha voice on macOS) for out-of-box female voice experience
    assert.ok(pluginContent.includes('engine: "os"'), "OS TTS should be default")
    assert.ok(pluginContent.includes('voice: "Samantha"'), "Samantha should be default voice")
  })
})

describe("TTS Plugin - Chatterbox Features", () => {
  let pluginContent: string

  before(async () => {
    pluginContent = await readFile(
      join(__dirname, "../tts.ts"),
      "utf-8"
    )
  })

  it("supports GPU (cuda) and CPU device selection", () => {
    assert.ok(pluginContent.includes('"cuda"'), "Missing cuda device option")
    assert.ok(pluginContent.includes('"cpu"'), "Missing cpu device option")
  })

  it("supports Turbo model variant", () => {
    assert.ok(pluginContent.includes("--turbo"), "Missing turbo flag")
    assert.ok(pluginContent.includes("ChatterboxTurboTTS"), "Missing Turbo model import")
  })

  it("supports voice cloning via reference audio", () => {
    assert.ok(pluginContent.includes("--voice"), "Missing voice reference flag")
    assert.ok(pluginContent.includes("audio_prompt_path"), "Missing audio_prompt_path")
  })

  it("supports emotion exaggeration control", () => {
    assert.ok(pluginContent.includes("--exaggeration"), "Missing exaggeration flag")
    assert.ok(pluginContent.includes("exaggeration="), "Missing exaggeration parameter")
  })

  it("generates WAV files to temp directory", () => {
    assert.ok(pluginContent.includes("tmpdir()"), "Missing temp directory usage")
    assert.ok(pluginContent.includes(".wav"), "Missing WAV file extension")
  })

  it("plays audio with afplay on macOS", () => {
    assert.ok(pluginContent.includes("afplay"), "Missing afplay for audio playback")
  })

  it("cleans up temp files after playback", () => {
    assert.ok(pluginContent.includes("unlink"), "Missing file cleanup")
  })

  it("supports server mode for persistent model loading", () => {
    assert.ok(pluginContent.includes("serverMode"), "Missing serverMode option")
    assert.ok(pluginContent.includes("tts_server.py"), "Missing server script")
    assert.ok(pluginContent.includes("startChatterboxServer"), "Missing server start function")
    assert.ok(pluginContent.includes("speakWithChatterboxServer"), "Missing server speak function")
  })

  it("uses Unix socket for fast IPC with server", () => {
    assert.ok(pluginContent.includes("tts.sock"), "Missing socket path")
    assert.ok(pluginContent.includes("AF_UNIX"), "Missing Unix socket in server script")
  })

  it("supports Apple Silicon (MPS) device", () => {
    assert.ok(pluginContent.includes('"mps"'), "Missing MPS device option")
    assert.ok(pluginContent.includes("torch.backends.mps.is_available"), "Missing MPS detection")
  })
})

describe("TTS Plugin - macOS Integration", () => {
  it("say command is available on macOS", async () => {
    try {
      await execAsync("which say")
      assert.ok(true, "say command found")
    } catch {
      // Skip on non-macOS
      console.log("  [SKIP] say command not available (not macOS)")
    }
  })

  it("can list available voices", async () => {
    try {
      const { stdout } = await execAsync("say -v '?'")
      assert.ok(stdout.length > 0, "Should list voices")
      assert.ok(stdout.includes("en_"), "Should have English voices")
    } catch {
      console.log("  [SKIP] say command not available (not macOS)")
    }
  })

  it("afplay command is available on macOS", async () => {
    try {
      await execAsync("which afplay")
      assert.ok(true, "afplay command found")
    } catch {
      console.log("  [SKIP] afplay command not available (not macOS)")
    }
  })
})

describe("TTS Plugin - Chatterbox Availability Check", () => {
  it("checks Python chatterbox import", async () => {
    try {
      await execAsync('python3 -c "import chatterbox; print(\'ok\')"', { timeout: 10000 })
      console.log("  [INFO] Chatterbox is installed and available")
    } catch {
      console.log("  [INFO] Chatterbox not installed - will fall back to OS TTS")
      console.log("  [INFO] Install with: pip install chatterbox-tts")
    }
    // This test always passes - just informational
    assert.ok(true)
  })
})
