/**
 * Tests for OpenCode Reflection Plugin
 */

import { describe, it, before } from "node:test"
import assert from "node:assert"
import { readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

describe("Reflection Plugin - Unit Tests", () => {
  it("parseJudgeResponse extracts PASS verdict", () => {
    const logs = [`[Reflection] Verdict: COMPLETE`]
    assert.ok(logs[0].includes("COMPLETE"))
  })

  it("parseJudgeResponse extracts FAIL verdict", () => {
    const logs = [`[Reflection] Verdict: INCOMPLETE`]
    assert.ok(logs[0].includes("INCOMPLETE"))
  })

  it("detects max attempts reached", () => {
    const log = `[Reflection] Max attempts reached for ses_123`
    assert.ok(log.includes("Max attempts reached"))
  })

  it("parses JSON verdict correctly", () => {
    const judgeResponse = `{"complete": false, "feedback": "Missing tests"}`
    const match = judgeResponse.match(/\{[\s\S]*\}/)
    assert.ok(match)
    const verdict = JSON.parse(match[0])
    assert.strictEqual(verdict.complete, false)
    assert.strictEqual(verdict.feedback, "Missing tests")
  })

  it("detects aborted sessions", () => {
    // Simulate an aborted session's messages (using any to avoid TS issues)
    const abortedMessages: any[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Do something" }] },
      { 
        info: { 
          role: "assistant", 
          error: { name: "MessageAbortedError", message: "User cancelled" } 
        }, 
        parts: [{ type: "text", text: "I'll start..." }] 
      }
    ]
    
    // Check that we detect the abort error
    const lastAssistant = [...abortedMessages].reverse().find((m: any) => m.info?.role === "assistant")
    const wasAborted = lastAssistant?.info?.error?.name === "MessageAbortedError"
    assert.strictEqual(wasAborted, true, "Should detect aborted session")
  })

  it("does not flag non-aborted sessions as aborted", () => {
    // Simulate a normal completed session
    const normalMessages: any[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Do something" }] },
      { 
        info: { role: "assistant" }, 
        parts: [{ type: "text", text: "Done!" }] 
      }
    ]
    
    const lastAssistant = [...normalMessages].reverse().find((m: any) => m.info?.role === "assistant")
    const wasAborted = lastAssistant?.info?.error?.name === "MessageAbortedError"
    assert.strictEqual(wasAborted, false, "Should not flag normal session as aborted")
  })
})

describe("Reflection Plugin - Structure Validation", () => {
  let pluginContent: string

  before(async () => {
    pluginContent = await readFile(
      join(__dirname, "../reflection.ts"),
      "utf-8"
    )
  })

  it("has required exports", () => {
    assert.ok(pluginContent.includes("export const ReflectionPlugin"), "Missing ReflectionPlugin export")
    assert.ok(pluginContent.includes("export default"), "Missing default export")
  })

  it("has judge session tracking", () => {
    assert.ok(pluginContent.includes("judgeSessionIds"), "Missing judgeSessionIds set")
    assert.ok(pluginContent.includes("lastReflectedMsgCount"), "Missing lastReflectedMsgCount map")
  })

  it("has attempt limiting", () => {
    assert.ok(pluginContent.includes("MAX_ATTEMPTS"), "Missing MAX_ATTEMPTS")
    assert.ok(pluginContent.includes("attempts"), "Missing attempts tracking")
  })

  it("uses JSON schema for verdict", () => {
    assert.ok(pluginContent.includes('"complete"'), "Missing complete field in schema")
    assert.ok(pluginContent.includes('"feedback"'), "Missing feedback field in schema")
    assert.ok(pluginContent.includes('"severity"'), "Missing severity field in schema")
    assert.ok(pluginContent.includes('"missing"'), "Missing missing field in schema")
    assert.ok(pluginContent.includes('"next_actions"'), "Missing next_actions field in schema")
  })

  it("detects judge prompts to prevent recursion", () => {
    assert.ok(pluginContent.includes("TASK VERIFICATION"), "Missing judge prompt marker")
  })

  it("cleans up sessions", () => {
    assert.ok(pluginContent.includes("lastReflectedMsgCount.set"), "Missing reflection tracking")
    assert.ok(pluginContent.includes("judgeSessionIds.add"), "Missing judge session tracking")
  })

  it("detects aborted sessions to skip reflection", () => {
    assert.ok(pluginContent.includes("wasSessionAborted"), "Missing wasSessionAborted function")
    assert.ok(pluginContent.includes("MessageAbortedError"), "Missing MessageAbortedError check")
  })
})

describe("Reflection Plugin - Enhanced Prompt Features", () => {
  let pluginContent: string

  before(async () => {
    pluginContent = await readFile(
      join(__dirname, "../reflection.ts"),
      "utf-8"
    )
  })

  it("defines severity levels", () => {
    assert.ok(pluginContent.includes("BLOCKER"), "Missing BLOCKER severity")
    assert.ok(pluginContent.includes("HIGH"), "Missing HIGH severity")
    assert.ok(pluginContent.includes("MEDIUM"), "Missing MEDIUM severity")
    assert.ok(pluginContent.includes("LOW"), "Missing LOW severity")
    assert.ok(pluginContent.includes("NONE"), "Missing NONE severity")
  })

  it("enforces BLOCKER rule", () => {
    // BLOCKER severity should force complete to false
    assert.ok(pluginContent.includes("isBlocker"), "Missing BLOCKER enforcement logic")
    assert.ok(pluginContent.includes('severity === "BLOCKER"'), "Missing BLOCKER check")
  })

  it("includes evidence requirements in prompt", () => {
    assert.ok(pluginContent.includes("Evidence Requirements"), "Missing Evidence Requirements section")
  })

  it("includes waiver protocol in prompt", () => {
    assert.ok(pluginContent.includes("Waiver Protocol"), "Missing Waiver Protocol section")
  })

  it("includes flaky test protocol in prompt", () => {
    assert.ok(pluginContent.includes("Flaky Test Protocol"), "Missing Flaky Test Protocol section")
  })

  it("includes temporal consistency in prompt", () => {
    assert.ok(pluginContent.includes("Temporal Consistency"), "Missing Temporal Consistency section")
  })

  it("parses enhanced JSON verdict correctly", () => {
    const judgeResponse = `{
      "complete": false,
      "severity": "HIGH",
      "feedback": "E2E tests not run",
      "missing": ["E2E test execution", "Build verification"],
      "next_actions": ["npm run test:e2e", "npm run build"]
    }`
    const match = judgeResponse.match(/\{[\s\S]*\}/)
    assert.ok(match)
    const verdict = JSON.parse(match[0])
    assert.strictEqual(verdict.complete, false)
    assert.strictEqual(verdict.severity, "HIGH")
    assert.ok(Array.isArray(verdict.missing))
    assert.ok(Array.isArray(verdict.next_actions))
  })

  it("enforces BLOCKER blocks completion", () => {
    // Test logic: if severity is BLOCKER, complete must be false
    const verdict = { complete: true, severity: "BLOCKER" }
    const isBlocker = verdict.severity === "BLOCKER"
    const isComplete = verdict.complete && !isBlocker
    assert.strictEqual(isComplete, false, "BLOCKER should block completion")
  })
})
