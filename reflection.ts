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

  console.log(`[Reflection] Plugin initialized for: ${directory}`)

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
      // Get first user message as task
      if (!task && msg.info?.role === "user") {
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
          tools.push(`${part.tool}: ${JSON.stringify(part.state?.input || {}).slice(0, 200)}`)
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
      console.log(`[Reflection] Max attempts reached for ${sessionId}`)
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
Is this task COMPLETE? Reply with JSON only:
{"complete": true/false, "feedback": "if incomplete, what's missing"}`

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
        console.log("[Reflection] No JSON in judge response")
        return
      }

      const verdict = JSON.parse(jsonMatch[0])
      console.log(`[Reflection] Verdict: ${verdict.complete ? "COMPLETE" : "INCOMPLETE"}`)

      if (!verdict.complete && verdict.feedback) {
        attempts.set(sessionId, attemptCount + 1)

        // Send feedback to original session
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{
              type: "text",
              text: `## Task Incomplete (${attemptCount + 1}/${MAX_ATTEMPTS})\n\n${verdict.feedback}\n\nPlease continue and complete the task.`
            }]
          }
        })
      } else {
        attempts.delete(sessionId)
      }
    } catch (e) {
      console.log("[Reflection] Error:", e)
    } finally {
      judgeSessionIds.delete(judgeSession.id)
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        if (sessionId && !judgeSessionIds.has(sessionId)) {
          await judge(sessionId)
        }
      }
    }
  }
}

export default ReflectionPlugin
