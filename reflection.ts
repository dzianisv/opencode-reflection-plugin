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
const COOLDOWN_MS = 10_000   // Wait 10 seconds after feedback before allowing another reflection

export const ReflectionPlugin: Plugin = async ({ client, directory }) => {
  const attempts = new Map<string, number>()
  const judgeSessionIds = new Set<string>()
  const reflectingSessions = new Set<string>()  // Track sessions currently being reflected
  const completedSessions = new Set<string>()   // Track sessions that completed successfully
  const createdByPlugin = new Set<string>()     // Track ALL sessions created by this plugin
  const lastFeedbackTime = new Map<string, number>()  // Track when feedback was last sent

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
    let originalTask = ""  // The FIRST non-reflection user message
    let result = ""
    const tools: string[] = []

    for (const msg of messages) {
      // Get the FIRST user message as the original task
      if (msg.info?.role === "user") {
        for (const part of msg.parts || []) {
          if (part.type === "text" && part.text) {
            // Skip if this is a judge prompt - this is a judge session, not a user session
            if (part.text.includes("TASK VERIFICATION")) return null
            // Skip reflection feedback - we want the ORIGINAL task
            if (part.text.includes("## Reflection:")) continue
            // Only capture the first non-reflection user message as the task
            if (!originalTask) {
              originalTask = part.text
            }
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

    if (!originalTask || !result) return null
    return { task: originalTask, result, tools: tools.slice(-10).join("\n") }
  }

  // Poll for judge session response with timeout
  async function waitForJudgeResponse(client: any, sessionId: string, timeout: number): Promise<string | null> {
    const start = Date.now()

    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))

      try {
        const { data: messages } = await client.session.messages({ path: { id: sessionId } })
        if (!messages) continue

        // Find the last assistant message
        const assistantMsg = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
        if (!assistantMsg) continue

        // Check if assistant message is completed (has time.completed)
        if (!assistantMsg.info?.time?.completed) continue

        // Extract text from completed message
        for (const part of assistantMsg.parts || []) {
          if (part.type === "text" && part.text) {
            return part.text
          }
        }

        // Message completed but no text - might be an error
        if (assistantMsg.info?.error) {
          console.log(`[Reflection] Judge error: ${JSON.stringify(assistantMsg.info.error).slice(0, 200)}`)
          return null
        }
      } catch (e) {
        // Continue polling on error
      }
    }

    return null  // Timeout
  }

  async function judge(sessionId: string): Promise<void> {
    // Small delay to allow any concurrent session creations to register
    await new Promise(r => setTimeout(r, 100))
    
    // Skip if session was created by this plugin (it's a judge session)
    if (createdByPlugin.has(sessionId)) {
      return
    }
    // Skip if already completed, currently reflecting, or is a judge session
    if (completedSessions.has(sessionId)) {
      return
    }
    if (reflectingSessions.has(sessionId)) {
      return
    }
    if (judgeSessionIds.has(sessionId)) {
      return
    }
    
    // Cooldown: don't judge too soon after sending feedback
    const lastFeedback = lastFeedbackTime.get(sessionId)
    if (lastFeedback && Date.now() - lastFeedback < COOLDOWN_MS) {
      return
    }
    
    const attemptCount = attempts.get(sessionId) || 0
    if (attemptCount >= MAX_ATTEMPTS) {
      await showToast(`Max reflection attempts (${MAX_ATTEMPTS}) reached`, "warning")
      attempts.delete(sessionId)
      completedSessions.add(sessionId)  // Don't reflect again
      return
    }

    // Mark as currently reflecting to prevent concurrent reflections
    reflectingSessions.add(sessionId)
    console.log(`[Reflection] Starting judge for ${sessionId.slice(0, 20)}... (attempt ${attemptCount + 1})`)

    // Get session messages
    let messages: any[]
    try {
      const { data } = await client.session.messages({ path: { id: sessionId } })
      messages = data || []
      if (messages.length < 2) {
        reflectingSessions.delete(sessionId)
        return
      }
    } catch (e) {
      reflectingSessions.delete(sessionId)
      return
    }

    const extracted = extractFromMessages(messages)
    if (!extracted) {
      reflectingSessions.delete(sessionId)
      return
    }

    const agents = await getAgentsFile()

    // Create judge session
    const { data: judgeSession } = await client.session.create({})
    if (!judgeSession?.id) {
      reflectingSessions.delete(sessionId)
      return
    }

    // Track this session as created by the plugin - this is the FIRST line after creation
    // to catch any idle events that fire during the await above
    createdByPlugin.add(judgeSession.id)
    judgeSessionIds.add(judgeSession.id)
    completedSessions.add(judgeSession.id)
    console.log(`[Reflection] Starting reflection for ${sessionId.slice(0, 20)}... (judge: ${judgeSession.id.slice(0, 20)}...)`)

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
        // Mark as completed to prevent infinite retries on timeout
        completedSessions.add(sessionId)
        return
      }

      // Parse JSON response
      const jsonMatch = judgeText.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        await showToast("Failed to parse judge response", "error")
        // Mark as completed to prevent infinite retries on parse error
        completedSessions.add(sessionId)
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

        // Record when we sent feedback (cooldown starts now)
        lastFeedbackTime.set(sessionId, Date.now())

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
        // Task complete - mark as completed FIRST to prevent any race conditions
        // This must happen before any async operations to block concurrent idle events
        completedSessions.add(sessionId)
        attempts.delete(sessionId)
        lastFeedbackTime.delete(sessionId)

        // Task complete - only show toast, do NOT call prompt()
        // Calling prompt() on complete tasks creates an infinite loop:
        // agent responds → session.idle → reflection → "complete" → prompt() → agent responds → ...
        await showToast(`Task complete ✓ ${feedback.slice(0, 50)}...`, "success")
        console.log(`[Reflection] COMPLETE - task verified: ${feedback.slice(0, 100)}`)
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      await showToast(`Reflection error: ${errorMsg}`, "error")
      // Mark as completed to prevent infinite retries on error
      completedSessions.add(sessionId)
    } finally {
      judgeSessionIds.delete(judgeSession.id)
      reflectingSessions.delete(sessionId)
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionId = (event as any).properties?.sessionID
        // Ensure sessionId is a valid string and not a known judge session
        if (sessionId && typeof sessionId === "string") {
          if (judgeSessionIds.has(sessionId)) {
            // Don't log this - it's expected for judge sessions
            return
          }
          await judge(sessionId)
        }
      }
    }
  }
}

export default ReflectionPlugin
