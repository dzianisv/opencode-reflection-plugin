/**
 * Reflection Plugin for OpenCode
 *
 * Simple judge layer: when session idles, ask LLM if task is complete.
 * If not, send feedback to continue.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdir } from "fs/promises"
import { join } from "path"

const MAX_ATTEMPTS = 3
const JUDGE_RESPONSE_TIMEOUT = 180_000
const POLL_INTERVAL = 2_000

// No logging to avoid breaking CLI output

export const ReflectionPlugin: Plugin = async ({ client, directory }) => {
  
  // Track attempts per (sessionId, humanMsgCount) - resets automatically for new messages
  const attempts = new Map<string, number>()
  // Track which human message count we last completed reflection on
  const lastReflectedMsgCount = new Map<string, number>()
  const activeReflections = new Set<string>()
  const abortedSessions = new Set<string>() // Permanently track aborted sessions - never reflect on these
  const judgeSessionIds = new Set<string>() // Track judge session IDs to skip them

  // Directory for storing reflection input/output
  const reflectionDir = join(directory, ".reflection")

  async function ensureReflectionDir(): Promise<void> {
    try {
      await mkdir(reflectionDir, { recursive: true })
    } catch {}
  }

  async function saveReflectionData(sessionId: string, data: {
    task: string
    result: string
    tools: string
    prompt: string
    verdict: { 
      complete: boolean
      severity: string
      feedback: string
      missing?: string[]
      next_actions?: string[]
    } | null
    timestamp: string
  }): Promise<void> {
    await ensureReflectionDir()
    const filename = `${sessionId.slice(0, 8)}_${Date.now()}.json`
    const filepath = join(reflectionDir, filename)
    try {
      await writeFile(filepath, JSON.stringify(data, null, 2))
    } catch {}
  }

  async function showToast(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
    try {
      await client.tui.publish({
        query: { directory },
        body: {
          type: "tui.toast.show",
          properties: { title: "Reflection", message, variant, duration: 5000 }
        }
      })
    } catch {}
  }

  async function getAgentsFile(): Promise<string> {
    for (const name of ["AGENTS.md", ".opencode/AGENTS.md", "agents.md"]) {
      try {
        return await readFile(join(directory, name), "utf-8")
      } catch {}
    }
    return ""
  }

  function isJudgeSession(sessionId: string, messages: any[]): boolean {
    // Fast path: known judge session
    if (judgeSessionIds.has(sessionId)) return true
    
    // Content-based detection
    for (const msg of messages) {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text?.includes("TASK VERIFICATION")) {
          return true
        }
      }
    }
    return false
  }

  function wasSessionAborted(sessionId: string, messages: any[]): boolean {
    // Fast path: already known to be aborted
    if (abortedSessions.has(sessionId)) return true
    
    // Check if ANY assistant message has an abort error
    // This happens when user presses Esc to cancel the task
    // Once aborted, we should never reflect on this session again
    for (const msg of messages) {
      if (msg.info?.role === "assistant") {
        const error = msg.info?.error
        if (error) {
          // Check for MessageAbortedError by name
          if (error.name === "MessageAbortedError") {
            abortedSessions.add(sessionId)
            return true
          }
          // Also check error message content for abort indicators
          const errorMsg = error.data?.message || error.message || ""
          if (typeof errorMsg === "string" && errorMsg.toLowerCase().includes("abort")) {
            abortedSessions.add(sessionId)
            return true
          }
        }
      }
    }
    return false
  }

  function countHumanMessages(messages: any[]): number {
    let count = 0
    for (const msg of messages) {
      if (msg.info?.role === "user") {
        // Don't count reflection feedback as human input
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text && !part.text.includes("## Reflection:")) {
            count++
            break
          }
        }
      }
    }
    return count
  }

  function extractTaskAndResult(messages: any[]): { task: string; result: string; tools: string } | null {
    let task = ""
    let result = ""
    const tools: string[] = []

    for (const msg of messages) {
      if (msg.info?.role === "user") {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            if (part.text.includes("## Reflection:")) continue
            task = part.text // Always update to most recent human message
            break
          }
        }
      }

      for (const part of msg.parts || []) {
        if (part.type === "tool") {
          try {
            tools.push(`${part.tool}: ${JSON.stringify(part.state?.input || {}).slice(0, 200)}`)
          } catch {}
        }
      }

      if (msg.info?.role === "assistant") {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            result = part.text
          }
        }
      }
    }

    if (!task || !result) return null
    return { task, result, tools: tools.slice(-10).join("\n") }
  }

  async function waitForResponse(sessionId: string): Promise<string | null> {
    const start = Date.now()
    while (Date.now() - start < JUDGE_RESPONSE_TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
      try {
        const { data: messages } = await client.session.messages({ path: { id: sessionId } })
        const assistantMsg = [...(messages || [])].reverse().find((m: any) => m.info?.role === "assistant")
        if (!(assistantMsg?.info?.time as any)?.completed) continue
        for (const part of assistantMsg?.parts || []) {
          if (part.type === "text" && part.text) return part.text
        }
      } catch {}
    }
    return null
  }

  // Generate a key for tracking attempts per task (session + human message count)
  function getAttemptKey(sessionId: string, humanMsgCount: number): string {
    return `${sessionId}:${humanMsgCount}`
  }

  async function runReflection(sessionId: string): Promise<void> {
    // Prevent concurrent reflections on same session
    if (activeReflections.has(sessionId)) {
      return
    }
    activeReflections.add(sessionId)

    try {
      // Get messages first - needed for all checks
      const { data: messages } = await client.session.messages({ path: { id: sessionId } })
      if (!messages || messages.length < 2) return

      // Skip if session was aborted/cancelled by user (Esc key) - check FIRST
      if (wasSessionAborted(sessionId, messages)) {
        return
      }

      // Skip judge sessions
      if (isJudgeSession(sessionId, messages)) {
        return
      }

      // Count human messages to determine current "task"
      const humanMsgCount = countHumanMessages(messages)
      if (humanMsgCount === 0) return

      // Check if we already completed reflection for this exact message count
      const lastReflected = lastReflectedMsgCount.get(sessionId) || 0
      if (humanMsgCount <= lastReflected) {
        // Already handled this task
        return
      }

      // Get attempt count for THIS specific task (session + message count)
      const attemptKey = getAttemptKey(sessionId, humanMsgCount)
      const attemptCount = attempts.get(attemptKey) || 0
      
      if (attemptCount >= MAX_ATTEMPTS) {
        // Max attempts for this task - mark as reflected and stop
        lastReflectedMsgCount.set(sessionId, humanMsgCount)
        await showToast(`Max attempts (${MAX_ATTEMPTS}) reached`, "warning")
        return
      }

      // Extract task info
      const extracted = extractTaskAndResult(messages)
      if (!extracted) return

      // Create judge session and evaluate
      const { data: judgeSession } = await client.session.create({
        query: { directory }
      })
      if (!judgeSession?.id) return

      // Track judge session ID to skip it if session.idle fires on it
      judgeSessionIds.add(judgeSession.id)

      // Helper to clean up judge session (always called)
      const cleanupJudgeSession = async () => {
        try {
          await client.session.delete({ 
            path: { id: judgeSession.id },
            query: { directory }
          })
        } catch (e) {
          // Log deletion failures for debugging (but don't break the flow)
          console.error(`[Reflection] Failed to delete judge session ${judgeSession.id}:`, e)
        } finally {
          judgeSessionIds.delete(judgeSession.id)
        }
      }

      try {
        const agents = await getAgentsFile()
        const prompt = `TASK VERIFICATION - Release Manager Protocol

You are a release manager with risk ownership. Evaluate whether the task is complete and ready for release.

${agents ? `## Project Instructions\n${agents.slice(0, 1500)}\n` : ""}
## Original Task
${extracted.task}

## Tools Used
${extracted.tools || "(none)"}

## Agent's Response
${extracted.result.slice(0, 2000)}

---

## Evaluation Rules

### Severity Levels
- BLOCKER: security, auth, billing/subscription, data loss, E2E broken, prod health broken → complete MUST be false
- HIGH: major functionality degraded, CI red without approved waiver
- MEDIUM: partial degradation or uncertain coverage
- LOW: cosmetic / non-impacting
- NONE: no issues

### Hard Requirements (must ALL be met for complete:true)
1. All explicitly requested functionality implemented
2. Tests run and pass (if tests were requested or exist)
3. Build/compile succeeds (if applicable)
4. No unhandled errors in output

### Evidence Requirements
Every claim needs evidence. Reject claims like "ready", "verified", "working", "fixed" without:
- Actual command output showing success
- Test name + result
- File changes made

### Flaky Test Protocol
If a test is called "flaky" or "unrelated", require at least ONE of:
- Rerun with pass (show output)
- Quarantine/skip with tracking ticket
- Replacement test validating same requirement
- Stabilization fix applied
Without mitigation → severity >= HIGH, complete: false

### Waiver Protocol
If a required gate failed but agent claims ready, response MUST include:
- Explicit waiver statement ("shipping with known issue X")
- Impact scope ("affects Y users/flows")
- Mitigation/rollback plan
- Follow-up tracking (ticket/issue reference)
Without waiver details → complete: false

### Temporal Consistency
Reject if:
- Readiness claimed before verification ran
- Later output contradicts earlier "done" claim
- Failures downgraded after-the-fact without new evidence

---

Reply with JSON only (no other text):
{
  "complete": true/false,
  "severity": "NONE|LOW|MEDIUM|HIGH|BLOCKER",
  "feedback": "brief explanation of verdict",
  "missing": ["list of missing required steps or evidence"],
  "next_actions": ["concrete commands or checks to run"]
}`

        await client.session.promptAsync({
          path: { id: judgeSession.id },
          body: { parts: [{ type: "text", text: prompt }] }
        })

        const response = await waitForResponse(judgeSession.id)
        
        if (!response) {
          // Timeout - mark this task as reflected to avoid infinite retries
          lastReflectedMsgCount.set(sessionId, humanMsgCount)
          return
        }

        const jsonMatch = response.match(/\{[\s\S]*\}/)
        if (!jsonMatch) {
          lastReflectedMsgCount.set(sessionId, humanMsgCount)
          return
        }

        const verdict = JSON.parse(jsonMatch[0])

        // Save reflection data to .reflection/ directory
        await saveReflectionData(sessionId, {
          task: extracted.task,
          result: extracted.result.slice(0, 2000),
          tools: extracted.tools || "(none)",
          prompt,
          verdict,
          timestamp: new Date().toISOString()
        })

        // Normalize severity and enforce BLOCKER rule
        const severity = verdict.severity || "MEDIUM"
        const isBlocker = severity === "BLOCKER"
        const isComplete = verdict.complete && !isBlocker

        if (isComplete) {
          // COMPLETE: mark this task as reflected, show toast only (no prompt!)
          lastReflectedMsgCount.set(sessionId, humanMsgCount)
          attempts.delete(attemptKey)
          const toastMsg = severity === "NONE" ? "Task complete ✓" : `Task complete ✓ (${severity})`
          await showToast(toastMsg, "success")
        } else {
          // INCOMPLETE: increment attempts and send feedback
          attempts.set(attemptKey, attemptCount + 1)
          const toastVariant = isBlocker ? "error" : "warning"
          await showToast(`${severity}: Incomplete (${attemptCount + 1}/${MAX_ATTEMPTS})`, toastVariant)
          
          // Build structured feedback message
          const missing = verdict.missing?.length 
            ? `\n### Missing\n${verdict.missing.map((m: string) => `- ${m}`).join("\n")}`
            : ""
          const nextActions = verdict.next_actions?.length
            ? `\n### Next Actions\n${verdict.next_actions.map((a: string) => `- ${a}`).join("\n")}`
            : ""
          
          await client.session.promptAsync({
            path: { id: sessionId },
            body: {
              parts: [{
                type: "text",
                text: `## Reflection: Task Incomplete (${attemptCount + 1}/${MAX_ATTEMPTS}) [${severity}]

${verdict.feedback || "Please review and complete the task."}${missing}${nextActions}

Please address the above and continue.`
              }]
            }
          })
          // Don't mark as reflected yet - we want to check again after agent responds
        }
      } finally {
        // Always clean up judge session to prevent clutter in /session list
        await cleanupJudgeSession()
      }
    } catch {
      // On error, don't mark as reflected - allow retry
    } finally {
      activeReflections.delete(sessionId)
    }
  }

  return {
    event: async ({ event }) => {
      // Track aborted sessions immediately when session.error fires
      if (event.type === "session.error") {
        const props = (event as any).properties
        const sessionId = props?.sessionID
        const error = props?.error
        if (sessionId && error?.name === "MessageAbortedError") {
          abortedSessions.add(sessionId)
        }
      }
      
      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        if (sessionId && typeof sessionId === "string") {
          // Fast path: skip if already known to be aborted or a judge session
          if (abortedSessions.has(sessionId)) return
          if (judgeSessionIds.has(sessionId)) return
          await runReflection(sessionId)
        }
      }
    }
  }
}

export default ReflectionPlugin
