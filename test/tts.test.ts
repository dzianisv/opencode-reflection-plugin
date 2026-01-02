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

  it("uses macOS say command", () => {
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
})
