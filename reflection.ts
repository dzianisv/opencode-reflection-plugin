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
const JUDGE_RESPONSE_TIMEOUT = 180_000  // 3 minutes for slow models like Opus 4.5
const POLL_INTERVAL = 2_000  // 2 seconds between polls

export const ReflectionPlugin: Plugin = async ({ client, directory }) => {
  const attempts = new Map<string, number>()
  const judgeSessionIds = new Set<string>()

  console.log("[Reflection] Plugin initialized")

  // Helper to show toast notifications in OpenCode UI
  async function showToast(message: string, variant: "info" | "success" | "warning" | "error" = "info") {
    try {
      await client.tui.publish({
        query: { directory },
        body: {
          type: "tui.toast.show",
          properties: {
            title: "Reflection",
            message,
            variant,
            duration: 5000
          }
        }
      })
    } catch (e) {
      // Silently fail if TUI not available (e.g., in tests)
    }
  }

  async function getAgentsFile(): Promise<string> {
    for (const name of ["AGENTS.md", ".opencode/AGENTS.md", "agents.md"]) {
      try {
        return await readFile(join(directory, name), "utf-8")
      } catch {}
    }
    return ""
  }

  function extractFromMessages(messages: any[]): { task: string; result: string; tools: string } | null {
    let task = ""
    let result = ""
    const tools: string[] = []

    for (const msg of messages) {
      // Get LAST user message as task (override each time)
      if (msg.info?.role === "user") {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            // Skip if this is a judge prompt
            if (part.text.includes("TASK VERIFICATION")) return null
            task = part.text
            break
          }
        }
      }

      // Collect tool calls
      for (const part of msg.parts || []) {
        if (part.type === "tool") {
          try {
            const input = JSON.stringify(part.state?.input || {})
            tools.push(`${part.tool}: ${input.slice(0, 200)}`)
          } catch (e) {
            tools.push(`${part.tool}: [serialization error]`)
          }
        }
      }

      // Get last assistant text as result
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

  // Poll for judge session response with timeout
  async function waitForJudgeResponse(client: any, sessionId: string, timeout: number): Promise<string | null> {
    const start = Date.now()
    let lastMessageCount = 0

    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))

      try {
        const { data: messages } = await client.session.messages({ path: { id: sessionId } })
        if (!messages) continue

        // Check if we have an assistant response
        for (const msg of messages) {
          if (msg.info?.role === "assistant") {
            for (const part of msg.parts || []) {
              if (part.type === "text" && part.text) {
                // Found assistant response with text
                return part.text
              }
            }
          }
        }

        // Check for stability (no new messages)
        if (messages.length === lastMessageCount && messages.length > 1) {
          // Session seems stable but no assistant text found
          continue
        }
        lastMessageCount = messages.length
      } catch (e) {
        // Continue polling on error
      }
    }

    return null  // Timeout
  }

  async function judge(sessionId: string): Promise<void> {
    // Skip if already judging or max attempts reached
    if (judgeSessionIds.has(sessionId)) return
    const attemptCount = attempts.get(sessionId) || 0
    if (attemptCount >= MAX_ATTEMPTS) {
      await showToast(`Max reflection attempts (${MAX_ATTEMPTS}) reached`, "warning")
      attempts.delete(sessionId)
      return
    }

    // Get session messages
    const { data: messages } = await client.session.messages({ path: { id: sessionId } })
    if (!messages || messages.length < 2) return

    const extracted = extractFromMessages(messages)
    if (!extracted) return

    const agents = await getAgentsFile()

    // Create judge session
    const { data: judgeSession } = await client.session.create({})
    if (!judgeSession?.id) return

    judgeSessionIds.add(judgeSession.id)
    console.log(`[Reflection] Starting reflection for session ${sessionId} (judge: ${judgeSession.id})`)

    try {
      const prompt = `TASK VERIFICATION

${agents ? `## Instructions\n${agents.slice(0, 1500)}\n` : ""}
## Original Task
${extracted.task}

## Tools Used
${extracted.tools || "(none)"}

## Agent's Response
${extracted.result.slice(0, 2000)}

---
Evaluate if this task is COMPLETE. Reply with JSON only:
{
  "complete": true/false,
  "feedback": "If incomplete: specific issues to fix. If complete: brief summary of what was accomplished."
}`

      // Send prompt asynchronously (non-blocking)
      await client.session.promptAsync({
        path: { id: judgeSession.id },
        body: { parts: [{ type: "text", text: prompt }] }
      })

      // Poll for judge response with timeout
      const judgeText = await waitForJudgeResponse(client, judgeSession.id, JUDGE_RESPONSE_TIMEOUT)
      if (!judgeText) {
        console.log("[Reflection] Judge timed out or no response")
        await showToast("Judge evaluation timed out", "warning")
        return
      }

      // Parse JSON response
      const jsonMatch = judgeText.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        await showToast("Failed to parse judge response", "error")
        return
      }

      const verdict = JSON.parse(jsonMatch[0])
      const feedback = verdict.feedback || (verdict.complete 
        ? "Task requirements satisfied." 
        : "No specific issues identified. Review task requirements.")

      if (!verdict.complete) {
        attempts.set(sessionId, attemptCount + 1)

        // Show toast notification
        await showToast(`Task incomplete (${attemptCount + 1}/${MAX_ATTEMPTS})`, "warning")
        console.log(`[Reflection] INCOMPLETE - sending feedback (attempt ${attemptCount + 1}/${MAX_ATTEMPTS})`)

        // Send actionable feedback to continue the task (async, triggers agent response)
        await client.session.promptAsync({
          path: { id: sessionId },
          body: {
            parts: [{
              type: "text",
              text: `## Reflection: Task Incomplete (Attempt ${attemptCount + 1}/${MAX_ATTEMPTS})

${feedback}

Please address the above issues and continue working on the task.`
            }]
          }
        })
      } else {
        // Show success toast
        await showToast("Task complete ✓", "success")
        console.log("[Reflection] COMPLETE - task verified")

        // Task complete - send summary as confirmation (async)
        await client.session.promptAsync({
          path: { id: sessionId },
          body: {
            parts: [{
              type: "text",
              text: `## Reflection: Task Complete ✓

${feedback}`
            }]
          }
        })
        attempts.delete(sessionId)
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      await showToast(`Reflection error: ${errorMsg}`, "error")
    } finally {
      judgeSessionIds.delete(judgeSession.id)
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        // Ensure sessionId is a valid string
        if (sessionId && typeof sessionId === "string" && !judgeSessionIds.has(sessionId)) {
          await judge(sessionId)
        }
      }
    }
  }
}

export default ReflectionPlugin
