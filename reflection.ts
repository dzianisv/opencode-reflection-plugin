/**
 * Reflection Plugin for OpenCode
 *
 * Simple judge layer: when session idles, ask LLM if task is complete.
 * If not, send feedback to continue.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import { join } from "path"

const MAX_ATTEMPTS = 3
const JUDGE_RESPONSE_TIMEOUT = 180_000
const POLL_INTERVAL = 2_000

export const ReflectionPlugin: Plugin = async ({ client, directory }) => {
  const attempts = new Map<string, number>()
  const lastHumanMsgCount = new Map<string, number>() // Track human message count to detect new input
  const processedSessions = new Set<string>()
  const activeReflections = new Set<string>()

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

  function wasSessionAborted(messages: any[]): boolean {
    // Check if the last assistant message has an abort error
    // This happens when user presses Esc to cancel the task
    const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
    if (!lastAssistant?.info?.error) return false
    return lastAssistant.info.error.name === "MessageAbortedError"
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
            if (!task) task = part.text
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

  async function runReflection(sessionId: string): Promise<void> {
    // Prevent concurrent reflections
    if (activeReflections.has(sessionId)) return
    activeReflections.add(sessionId)

    try {
      // Get messages first - needed for human message count check
      const { data: messages } = await client.session.messages({ path: { id: sessionId } })
      if (!messages || messages.length < 2) return

      // Check if human typed a new message - reset attempts if so
      const humanMsgCount = countHumanMessages(messages)
      const prevHumanMsgCount = lastHumanMsgCount.get(sessionId) || 0
      if (humanMsgCount > prevHumanMsgCount) {
        attempts.delete(sessionId)
        processedSessions.delete(sessionId) // Allow reflection again after new human input
      }
      lastHumanMsgCount.set(sessionId, humanMsgCount)

      // Now check if already processed (after potential reset above)
      if (processedSessions.has(sessionId)) return

      // Skip judge sessions
      if (isJudgeSession(messages)) {
        processedSessions.add(sessionId)
        return
      }

      // Skip if session was aborted/cancelled by user (Esc key)
      if (wasSessionAborted(messages)) {
        processedSessions.add(sessionId)
        return
      }

      // Check attempt count
      const attemptCount = attempts.get(sessionId) || 0
      if (attemptCount >= MAX_ATTEMPTS) {
        processedSessions.add(sessionId)
        await showToast(`Max attempts (${MAX_ATTEMPTS}) reached`, "warning")
        return
      }

      // Extract task info
      const extracted = extractTaskAndResult(messages)
      if (!extracted) return

      // Create judge session and evaluate
      const { data: judgeSession } = await client.session.create({})
      if (!judgeSession?.id) return

      // Mark judge session as processed immediately
      processedSessions.add(judgeSession.id)

      const agents = await getAgentsFile()
      const prompt = `TASK VERIFICATION

${agents ? `## Instructions\n${agents.slice(0, 1500)}\n` : ""}
## Original Task
${extracted.task}

## Tools Used
${extracted.tools || "(none)"}

## Agent's Response
${extracted.result.slice(0, 2000)}

---
Reply with JSON only:
{"complete": true/false, "feedback": "brief explanation"}`

      await client.session.promptAsync({
        path: { id: judgeSession.id },
        body: { parts: [{ type: "text", text: prompt }] }
      })

      const response = await waitForResponse(judgeSession.id)
      if (!response) {
        processedSessions.add(sessionId)
        return
      }

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        processedSessions.add(sessionId)
        return
      }

      const verdict = JSON.parse(jsonMatch[0])

      if (verdict.complete) {
        // COMPLETE: mark as done, show toast only (no prompt!)
        processedSessions.add(sessionId)
        attempts.delete(sessionId)
        await showToast("Task complete ✓", "success")
      } else {
        // INCOMPLETE: send feedback to continue
        attempts.set(sessionId, attemptCount + 1)
        await showToast(`Incomplete (${attemptCount + 1}/${MAX_ATTEMPTS})`, "warning")
        
        await client.session.promptAsync({
          path: { id: sessionId },
          body: {
            parts: [{
              type: "text",
              text: `## Reflection: Task Incomplete (${attemptCount + 1}/${MAX_ATTEMPTS})

${verdict.feedback || "Please review and complete the task."}

Please address the above and continue.`
            }]
          }
        })
      }
    } catch {
      processedSessions.add(sessionId)
    } finally {
      activeReflections.delete(sessionId)
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        if (sessionId && typeof sessionId === "string") {
          await runReflection(sessionId)
        }
      }
    }
  }
}

export default ReflectionPlugin
