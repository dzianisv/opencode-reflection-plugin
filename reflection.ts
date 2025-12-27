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

export const ReflectionPlugin: Plugin = async ({ client, directory }) => {
  const attempts = new Map<string, number>()
  const judgeSessionIds = new Set<string>()

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

      // Send prompt and wait for response
      const { data: response } = await client.session.prompt({
        path: { id: judgeSession.id },
        body: { parts: [{ type: "text", text: prompt }] }
      })

      // Extract judge response
      let judgeText = ""
      const msgs = Array.isArray(response) ? response : [response]
      for (const msg of msgs) {
        if (msg?.info?.role === "assistant") {
          for (const part of msg.parts || []) {
            if (part.type === "text") judgeText = (part as any).text || ""
          }
        }
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

        // Send actionable feedback to continue the task
        await client.session.prompt({
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

        // Task complete - send summary as confirmation
        await client.session.prompt({
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
