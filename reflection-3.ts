/**
 * Reflection-3 Plugin for OpenCode
 *
 * Consolidated reflection layer that combines self-assessment with workflow checks.
 * Uses a dynamic prompt (task + workflow requirements) unless reflection.md overrides it.
 * Ensures tests/build/PR/CI checks are verified before completion.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { readFile, writeFile, mkdir, stat, appendFile } from "fs/promises"
import { join } from "path"
import { homedir } from "os"

// Lazy Sentry helper — reports errors without crashing if @sentry/node is unavailable
async function reportError(err: unknown, context?: Record<string, string>): Promise<void> {
  try {
    const Sentry = await import("@sentry/node")
    if (!Sentry.isInitialized()) return
    Sentry.captureException(err, context ? { tags: context } : undefined)
  } catch {}
}

const SELF_ASSESSMENT_MARKER = "## Reflection-3 Self-Assessment"
const FEEDBACK_MARKER = "## Reflection-3:"
const MAX_ATTEMPTS = 3

const JUDGE_BLOCKED_PATTERNS = [
  /\bhaiku\b/i,
  /\bmini\b/i,
  /\bnano\b/i,
  /\bflash\b/i,
  /\bgpt-3\.5\b/i,
  /\bllama-3\.1-8b\b/i,
  /\bmixtral-8x7b\b/i,
]

const PLANNING_LOOP_MIN_TOOL_CALLS = 8
const PLANNING_LOOP_WRITE_RATIO_THRESHOLD = 0.1
const ACTION_LOOP_MIN_COMMANDS = 4
const ACTION_LOOP_REPETITION_THRESHOLD = 0.6

type TaskType = "coding" | "docs" | "research" | "ops" | "other"
type AgentMode = "plan" | "build" | "unknown"
type RoutingCategory = "backend" | "architecture" | "frontend" | "default"

interface WorkflowRequirements {
  requiresTests: boolean
  requiresBuild: boolean
  requiresPR: boolean
  requiresCI: boolean
  requiresLocalTests: boolean
  requiresLocalTestsEvidence: boolean
}

interface TaskContext extends WorkflowRequirements {
  taskSummary: string
  taskType: TaskType
  agentMode: AgentMode
  humanMessages: string[]
  toolsSummary: string
  detectedSignals: string[]
  recentCommands: string[]
  pushedToDefaultBranch: boolean
}

interface SelfAssessment {
  task_summary?: string
  task_type?: string
  status?: "complete" | "in_progress" | "blocked" | "stuck" | "waiting_for_user"
  confidence?: number
  evidence?: {
    tests?: {
      ran?: boolean
      results?: "pass" | "fail" | "unknown"
      ran_after_changes?: boolean
      commands?: string[]
      skipped?: boolean
      skip_reason?: string
    }
    build?: {
      ran?: boolean
      results?: "pass" | "fail" | "unknown"
    }
    pr?: {
      created?: boolean
      url?: string
      ci_status?: "pass" | "fail" | "unknown"
      checked?: boolean
    }
  }
  remaining_work?: string[]
  next_steps?: string[]
  needs_user_action?: string[]
  stuck?: boolean
  alternate_approach?: string
}

interface ReflectionAnalysis {
  complete: boolean
  shouldContinue: boolean
  reason: string
  missing: string[]
  nextActions: string[]
  requiresHumanAction: boolean
  severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKER"
}

interface RoutingConfig {
  enabled: boolean
  models: Record<RoutingCategory, string>
}

interface ModelSpecParts {
  providerID: string
  modelID: string
}

const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  enabled: false,
  models: {
    backend: "",
    architecture: "",
    frontend: "",
    default: ""
  }
}

const JUDGE_RESPONSE_TIMEOUT = 120_000
const POLL_INTERVAL = 2_000
const ABORT_COOLDOWN = 10_000
const ABORT_RACE_DELAY = 1_500 // ms to wait for session.error to arrive before running reflection
const REFLECTION_CONFIG_PATH = join(homedir(), ".config", "opencode", "reflection.yaml")

// Debug logging — writes to .reflection/debug.log when REFLECTION_DEBUG=1.
// Never write to stdout/stderr — it corrupts the OpenCode TUI.
const REFLECTION_DEBUG = process.env.REFLECTION_DEBUG === "1"

// Module-level debug function, initially a no-op.
// Replaced with a file-backed logger once the plugin initializes with a directory.
let debug: (...args: any[]) => void = () => {}

function initDebugLogger(directory: string) {
  if (!REFLECTION_DEBUG) return
  const logPath = join(directory, ".reflection", "debug.log")
  let dirEnsured = false
  debug = (...args: any[]) => {
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")
    const ts = new Date().toISOString()
    const line = `[${ts}] [Reflection3] ${msg}\n`
    // Fire-and-forget: do not await to avoid slowing down the plugin
    ;(async () => {
      if (!dirEnsured) {
        try { await mkdir(join(directory, ".reflection"), { recursive: true }) } catch {}
        dirEnsured = true
      }
      try { await appendFile(logPath, line) } catch {}
    })()
  }
}

function isBlockedJudgeModel(modelSpec: string): boolean {
  const normalized = modelSpec.toLowerCase()
  return JUDGE_BLOCKED_PATTERNS.some((pattern) => pattern.test(normalized))
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
}

async function loadPreferredModelSpec(directory: string): Promise<string | null> {
  const candidates = [
    join(directory, "opencode.json"),
    join(directory, ".opencode", "opencode.json"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(directory, "opencode.jsonc"),
    join(directory, ".opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
  ]

  for (const path of candidates) {
    try {
      const content = await readFile(path, "utf-8")
      const parsed = JSON.parse(stripJsonComments(content))
      const model = parsed?.model
      if (typeof model === "string" && model.trim()) {
        return model.trim()
      }
    } catch {}
  }
  return null
}

async function loadReflectionPrompt(directory: string): Promise<string | null> {
  const candidates = [".reflection.md", ".reflection.MD", "reflection.md", "reflection.MD"]
  for (const name of candidates) {
    try {
      const reflectionPath = join(directory, name)
      const customPrompt = await readFile(reflectionPath, "utf-8")
      debug("Loaded custom prompt from", name)
      return customPrompt.trim()
    } catch {}
  }
  return null
}

function buildToolReflectionGuidanceSection(toolReflectionPrompt: string | null): string {
  if (!toolReflectionPrompt) return ""
  return `\n## Tool Reflection Guidance\n${toolReflectionPrompt.slice(0, 4000)}\n`
}

function resolveReflectionPromptPrecedence(
  filePrompt: string | null,
  toolReflectionPrompt: string | null,
  defaultPrompt: string
): { prompt: string; source: "file" | "tool" | "default"; effectiveToolReflectionPrompt: string | null } {
  if (filePrompt) {
    return {
      prompt: filePrompt,
      source: "file",
      effectiveToolReflectionPrompt: null
    }
  }
  if (toolReflectionPrompt) {
    return {
      prompt: `${defaultPrompt}${buildToolReflectionGuidanceSection(toolReflectionPrompt)}`,
      source: "tool",
      effectiveToolReflectionPrompt: toolReflectionPrompt
    }
  }
  return {
    prompt: defaultPrompt,
    source: "default",
    effectiveToolReflectionPrompt: null
  }
}

async function getAgentsFile(directory: string): Promise<string> {
  for (const name of ["AGENTS.md", ".opencode/AGENTS.md", "agents.md"]) {
    try {
      const content = await readFile(join(directory, name), "utf-8")
      return content
    } catch {}
  }
  return ""
}

function getMessageSignature(msg: any): string {
  if (msg.id) return msg.id
  const role = msg.info?.role || "unknown"
  const time = msg.info?.time?.start || 0
  const textPart = msg.parts?.find((p: any) => p.type === "text")?.text?.slice(0, 20) || ""
  return `${role}:${time}:${textPart}`
}

export function detectPlanningLoop(messages: any[]): {
  detected: boolean
  readCount: number
  writeCount: number
  totalTools: number
} {
  if (!Array.isArray(messages)) {
    return { detected: false, readCount: 0, writeCount: 0, totalTools: 0 }
  }
  let readCount = 0
  let writeCount = 0
  let totalTools = 0

  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue
    for (const part of msg.parts || []) {
      if (part.type !== "tool") continue
      totalTools++

      const toolName = (part.tool || "").toString().toLowerCase()
      const input = part.state?.input || {}

      if (["edit", "write", "apply_patch", "github_create_or_update_file", "github_push_files", "github_delete_file", "github_create_pull_request", "github_update_pull_request"].includes(toolName)) {
        writeCount++
        continue
      }

      if (toolName === "bash") {
        const cmd = (input.command || input.cmd || "").toString()
        if (/^\s*(npm|yarn|pnpm)\s+(run\s+)?(build|test|lint|fmt|format)\b/i.test(cmd) || /^\s*git\s+(add|commit|push|checkout|switch|merge|rebase)\b/i.test(cmd) || /^\s*(mkdir|rm|mv|cp)\b/i.test(cmd)) {
          writeCount++
        } else if (/^\s*git\s+(status|log|diff|show|branch|remote|tag)\b/i.test(cmd) || /^\s*(ls|cat|head|tail|find|grep|rg|wc|file)\b/i.test(cmd)) {
          readCount++
        }
        continue
      }

      if (["read", "glob", "grep", "todowrite", "task", "webfetch", "knowledge-graph_search", "knowledge-graph_read", "knowledge-graph_open"].some((name) => toolName.startsWith(name)) || toolName.startsWith("context7_")) {
        readCount++
      }
    }
  }

  const detected =
    totalTools >= PLANNING_LOOP_MIN_TOOL_CALLS &&
    (writeCount === 0 || writeCount / totalTools < PLANNING_LOOP_WRITE_RATIO_THRESHOLD)

  return { detected, readCount, writeCount, totalTools }
}

export function shouldApplyPlanningLoop(taskType: TaskType, loopDetected: boolean): boolean {
  if (!loopDetected) return false
  return taskType === "coding"
}

/**
 * Detects when the agent is repeating the same commands/actions without progress.
 * Unlike detectPlanningLoop (read-heavy without writes), this catches action loops
 * where the agent IS making write-like operations but repeating the same ones.
 * Example: repeatedly re-deploying and re-running the same failing evaluation.
 */
export function detectActionLoop(messages: any[]): {
  detected: boolean
  repeatedCommands: string[]
  totalCommands: number
} {
  if (!Array.isArray(messages)) {
    return { detected: false, repeatedCommands: [], totalCommands: 0 }
  }

  const commands: string[] = []
  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue
    for (const part of msg.parts || []) {
      if (part.type !== "tool") continue
      const toolName = (part.tool || "").toString().toLowerCase()
      const input = part.state?.input || {}

      if (toolName === "bash") {
        const cmd = (input.command || input.cmd || "").toString().trim()
        if (cmd) {
          // Normalize: collapse whitespace and remove trailing timestamps/IDs
          const normalized = cmd.replace(/\s+/g, " ").replace(/\d{10,}/g, "TIMESTAMP").toLowerCase()
          commands.push(normalized)
        }
      } else if (toolName !== "read" && toolName !== "glob" && toolName !== "grep" && toolName !== "todowrite") {
        // Track non-read tool calls by name + key input params
        const key = `${toolName}:${JSON.stringify(input).slice(0, 100)}`
        commands.push(key)
      }
    }
  }

  if (commands.length < ACTION_LOOP_MIN_COMMANDS) {
    return { detected: false, repeatedCommands: [], totalCommands: commands.length }
  }

  // Count occurrences of each command
  const counts = new Map<string, number>()
  for (const cmd of commands) {
    counts.set(cmd, (counts.get(cmd) || 0) + 1)
  }

  // Find commands repeated 3+ times
  const repeatedCommands: string[] = []
  let repeatedCount = 0
  for (const [cmd, count] of counts) {
    if (count >= 3) {
      repeatedCommands.push(cmd)
      repeatedCount += count
    }
  }

  // Loop detected if repeated commands make up a significant fraction
  const detected = repeatedCommands.length > 0 && repeatedCount / commands.length >= ACTION_LOOP_REPETITION_THRESHOLD

  return { detected, repeatedCommands, totalCommands: commands.length }
}

export function buildEscalatingFeedback(
  attemptCount: number,
  severity: string,
  verdict: { feedback?: string; missing?: string[]; next_actions?: string[] } | undefined | null,
  isPlanningLoop: boolean,
  isActionLoop?: boolean
): string {
  const safeVerdict = verdict ?? {}
  const missingItems = Array.isArray(safeVerdict.missing) ? safeVerdict.missing : []
  const nextActionItems = Array.isArray(safeVerdict.next_actions) ? safeVerdict.next_actions : []
  const feedbackStr = safeVerdict.feedback || ""
  if (isPlanningLoop) {
    return `${FEEDBACK_MARKER} STOP: Planning Loop Detected

You have been reading files, checking git status, and creating todo lists without writing any code.

DO NOT:
- Run git status or git log again
- Create another todo list
- Read more files "for context"
- Say "let me get right to work" without actually working

DO NOW:
Pick the FIRST item from your existing todo list and implement it. Open a file with Edit or Write and make changes. If you don't know where to start, create the simplest possible file first.

Start coding NOW. No more planning.`
  }

  if (isActionLoop) {
    return `${FEEDBACK_MARKER} STOP: Action Loop Detected (attempt ${attemptCount}/${MAX_ATTEMPTS})

You are repeating the same commands without making progress. Running the same deploy/test/build cycle again will produce the same result.

STOP and do ONE of these:
1. If the same test/eval keeps failing, analyze the failure output and fix the root cause before re-running.
2. If you cannot fix the root cause, explain what is blocking you and ask the user for help.
3. Try a completely different approach (e.g., test locally instead of via deployment).

Do NOT re-run the same command hoping for a different result.`
  }

  if (attemptCount <= 2) {
    const missing = missingItems.length
      ? `\n### Missing\n${missingItems.map((m) => `- ${m}`).join("\n")}`
      : ""
    const nextActions = nextActionItems.length
      ? `\n### Next Actions\n${nextActionItems.map((a) => `- ${a}`).join("\n")}`
      : ""
    return `${FEEDBACK_MARKER} Task Incomplete (${severity})
${feedbackStr}
${missing}
${nextActions}

Please address these issues and continue.`
  }

  const missingBrief = missingItems.length
    ? `Still missing: ${missingItems.slice(0, 3).join(", ")}.`
    : ""
  return `${FEEDBACK_MARKER} Final Attempt (${attemptCount}/${MAX_ATTEMPTS})

${missingBrief}

You have been asked ${attemptCount} times to complete this task. This is your LAST chance before reflection stops.

If you cannot complete the remaining items:
- Explain clearly what is blocking you
- Set needs_user_action if you need user help
- Try a different approach instead of repeating the same steps

Do NOT re-read files or re-plan. Either implement the fix now or explain why you cannot.`
}

function getLastRelevantUserMessageId(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === "user") {
      let isReflection = false
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          if (part.text.includes(SELF_ASSESSMENT_MARKER) || part.text.includes(FEEDBACK_MARKER)) {
            isReflection = true
            break
          }
        }
      }
      if (!isReflection) return getMessageSignature(msg)
    }
  }
  return null
}

function isJudgeSession(sessionId: string, messages: any[], judgeSessionIds: Set<string>): boolean {
  if (judgeSessionIds.has(sessionId)) return true
  for (const msg of messages) {
    for (const part of msg.parts || []) {
      if (part.type === "text" && (part.text?.includes("ANALYZE REFLECTION-3") || part.text?.includes("SELF-ASSESS REFLECTION-3") || part.text?.includes("REVIEW REFLECTION-3 COMPLETION"))) {
        return true
      }
    }
  }
  return false
}

export function isPlanMode(messages: any[]): boolean {
  if (!Array.isArray(messages)) return false
  // Check system/developer messages for plan mode indicators
  const hasSystemPlanMode = messages.some((m: any) =>
    (m.info?.role === "system" || m.info?.role === "developer") &&
    m.parts?.some((p: any) =>
      p.type === "text" &&
      p.text &&
      (p.text.includes("Plan Mode") ||
        p.text.includes("plan mode ACTIVE") ||
        p.text.includes("plan mode is active") ||
        p.text.includes("read-only mode") ||
        p.text.includes("READ-ONLY phase"))
    )
  )
  if (hasSystemPlanMode) return true

  // OpenCode injects plan mode as <system-reminder> inside user message parts.
  // Check ALL text parts of ALL messages for plan mode system-reminder patterns.
  for (const msg of messages) {
    for (const part of msg.parts || []) {
      if (part.type === "text" && part.text) {
        const text = part.text
        if (
          text.includes("<system-reminder>") &&
          (/plan mode/i.test(text) || /READ-ONLY phase/i.test(text))
        ) {
          return true
        }
      }
    }
  }

  // Check the last non-reflection user message for plan-related keywords
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === "user") {
      let isReflection = false
      const texts: string[] = []
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          if (part.text.includes(SELF_ASSESSMENT_MARKER)) {
            isReflection = true
            break
          }
          texts.push(part.text)
        }
      }
      if (!isReflection && texts.length > 0) {
        for (const text of texts) {
          if (/plan mode/i.test(text)) return true
          if (/\b(create|make|draft|generate|propose|write|update)\b.{1,30}\bplan\b/i.test(text)) return true
          if (/^plan\b/i.test(text.trim())) return true
        }
        return false
      }
    }
  }
  return false
}

async function showToast(client: any, directory: string, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
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

function parseModelListFromYaml(content: string): string[] {
  const models: string[] = []
  const lines = content.split(/\r?\n/)
  let inModels = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    if (/^models\s*:/i.test(line)) {
      inModels = true
      const inline = line.replace(/^models\s*:/i, "").trim()
      if (inline.startsWith("[") && inline.endsWith("]")) {
        const items = inline.slice(1, -1).split(",")
        for (const item of items) {
          const value = item.trim().replace(/^['"]|['"]$/g, "")
          if (value) models.push(value)
        }
        inModels = false
      }
      continue
    }

    if (inModels) {
      if (/^[\w-]+\s*:/.test(line)) {
        inModels = false
        continue
      }
      if (line.startsWith("-")) {
        const value = line.replace(/^-\s*/, "").trim().replace(/^['"]|['"]$/g, "")
        if (value) models.push(value)
      }
    }
  }

  return models
}

function parseRoutingFromYaml(content: string): RoutingConfig {
  const config: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG, models: { ...DEFAULT_ROUTING_CONFIG.models } }
  const lines = content.split(/\r?\n/)
  let inRouting = false
  let inRoutingModels = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    if (/^routing\s*:/i.test(line)) {
      inRouting = true
      continue
    }

    if (inRouting) {
      // Exit routing section when we hit a top-level key
      if (/^[a-zA-Z][\w-]*\s*:/.test(rawLine) && !rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
        inRouting = false
        inRoutingModels = false
        continue
      }

      if (/^\s*enabled\s*:\s*(true|false)/i.test(rawLine)) {
        config.enabled = /true/i.test(rawLine)
        continue
      }

      if (/^\s*models\s*:/i.test(rawLine)) {
        inRoutingModels = true
        continue
      }

      if (inRoutingModels) {
        // Exit models sub-section on a non-indented or non-model key
        if (/^\s{2,}[\w-]+\s*:/.test(rawLine) || /^\s+[\w-]+\s*:/.test(rawLine)) {
          const match = rawLine.match(/^\s+([\w-]+)\s*:\s*(.*)/)
          if (match) {
            const key = match[1].toLowerCase() as RoutingCategory
            const value = match[2].trim().replace(/^['"]|['"]$/g, "")
            if (key === "backend" || key === "architecture" || key === "frontend" || key === "default") {
              config.models[key] = value
            }
          }
        }
      }
    }
  }

  return config
}


function parseRoutingCategory(text: string | null | undefined): RoutingCategory | null {
  if (typeof text !== "string") return null
  const trimmed = text.trim()
  if (!trimmed) return null
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { category?: string }
      const value = (parsed.category || "").toLowerCase()
      if (value === "backend" || value === "architecture" || value === "frontend" || value === "default") {
        return value
      }
    } catch {}
  }
  const word = trimmed.split(/\s+/)[0]?.toLowerCase()
  if (word === "backend" || word === "architecture" || word === "frontend" || word === "default") {
    return word
  }
  return null
}

function parseModelSpec(modelSpec: string | null | undefined): ModelSpecParts | null {
  if (typeof modelSpec !== "string") return null
  const trimmed = modelSpec.trim()
  if (!trimmed) return null
  const parts = trimmed.split("/")
  if (parts.length < 2) return null
  const providerID = parts[0] || ""
  const modelID = parts.slice(1).join("/") || ""
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

function getGitHubCopilotModelForRouting(modelSpec: string | null | undefined): string | null {
  const parsed = parseModelSpec(modelSpec)
  if (!parsed) return null
  const providerID = parsed.providerID.toLowerCase()
  const modelID = parsed.modelID.toLowerCase()
  if (providerID === "github-copilot" || providerID === "github-copilot/free") {
    if (modelID.includes("gpt-4.1") || modelID.includes("gpt-4o") || modelID.includes("gpt-4")) {
      return "github-copilot/gpt-4.1"
    }
  }
  return null
}

function getCrossReviewModelSpec(modelSpec: string | null | undefined): string | null {
  const parsed = parseModelSpec(modelSpec)
  if (!parsed) return null
  const modelID = parsed.modelID.toLowerCase()
  if (modelID === "claude-opus-4.6") return "github-copilot/gpt-5.2-codex"
  if (modelID === "gpt-5.2-codex") return "github-copilot/claude-opus-4.6"
  return null
}

async function classifyTaskForRoutingWithLLM(
  client: any,
  directory: string,
  context: TaskContext,
  judgeSessionIds: Set<string>
): Promise<RoutingCategory | null> {
  const modelList = await loadReflectionModelList()
  const preferredModel = await loadPreferredModelSpec(directory)
  
  let attempts: string[] = []
  if (modelList.length) {
    attempts = modelList
  } else if (preferredModel) {
    const routingModel = getGitHubCopilotModelForRouting(preferredModel)
    if (routingModel && !isBlockedJudgeModel(routingModel)) {
      attempts = [routingModel]
    } else if (!isBlockedJudgeModel(preferredModel)) {
      attempts = [preferredModel]
    }
  }
  if (attempts.length === 0) attempts = [""]

  const prompt = `CLASSIFY TASK ROUTING\n\nYou are classifying a task into one routing category.\n\nTask summary:\n${context.taskSummary}\n\nTask type: ${context.taskType}\n\nRecent user messages:\n${context.humanMessages.slice(0, 4).join("\n\n")}\n\nChoose exactly one category from: backend, architecture, frontend, default.\nReturn JSON only:\n{\n  "category": "backend|architecture|frontend|default"\n}`

  for (const modelSpec of attempts) {
    let classifierSession: any
    try {
      const { data } = await client.session.create({ query: { directory } })
      classifierSession = data
    } catch {
      return null
    }
    if (!classifierSession?.id) return null
    judgeSessionIds.add(classifierSession.id)

    let response: string | null = null
    try {
      const modelParts = modelSpec ? modelSpec.split("/") : []
      const providerID = modelParts[0] || ""
      const modelID = modelParts.slice(1).join("/") || ""
      const body: any = { parts: [{ type: "text", text: prompt }] }
      if (providerID && modelID) body.model = { providerID, modelID }

      await client.session.promptAsync({
        path: { id: classifierSession.id },
        body
      })

      response = await waitForResponse(client, classifierSession.id)
    } catch (e) {
      reportError(e, { plugin: "reflection-3", op: "routing-classifier" })
      continue
    } finally {
      try {
        await client.session.delete({ path: { id: classifierSession.id }, query: { directory } })
      } catch {}
      judgeSessionIds.delete(classifierSession.id)
    }

    const category = parseRoutingCategory(response)
    if (category) return category
  }

  return null
}

async function loadRoutingConfig(): Promise<RoutingConfig> {
  try {
    const content = await readFile(REFLECTION_CONFIG_PATH, "utf-8")
    return parseRoutingFromYaml(content)
  } catch {
    return { ...DEFAULT_ROUTING_CONFIG, models: { ...DEFAULT_ROUTING_CONFIG.models } }
  }
}

function getRoutingModel(config: RoutingConfig, category: RoutingCategory | null): { providerID: string; modelID: string } | null {
  if (!category) return null
  if (!config.enabled) return null
  const modelSpec = config.models[category] || config.models["default"] || ""
  if (!modelSpec) return null
  const parts = modelSpec.split("/")
  const providerID = parts[0] || ""
  const modelID = parts.slice(1).join("/") || ""
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

async function loadReflectionModelList(): Promise<string[]> {
  try {
    const content = await readFile(REFLECTION_CONFIG_PATH, "utf-8")
    const models = parseModelListFromYaml(content)
    const filtered = models.filter((model) => {
      if (isBlockedJudgeModel(model)) {
        debug("Blocked weak reflection model:", model)
        return false
      }
      return true
    })
    if (filtered.length) debug("Loaded reflection model list:", JSON.stringify(filtered))
    return filtered
  } catch {
    return []
  }
}

async function ensureReflectionDir(directory: string): Promise<string> {
  const reflectionDir = join(directory, ".reflection")
  try {
    await mkdir(reflectionDir, { recursive: true })
  } catch {}
  return reflectionDir
}

async function writeVerdictSignal(directory: string, sessionId: string, complete: boolean, severity: string): Promise<void> {
  const reflectionDir = await ensureReflectionDir(directory)
  const signalPath = join(reflectionDir, `verdict_${sessionId.slice(0, 8)}.json`)
  const signal = {
    sessionId: sessionId.slice(0, 8),
    complete,
    severity,
    timestamp: Date.now()
  }
  try {
    await writeFile(signalPath, JSON.stringify(signal))
    debug("Wrote verdict signal:", signalPath)
  } catch (e) {
    debug("Failed to write verdict signal:", String(e))
    reportError(e, { plugin: "reflection-3", op: "write-verdict-signal" })
  }
}

async function saveReflectionData(directory: string, sessionId: string, data: any): Promise<void> {
  const reflectionDir = await ensureReflectionDir(directory)
  const filename = `${sessionId.slice(0, 8)}_${Date.now()}.json`
  const filepath = join(reflectionDir, filename)
  try {
    await writeFile(filepath, JSON.stringify(data, null, 2))
  } catch {}
}

async function waitForResponse(client: any, sessionId: string): Promise<string | null> {
  const start = Date.now()
  while (Date.now() - start < JUDGE_RESPONSE_TIMEOUT) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
    try {
      const { data } = await client.session.messages({ path: { id: sessionId } })
      const messages = Array.isArray(data) ? data : []
      const assistantMsg = [...messages].reverse().find((m: any) => m.info?.role === "assistant")
      if (!(assistantMsg?.info?.time as any)?.completed) continue
      for (const part of assistantMsg?.parts || []) {
        if (part.type === "text" && part.text) return part.text
      }
    } catch {}
  }
  return null
}

function inferTaskType(text: string): TaskType {
  const hasResearch = /research|investigate|analyze|compare|evaluate|study/i.test(text)
  const hasCodingAction = /\bfix\b|implement|add|create|build|feature|refactor|improve|update/i.test(text)
  const hasCodingSignal = /\bbug\b|\berror\b|\bregression\b/i.test(text)
  const hasGitHubIssue = /github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/i.test(text)

  // When text contains both research AND coding-action keywords (e.g. "investigate and fix this bug"),
  // or references a GitHub issue URL alongside research terms, prefer coding —
  // these are almost always coding tasks even if the description says "investigate".
  // Note: coding-signal words (bug, error, regression) alone don't override research,
  // because "investigate performance regressions" is legitimate research.
  if (hasResearch && (hasCodingAction || hasGitHubIssue)) return "coding"

  if (hasResearch) return "research"
  if (/docs?|readme|documentation/i.test(text)) return "docs"
  // Ops detection: explicit ops terms and personal-assistant / browser-automation patterns
  // Must be checked BEFORE coding to avoid "create filter" or "build entities" matching as coding
  if (/deploy|release|infra|ops|oncall|incident|runbook/i.test(text)) return "ops"
  if (/\bgmail\b|\bemail\b|\bfilter\b|\binbox\b|\bcalendar\b|\blinkedin\b|\brecruiter\b|\bbrowser\b/i.test(text)) return "ops"
  if (/\bclean\s*up\b|\borganize\b|\bconfigure\b|\bsetup\b|\bset\s*up\b|\binstall\b/i.test(text)) return "ops"
  if (hasCodingAction || hasCodingSignal) return "coding"
  return "other"
}

async function hasPath(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function getRepoSignals(directory: string): Promise<{ hasTestScript: boolean; hasBuildScript: boolean; hasTestsDir: boolean }>{
  let hasTestScript = false
  let hasBuildScript = false
  const packagePath = join(directory, "package.json")
  try {
    const content = await readFile(packagePath, "utf-8")
    const pkg = JSON.parse(content)
    const scripts = pkg?.scripts || {}
    hasTestScript = Boolean(scripts.test || scripts["test:ci"] || scripts["test:e2e"])
    hasBuildScript = Boolean(scripts.build || scripts["build:prod"])
  } catch {}

  const hasTestsDir = (await hasPath(join(directory, "test"))) || (await hasPath(join(directory, "tests")))
  return { hasTestScript, hasBuildScript, hasTestsDir }
}

function extractToolCommands(messages: any[]): string[] {
  const commands: string[] = []
  for (const msg of messages) {
    for (const part of msg.parts || []) {
      if (part.type === "tool" && part.tool === "bash") {
        const command = part.state?.input?.command
        if (typeof command === "string" && command.trim()) {
          commands.push(command)
        }
      }
    }
  }
  return commands
}

function detectSignals(humanText: string, commands: string[]): string[] {
  const signals: string[] = []
  if (/test|tests|pytest|jest|unit|e2e|integration/i.test(humanText)) signals.push("test-mention")
  if (/build|compile|bundle|release/i.test(humanText)) signals.push("build-mention")
  if (/pull request|\bPR\b|merge request/i.test(humanText)) signals.push("pr-mention")
  if (/ci|checks|github actions/i.test(humanText)) signals.push("ci-mention")

  if (commands.some(cmd => /\b(npm|pnpm|yarn)\s+test\b|pytest\b|go\s+test\b|cargo\s+test\b/i.test(cmd))) {
    signals.push("test-command")
  }
  if (commands.some(cmd => /\b(npm|pnpm|yarn)\s+run\s+build\b|cargo\s+build\b|go\s+build\b/i.test(cmd))) {
    signals.push("build-command")
  }
  if (commands.some(cmd => /\bgh\s+pr\b/i.test(cmd))) signals.push("gh-pr")
  if (commands.some(cmd => /\bgh\s+issue\b/i.test(cmd))) signals.push("gh-issue")
  if (commands.some(cmd => /\bgh\s+pr\s+create\b/i.test(cmd))) signals.push("gh-pr-create")
  if (commands.some(cmd => /\bgh\s+pr\s+view\b/i.test(cmd))) signals.push("gh-pr-view")
  if (commands.some(cmd => /\bgh\s+pr\s+status\b/i.test(cmd))) signals.push("gh-pr-status")
  if (commands.some(cmd => /\bgh\s+pr\s+checks\b/i.test(cmd))) signals.push("gh-pr-checks")
  if (commands.some(cmd => /\bgit\s+push\b/i.test(cmd))) signals.push("git-push")
  return signals
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim()
}

function getRecentCommands(commands: string[], limit = 20): string[] {
  return commands.map(normalizeCommand).slice(-limit)
}

function hasLocalTestCommand(commands: string[]): boolean {
  return commands.some(cmd =>
    /\bnpm\s+test\b/i.test(cmd) ||
    /\bnpm\s+run\s+test\b/i.test(cmd) ||
    /\bnpm\s+run\s+typecheck\b/i.test(cmd) ||
    /\bpnpm\s+test\b/i.test(cmd) ||
    /\byarn\s+test\b/i.test(cmd) ||
    /\bpytest\b/i.test(cmd) ||
    /\bgo\s+test\b/i.test(cmd) ||
    /\bcargo\s+test\b/i.test(cmd)
  )
}

function pushedToDefaultBranch(commands: string[]): boolean {
  return commands.some(cmd =>
    /\bgit\s+push\b.*\b(main|master)\b/i.test(cmd) ||
    /\bgit\s+push\b.*\borigin\b\s+\b(main|master)\b/i.test(cmd) ||
    /\bgit\s+push\b.*\bHEAD:(main|master)\b/i.test(cmd)
  )
}

async function buildTaskContext(messages: any[], directory: string): Promise<TaskContext | null> {
  if (!Array.isArray(messages)) return null
  const humanMessages: string[] = []
  let lastAssistantText = ""

  for (const msg of messages) {
    if (msg.info?.role === "user") {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          if (part.text.includes(SELF_ASSESSMENT_MARKER) || part.text.includes(FEEDBACK_MARKER)) continue
          humanMessages.push(part.text)
          break
        }
      }
    }
    if (msg.info?.role === "assistant") {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) {
          lastAssistantText = part.text
        }
      }
    }
  }

  if (humanMessages.length === 0) return null

  const taskSummary = humanMessages.length === 1
    ? humanMessages[0]
    : humanMessages.map((msg, i) => `[${i + 1}] ${msg}`).join("\n\n")

  const combinedText = `${humanMessages.join(" ")} ${lastAssistantText}`
  const taskType = inferTaskType(combinedText)
  const agentMode: AgentMode = isPlanMode(messages) ? "plan" : "build"

  const repoSignals = await getRepoSignals(directory)
  const commands = extractToolCommands(messages)
  const detectedSignals = detectSignals(combinedText, commands)
  const recentCommands = getRecentCommands(commands)
  const hasLocalTests = hasLocalTestCommand(commands)
  const pushedDefault = pushedToDefaultBranch(commands)

  const requiresTests = taskType === "coding" && (repoSignals.hasTestScript || repoSignals.hasTestsDir || detectedSignals.includes("test-mention"))
  const requiresBuild = taskType === "coding" && (repoSignals.hasBuildScript || detectedSignals.includes("build-mention"))
  // PR and CI are only required for coding tasks; ops/personal-assistant tasks don't need them
  const requiresPR = taskType === "coding"
  const requiresCI = taskType === "coding"
  const requiresLocalTests = requiresTests
  const requiresLocalTestsEvidence = requiresTests && !hasLocalTests

  const toolsSummary = commands.slice(-6).join("\n") || "(none)"

  return {
    taskSummary,
    taskType,
    agentMode,
    humanMessages,
    toolsSummary,
    detectedSignals,
    recentCommands,
    pushedToDefaultBranch: pushedDefault,
    requiresTests,
    requiresBuild,
    requiresPR,
    requiresCI,
    requiresLocalTests,
    requiresLocalTestsEvidence
  }
}

function extractLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info?.role === "assistant") {
      for (const part of msg.parts || []) {
        if (part.type === "text" && part.text) return part.text
      }
    }
  }
  return ""
}

function buildSelfAssessmentPrompt(
  context: TaskContext,
  agents: string,
  lastAssistantText?: string,
  attemptCount?: number
): string {
  const safeContext = {
    ...context,
    detectedSignals: Array.isArray(context.detectedSignals) ? context.detectedSignals : []
  }
  const requirements: string[] = []
  if (safeContext.requiresTests) requirements.push("Tests required (run after latest changes)")
  if (safeContext.requiresBuild) requirements.push("Build/compile required")
  if (safeContext.requiresPR) requirements.push("PR required (include link)")
  if (safeContext.requiresCI) requirements.push("CI checks required (verify status)")
  if (safeContext.requiresLocalTests) requirements.push("Local tests required (must run in this session)")
  if (safeContext.pushedToDefaultBranch) requirements.push("Detected direct push to default branch (must be avoided)")
  if (requirements.length === 0) requirements.push("No explicit workflow gates detected")

  const signalSummary = safeContext.detectedSignals.length ? safeContext.detectedSignals.join(", ") : "none"

  const assistantSection = lastAssistantText
    ? `\n## Agent's Last Response\n${lastAssistantText.slice(0, 4000)}\n`
    : ""

  const currentAttempt = attemptCount || 0
  const attemptSection = currentAttempt > 0
    ? `\n## Reflection History\n- This is reflection attempt ${currentAttempt + 1}/${MAX_ATTEMPTS} for this task.\n- Previous reflections found the task incomplete.\n- If you are repeating the same actions without progress, set "stuck": true and explain what is blocking you.\n`
    : ""
  return `SELF-ASSESS REFLECTION-3

You are evaluating an agent's work against workflow requirements.
Analyze the task context, the agent's last response, and the tool signals to determine whether the task is complete.

## Task Context
- Summary: ${safeContext.taskSummary}
- Type: ${safeContext.taskType}
- Mode: ${safeContext.agentMode}
- Required checks: ${requirements.join("; ")}
- Detected signals: ${signalSummary}

## Tool Commands Run
${safeContext.toolsSummary}
${assistantSection}${attemptSection}
${agents ? `## Project Instructions\n${agents.slice(0, 800)}\n\n` : ""}Return JSON only:
{
  "task_summary": "brief description of what was done",
  "task_type": "feature|bugfix|refactor|docs|research|ops|other",
  "status": "complete|in_progress|blocked|stuck|waiting_for_user",
  "confidence": 0.95,
  "evidence": {
    "tests": { 
      "ran": true,
      "results": "pass|fail|unknown",
      "ran_after_changes": true,
      "commands": ["npm test", "pytest"]
    },
    "build": { 
      "ran": true,
      "results": "pass|fail|unknown"
    },
    "pr": { 
      "created": true,
      "url": "https://github.com/...",
      "ci_status": "pass|fail|unknown",
      "checked": true
    }
  },
  "remaining_work": ["list any incomplete items"],
  "next_steps": ["list next actions needed"],
  "needs_user_action": ["list any actions requiring user input"],
  "stuck": false,
  "alternate_approach": "describe if needed"
}

Rules:
- If coding work is complete, confirm tests ran after the latest changes and passed.
- If local tests are required, provide the exact commands run in this session.
- If PR exists, verify CI checks and report status.
- Tests cannot be skipped or marked as flaky/not important.
- Direct pushes to main/master are not allowed; require a PR instead.
- If stuck, propose an alternate approach.
- If you need user action (auth, 2FA, credentials, access requests, uploads, approvals), list it in needs_user_action.
- PLANNING LOOP CHECK: If the task requires code changes (fix, implement, add, create, build, refactor, update) but the "Tool Commands Run" section shows ONLY read operations (read, glob, grep, git log, git status, git diff, webfetch, task/explore) and NO write operations (edit, write, bash with build/test/commit, github_create_pull_request, etc.), then the task is NOT complete. Set status to "in_progress", set stuck to true, and list "Implement the actual code changes" in remaining_work. Analyzing and recommending changes is not the same as making them.
- If you are repeating the same actions (deploy, test, build) without making progress, set "stuck": true.
- Do not retry the same failing approach more than twice — try something different or report stuck.

PREMATURE-STOP ANTIPATTERNS (mined from 227 real agent stops where the user replied; 78% were premature — the user said "go"/"continue"/"yes do it" or corrected the agent). If the agent's last response matches one of these AND executable work remains, the task is NOT complete — set status "in_progress", and put the concrete next action in remaining_work and next_steps:
- PERMISSION-SEEKING (most common, ~40%): the response ends by asking to do work it can already do — "Want me to…?", "Would you like me to…?", "Should I…?", "Shall I proceed?", or "Try running it now"/"Please run X and confirm" (deferring a check it could run itself). DECISIVE TEST: if the final turn is a yes/no or "want me to X?" question AND X is something the agent can do with its own tools AND X carries no irreversible risk, the stop is premature — it should have just done X. Asking is only legitimate before a destructive/irreversible action (delete prod data, force-push, send an irreversible external message).
- STOPPED-WITH-TODOS (~30%): the response lists "Remaining Tasks"/"Next steps"/"Still TODO"/"What I did NOT do" or names a verify/run/check/create-PR step as "next" — then stops without doing it. Listing remaining work does not complete it; a self-contained named step must be DONE before stopping. Set status "in_progress" with that work in remaining_work.
- FALSE-COMPLETE: claims "done"/"complete"/"ready"/"all tasks complete" but the CORE requested action never happened, a required check was skipped, or there is no evidence. An empty/no-text response, or a response with no write/tool evidence on an action task, is NEVER complete. For an "add a <feature/system>" task, writing files is necessary but NOT sufficient — the new code must be WIRED IN (imported/registered/routed, not orphaned modules) AND verified (test/build/run); "ready to use" with no integration is incomplete (status "in_progress").
- LEGITIMATE STOP (do NOT flag): genuine human-only block (OAuth consent, 2FA code, credential/API-key retrieval, captcha) → status "waiting_for_user" with the item in needs_user_action. Genuine completion WITH evidence (commands+output, tests passing, PR/CI verified) → status "complete"; do not invent missing work.
- SEVERITY/STUCK: a single recoverable technical snag mid-task (knows the fix) is not "stuck". But a policy/process violation — pushing to main when a PR was required, skipping mandated tests — is a real failure: status "in_progress" with the corrective action in remaining_work, never "complete".`
}

function parseSelfAssessmentJson(text: string | null | undefined): SelfAssessment | null {
  if (typeof text !== "string") return null
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    return JSON.parse(jsonMatch[0]) as SelfAssessment
  } catch (e) {
    reportError(e, { plugin: "reflection-3", op: "parse-self-assessment" })
    return null
  }
}

const HUMAN_ONLY_ACTION_PATTERNS: RegExp[] = [
  /\b(auth|authentication|oauth|2fa|mfa|captcha|otp|one[- ]time)\b/i,
  /\b(log ?in|sign ?in|verification code|passcode)\b/i,
  /\b(api key|secret|token|credential|access key|session cookie)\b/i,
  /\b(permission|consent|approve|approval|access request|request access|grant access|invite)\b/i,
  /\bupload\b/i
]

const AGENT_ACTION_PATTERNS: RegExp[] = [
  /\b(run|re-?run|execute|test|build|compile|lint|format|commit|push|merge|pr|ci|check)\b/i,
  /\b(gh|npm|node|python|bash|curl|script)\b/i,
  /\b(edit|write|update|fix|implement|add|remove|change|create|open|verify|capture|screenshot|record)\b/i
]

function isHumanOnlyAction(item: string): boolean {
  const text = item.trim()
  if (!text) return false
  const hasHuman = HUMAN_ONLY_ACTION_PATTERNS.some(pattern => pattern.test(text))
  const hasAgent = AGENT_ACTION_PATTERNS.some(pattern => pattern.test(text))
  return hasHuman && !hasAgent
}

function splitActionItems(items: string[]): { humanOnly: string[]; agentActionable: string[] } {
  const humanOnly: string[] = []
  const agentActionable: string[] = []
  for (const raw of items) {
    if (typeof raw !== "string") continue
    const item = raw.trim()
    if (!item) continue
    if (isHumanOnlyAction(item)) humanOnly.push(item)
    else agentActionable.push(item)
  }
  return { humanOnly, agentActionable }
}

function evaluateSelfAssessment(assessment: SelfAssessment, context: TaskContext): ReflectionAnalysis {
  const safeContext: TaskContext = {
    taskSummary: context?.taskSummary || "",
    taskType: context?.taskType || "other",
    agentMode: context?.agentMode || "unknown",
    humanMessages: Array.isArray(context?.humanMessages) ? context.humanMessages : [],
    toolsSummary: context?.toolsSummary || "(none)",
    detectedSignals: Array.isArray(context?.detectedSignals) ? context.detectedSignals : [],
    recentCommands: Array.isArray(context?.recentCommands) ? context.recentCommands : [],
    pushedToDefaultBranch: !!context?.pushedToDefaultBranch,
    requiresTests: !!context?.requiresTests,
    requiresBuild: !!context?.requiresBuild,
    requiresPR: !!context?.requiresPR,
    requiresCI: !!context?.requiresCI,
    requiresLocalTests: !!context?.requiresLocalTests,
    requiresLocalTestsEvidence: !!context?.requiresLocalTestsEvidence
  }
  const missing: string[] = []
  const nextActions: string[] = []
  const remaining = assessment.remaining_work || []
  const needsUserAction = assessment.needs_user_action || []
  const status = assessment.status || "in_progress"
  const confidence = assessment.confidence ?? 0.5
  const stuck = assessment.stuck === true

  const tests = assessment.evidence?.tests || {}
  const build = assessment.evidence?.build || {}
  const pr = assessment.evidence?.pr || {}
  const hasPrSignal = safeContext.detectedSignals.includes("gh-pr-create") || safeContext.detectedSignals.includes("gh-pr")
  const hasCiSignal = safeContext.detectedSignals.includes("gh-pr-checks") || safeContext.detectedSignals.includes("gh-pr-view") || safeContext.detectedSignals.includes("gh-pr-status")

  const addMissing = (item: string, action?: string) => {
    if (!missing.includes(item)) missing.push(item)
    if (action && !nextActions.includes(action)) nextActions.push(action)
  }

  if (remaining.length) {
    for (const item of remaining) addMissing(item)
  }

  const { humanOnly: humanNeeds, agentActionable: agentNeeds } = splitActionItems(needsUserAction)
  if (agentNeeds.length) {
    for (const item of agentNeeds) {
      addMissing(item)
      if (!nextActions.includes(item)) nextActions.push(item)
    }
  }

  if (safeContext.requiresTests) {
    if (tests.ran !== true) {
      addMissing("Run tests", "Run the full test suite and capture output")
    } else {
      if (tests.skipped === true || typeof tests.skip_reason === "string") {
        addMissing("Do not skip required tests", "Run required tests and document passing results")
      }
      if (tests.results !== "pass") {
        addMissing("Fix failing tests", "Fix failing tests and re-run")
      }
      if (tests.ran_after_changes !== true) {
        addMissing("Re-run tests after latest changes", "Re-run tests after latest changes")
      }
    }
  }

  if (safeContext.requiresLocalTests) {
    const ranCommands = tests.commands || []
    if (ranCommands.length === 0) {
      addMissing("Provide local test commands", "Run local tests and include commands in self-assessment")
    } else {
      const normalizedRecent = safeContext.recentCommands.map(normalizeCommand)
      const normalizedEvidence = ranCommands.map(normalizeCommand)
      const hasMatch = normalizedEvidence.some(cmd => normalizedRecent.includes(cmd))
      if (!hasMatch) {
        addMissing("Provide local test commands from this session", "Run local tests in this session and include exact commands")
      }
    }
  }

  if (safeContext.requiresBuild) {
    if (build.ran !== true) {
      addMissing("Run build/compile", "Run the build/compile step and confirm success")
    } else if (build.results !== "pass") {
      addMissing("Fix build failures", "Fix build errors and re-run")
    }
  }

  if (safeContext.requiresPR) {
    if (pr.created !== true) {
      addMissing("Create PR", "Create a pull request with summary and checklist")
    } else if (safeContext.requiresCI) {
      if (!pr.url) {
        addMissing("Provide PR link", "Include the PR URL in the self-assessment")
      }
      if (!hasPrSignal) {
        addMissing("Provide PR creation evidence", "Create the PR using gh or include evidence of PR creation")
      }
      if (pr.checked !== true) {
        addMissing("Verify CI checks", "Run `gh pr checks` or `gh pr view` and report results")
      } else if (pr.ci_status !== "pass") {
        addMissing("Fix failing CI", "Fix CI failures and re-run checks")
      }
      if (!hasCiSignal) {
        addMissing("Provide CI check evidence", "Use `gh pr checks` or `gh pr view` and include results")
      }
    }
  }

  if (safeContext.pushedToDefaultBranch) {
    addMissing("Avoid direct push to default branch", "Revert direct push and open a PR instead")
  }

  if (stuck) {
    addMissing("Rethink approach", "Propose an alternate approach and continue")
  }

  const humanOnlyNextSteps = (assessment.next_steps || []).filter(item => isHumanOnlyAction(item))
  const requiresHumanAction = humanNeeds.length > 0 || humanOnlyNextSteps.length > 0 || missing.some(isHumanOnlyAction) || nextActions.some(isHumanOnlyAction)
  const complete = status === "complete" && missing.length === 0 && confidence >= 0.8 && !requiresHumanAction

  let severity: ReflectionAnalysis["severity"] = "NONE"
  const severityItems = missing.length > 0 ? missing : nextActions
  if (severityItems.some(item => /test|build/i.test(item))) severity = "HIGH"
  else if (severityItems.some(item => /CI|check/i.test(item))) severity = "MEDIUM"
  else if (severityItems.length > 0) severity = "LOW"

  if (requiresHumanAction && missing.length === 0 && nextActions.length === 0) severity = "LOW"

  if (assessment.next_steps?.length) {
    for (const step of assessment.next_steps) {
      if (!nextActions.includes(step)) nextActions.push(step)
    }
  }

  const actionableMissing = missing.filter(item => !isHumanOnlyAction(item))
  const finalActionableNextActions = nextActions.filter(item => !isHumanOnlyAction(item))
  const finalShouldContinue = actionableMissing.length > 0 || finalActionableNextActions.length > 0
  const finalReason = complete
    ? "Self-assessment confirms completion with required evidence"
    : requiresHumanAction && !finalShouldContinue
      ? "User action required before continuing"
      : missing.length || finalActionableNextActions.length
        ? "Missing required workflow steps"
        : "Task not confirmed complete"

  return {
    complete,
    shouldContinue: finalShouldContinue,
    reason: finalReason,
    missing,
    nextActions,
    requiresHumanAction,
    severity
  }
}

async function analyzeSelfAssessmentWithLLM(
  client: any,
  directory: string,
  context: TaskContext,
  selfAssessment: string,
  judgeSessionIds: Set<string>,
  toolReflectionPrompt?: string | null
): Promise<ReflectionAnalysis | null> {
  const modelList = await loadReflectionModelList()
  const preferredModel = await loadPreferredModelSpec(directory)
  const attempts = modelList.length
    ? modelList
    : preferredModel && !isBlockedJudgeModel(preferredModel)
      ? [preferredModel]
      : [""]

  const prompt = `ANALYZE REFLECTION-3

You are validating an agent's self-assessment against workflow requirements.

## Task Summary
${context.taskSummary}

## Task Type
${context.taskType}

## Workflow Requirements
- Tests required: ${context.requiresTests}
- Build required: ${context.requiresBuild}
- PR required: ${context.requiresPR}
- CI checks required: ${context.requiresCI}
- Local test commands required: ${context.requiresLocalTests}

## Tool Signals
${context.toolsSummary}

## Agent Self-Assessment
${selfAssessment.slice(0, 4000)}
${buildToolReflectionGuidanceSection(toolReflectionPrompt || null)}

Rules:
- If tests are required, agent must confirm tests ran AFTER latest changes and passed.
- If local test commands are required, agent must list the exact commands run in this session.
- If tests were skipped/flaky/not important, task is incomplete.
- Direct pushes to main/master are not allowed; require PR instead.
- If PR required, agent must provide PR link.
- If PR exists, CI checks must be verified and passing.
- If user action is required (auth/2FA/credentials), set requires_human_action true.
- If agent is stuck, require alternate approach and continued work.
- PLANNING LOOP: If the task requires code changes (fix, implement, add, create, build, refactor) but the Tool Signals show ONLY read operations (read, glob, grep, git log/status/diff, webfetch) and NO write operations (edit, write, bash with build/test/commit, PR creation), set complete to false and add "Implement actual code changes" to missing. Analysis alone does not fulfill an implementation task.
- PREMATURE-STOP ANTIPATTERNS (78% of real agent stops were premature). Set complete false, requires_human_action false, and put the concrete work in next_actions when the agent's response matches:
  - PERMISSION-SEEKING: ends asking to do work it can already do ("Want me to…?", "Should I…?", "Try running it now", "Please run X and confirm"). DECISIVE TEST: final-turn yes/no question about something the agent can do with its own tools and no irreversible risk = premature; it should have done it. Includes "finished step N, asking which sub-task to do next" when the task named the work. Asking is legitimate only before destructive/irreversible actions, or when the task explicitly scoped the deliverable to just the part already done.
  - STOPPED-WITH-TODOS: lists "Remaining Tasks"/"Next steps"/"What I did NOT do" or names a verify/run/check step as next, then stops. Listing ≠ doing.
  - FALSE-COMPLETE: claims done/ready/"all tasks complete" but the core action never happened, a required check was skipped, or no evidence. Empty/no-tool response on an action task is never complete. For an "add a <feature/system>" task, written files alone are not enough — code must be wired in (imported/registered/routed) AND verified; "ready to use" with no integration is incomplete.
- LEGITIMATE STOP (do NOT penalize): genuine human-only block (OAuth consent, 2FA, credential/API-key retrieval, captcha) → complete false, requires_human_action true. Genuine completion WITH evidence → complete true; do not invent missing work.
- SEVERITY: a single recoverable technical snag mid-task is LOW/MEDIUM; a repeated retry loop, broken functionality, or red CI is HIGH; a policy/process violation (push to main when a PR was required, skipping mandated tests) is HIGH; a confirmed security/auth/data-loss/prod defect is BLOCKER.

Return JSON only:
{
  "complete": true/false,
  "severity": "NONE|LOW|MEDIUM|HIGH|BLOCKER",
  "feedback": "brief explanation",
  "missing": ["missing steps"],
  "next_actions": ["actions to take"],
  "requires_human_action": true/false
}`

  for (const modelSpec of attempts) {
    let judgeSession: any
    try {
      const { data } = await client.session.create({ query: { directory } })
      judgeSession = data
    } catch {
      return null
    }
    if (!judgeSession?.id) return null
    judgeSessionIds.add(judgeSession.id)

    try {
      const modelParts = modelSpec ? modelSpec.split("/") : []
      const providerID = modelParts[0] || ""
      const modelID = modelParts.slice(1).join("/") || ""

      const body: any = { parts: [{ type: "text", text: prompt }] }
      if (providerID && modelID) body.model = { providerID, modelID }

      await client.session.promptAsync({
        path: { id: judgeSession.id },
        body
      })

      const response = await waitForResponse(client, judgeSession.id)
      if (!response) continue

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) continue

      const verdict = JSON.parse(jsonMatch[0]) as any
      const missing = Array.isArray(verdict.missing) ? verdict.missing : []
      const humanOnlyMissing = missing.filter((item: string) => isHumanOnlyAction(item))
      const actionableMissing = missing.filter((item: string) => !isHumanOnlyAction(item))
      const actionableNextActions = Array.isArray(verdict.next_actions)
        ? verdict.next_actions.filter((item: string) => typeof item === "string" && !isHumanOnlyAction(item))
        : []
      const shouldContinue = !verdict.complete && (actionableMissing.length > 0 || actionableNextActions.length > 0)
      const requiresHumanAction = !!verdict.requires_human_action || humanOnlyMissing.length > 0
      return {
        complete: !!verdict.complete,
        shouldContinue,
        reason: verdict.feedback || "Judge analysis completed",
        missing,
        nextActions: Array.isArray(verdict.next_actions) ? verdict.next_actions : [],
        requiresHumanAction,
        severity: verdict.severity || "MEDIUM"
      }
    } catch (e) {
      reportError(e, { plugin: "reflection-3", op: "judge-session" })
      continue
    } finally {
      try {
        await client.session.delete({ path: { id: judgeSession.id }, query: { directory } })
      } catch {}
      judgeSessionIds.delete(judgeSession.id)
    }
  }

  return null
}

async function runCrossModelReview(
  client: any,
  directory: string,
  context: TaskContext,
  selfAssessment: string,
  analysis: ReflectionAnalysis,
  lastAssistantText: string,
  assessmentModelSpec: string | null,
  judgeSessionIds: Set<string>,
  toolReflectionPrompt?: string | null
): Promise<{ modelSpec: string; response: string } | null> {
  const crossModelSpec = getCrossReviewModelSpec(assessmentModelSpec)
  if (!crossModelSpec) return null

  debug("Starting cross-model review session with model:", crossModelSpec)

  let reviewSession: any
  try {
    const { data } = await client.session.create({ query: { directory } })
    reviewSession = data
  } catch {
    debug("Failed to create cross-review session")
    return null
  }
  if (!reviewSession?.id) return null
  judgeSessionIds.add(reviewSession.id)

  const prompt = `REVIEW REFLECTION-3 COMPLETION

You are reviewing another model's completion verdict for an agent task.
Provide a concise critique and reflection:
- Does the self-assessment evidence justify completion?
- Any missing workflow gates (tests/build/PR/CI)?
- Any inconsistencies between tool signals and the agent's claim?
- Provide a short reflection: what could have been stronger?

## Task Summary
${context.taskSummary}

## Task Type
${context.taskType}

## Tool Signals
${context.toolsSummary}

## Agent Last Response
${lastAssistantText.slice(0, 2000)}

## Self-Assessment
${selfAssessment.slice(0, 3000)}
${buildToolReflectionGuidanceSection(toolReflectionPrompt || null)}

## Reflection Analysis Verdict
${JSON.stringify(analysis, null, 2)}

Return a short paragraph plus bullet list of any gaps.`

  try {
    const modelParts = parseModelSpec(crossModelSpec)
    const body: any = { parts: [{ type: "text", text: prompt }] }
    if (modelParts) body.model = modelParts

    await client.session.promptAsync({
      path: { id: reviewSession.id },
      body
    })

    const response = await waitForResponse(client, reviewSession.id)
    if (!response) return null
    return { modelSpec: crossModelSpec, response }
  } catch (e) {
    reportError(e, { plugin: "reflection-3", op: "cross-review" })
    return null
  } finally {
    try {
      await client.session.delete({ path: { id: reviewSession.id }, query: { directory } })
    } catch {}
    judgeSessionIds.delete(reviewSession.id)
  }
}

export const Reflection3Plugin: Plugin = async ({ client, directory }) => {
  initDebugLogger(directory)
  const judgeSessionIds = new Set<string>()
  const lastReflectedMsgId = new Map<string, string>()
  const activeReflections = new Set<string>()
  const recentlyAbortedSessions = new Map<string, number>()
  const attempts = new Map<string, number>()
  let toolReflectionPrompt: string | null = null
  let currentSessionId: string | null = null  // tracks most recent active session for the toggle tool

  const disabledFlagPath = join(directory, '.reflection', 'disabled')

  async function isSessionDisabled(sessionId: string): Promise<boolean> {
    try {
      const content = await readFile(disabledFlagPath, 'utf8')
      return content.split('\n').map(l => l.trim()).filter(Boolean).includes(sessionId)
    } catch { return false }
  }

  async function setSessionDisabled(sessionId: string, disabled: boolean): Promise<void> {
    let lines: string[] = []
    try {
      const content = await readFile(disabledFlagPath, 'utf8')
      lines = content.split('\n').map(l => l.trim()).filter(Boolean)
    } catch {}
    if (disabled) {
      if (!lines.includes(sessionId)) lines.push(sessionId)
    } else {
      lines = lines.filter(l => l !== sessionId)
    }
    await mkdir(join(directory, '.reflection'), { recursive: true })
    await writeFile(disabledFlagPath, lines.join('\n') + (lines.length ? '\n' : ''))
  }

  const setReflectionDescription = "Use this for difficult or complex tasks to set reflection guidance with a plan/checklist. Provide concrete steps and verification checks so reflection can validate completion quality and catch missed work."
  const executeSetReflection = async (args: { guidance?: string; clear?: boolean }) => {
    if (args.clear) {
      toolReflectionPrompt = null
      return "Cleared tool-provided reflection guidance. Reflection now uses file override (.reflection.md/reflection.md) or default prompt."
    }
    const guidance = (args.guidance || "").trim()
    if (!guidance) {
      if (!toolReflectionPrompt) {
        return "No tool-provided reflection guidance is set."
      }
      return `Current tool-provided reflection guidance:\n${toolReflectionPrompt}`
    }
    toolReflectionPrompt = guidance
    const msg = "Set tool-provided reflection guidance for this runtime. It will be used when no .reflection.md/reflection.md file override exists."
    if (guidance.length > 4000) return `${msg}\n\nNote: guidance exceeds 4000 chars and will be truncated when applied to reflection prompts.`
    return msg
  }

  // reflection on/off toggle tool (session-scoped: only affects the current session's ID)
  const reflectionToggleDescription = "Enable or disable the reflection judge for the current session. 'off' adds this session's ID to .reflection/disabled so the judge skips it; 'on' removes it. Other sessions and other running instances are unaffected."
  const executeReflectionToggle = async (args: { action: "on" | "off" }) => {
    const sid = currentSessionId
    if (!sid) return "No active session tracked yet — wait for the first session.idle event, then try again."
    await setSessionDisabled(sid, args.action === "off")
    return args.action === "off"
      ? `Reflection disabled for session ${sid.slice(0, 8)}… (added to .reflection/disabled).`
      : `Reflection enabled for session ${sid.slice(0, 8)}… (removed from .reflection/disabled).`
  }

  let setReflectionTool: any = null
  let reflectionToggleTool: any = null
  try {
    const { tool } = await import("@opencode-ai/plugin/tool")
    setReflectionTool = tool({
      description: setReflectionDescription,
      args: {
        guidance: tool.schema.string().optional().describe("Reflection guidance. Include a concise plan/checklist for complex work and evidence expectations."),
        clear: tool.schema.boolean().optional().describe("Set true to clear the current tool-provided reflection guidance.")
      },
      execute: executeSetReflection
    })
    reflectionToggleTool = tool({
      description: reflectionToggleDescription,
      args: {
        action: tool.schema.string().describe("'on' to enable reflection, 'off' to disable it for this project.")
      },
      execute: executeReflectionToggle as any
    })
  } catch {
    try {
      const { z } = await import("zod")
      setReflectionTool = {
        description: setReflectionDescription,
        args: {
          guidance: z.string().optional().describe("Reflection guidance. Include a concise plan/checklist for complex work and evidence expectations."),
          clear: z.boolean().optional().describe("Set true to clear the current tool-provided reflection guidance.")
        },
        execute: executeSetReflection
      }
      reflectionToggleTool = {
        description: reflectionToggleDescription,
        args: {
          action: z.enum(["on", "off"]).describe("'on' to enable reflection, 'off' to disable it for this project.")
        },
        execute: executeReflectionToggle
      }
    } catch {
      setReflectionTool = null
      reflectionToggleTool = null
    }
  }

  async function runReflection(sessionId: string): Promise<void> {
      debug("runReflection called for session:", sessionId.slice(0, 8))
      if (activeReflections.has(sessionId)) return

      currentSessionId = sessionId
      if (await isSessionDisabled(sessionId)) {
        debug("Reflection disabled for session:", sessionId.slice(0, 8))
        return
      }

      activeReflections.add(sessionId)

      try {
        let messages: any[] | undefined
        try {
          const { data } = await client.session.messages({ path: { id: sessionId } })
          messages = Array.isArray(data) ? data : undefined
        } catch {
          debug("Session not found (likely deleted), skipping reflection:", sessionId.slice(0, 8))
          return
        }
        if (!messages || messages.length < 2) return

        if (isJudgeSession(sessionId, messages, judgeSessionIds)) return
        if (isPlanMode(messages)) return

        // Issue #82 / Issue #109: ESC-abort detection.
        // Previously we checked time.completed on the last assistant message, but
        // that caused false negatives — sessions where the model stopped producing
        // output (context exhaustion, rate limit, etc.) also lack time.completed,
        // and reflection would silently skip them.
        // We now rely solely on the recentlyAbortedSessions map (populated by
        // session.error with MessageAbortedError) plus a brief delay in the event
        // handler to handle the race where session.idle fires before session.error.

        const lastUserMsgId = getLastRelevantUserMessageId(messages)
        if (!lastUserMsgId) return

        const initialUserMsgId = lastUserMsgId
        const attemptKey = `${sessionId}:${lastUserMsgId}`
        const lastReflectedId = lastReflectedMsgId.get(sessionId)
        if (lastUserMsgId === lastReflectedId) return

        const context = await buildTaskContext(messages, directory)
        if (!context) return

        const lastAssistantText = extractLastAssistantText(messages)
        const customPrompt = await loadReflectionPrompt(directory)
        const agents = await getAgentsFile(directory)
        const currentAttemptCount = attempts.get(attemptKey) || 0
        const defaultReflectionPrompt = buildSelfAssessmentPrompt(
          context,
          agents,
          lastAssistantText,
          currentAttemptCount
        )
        const resolvedPrompt = resolveReflectionPromptPrecedence(customPrompt, toolReflectionPrompt, defaultReflectionPrompt)
        const reflectionPrompt = resolvedPrompt.prompt
        const effectiveToolReflectionPrompt = resolvedPrompt.effectiveToolReflectionPrompt

        await showToast(client, directory, "Requesting reflection self-assessment...", "info")
        debug("Requesting reflection self-assessment (source:", resolvedPrompt.source, ")")

        // Issue #98: Run self-assessment in a separate ephemeral session instead
        // of prompting the active agent session. Asking the active session to
        // respond in JSON poisons its context, causing subsequent replies to be
        // JSON-only.
        const modelList = await loadReflectionModelList()
        const preferredModel = await loadPreferredModelSpec(directory)
        const assessmentAttempts = modelList.length
          ? modelList
          : preferredModel && !isBlockedJudgeModel(preferredModel)
            ? [preferredModel]
            : [""]

      let selfAssessment: string | null = null
      let assessmentModelSpec: string | null = null
      for (const modelSpec of assessmentAttempts) {
        let assessmentSession: any
        try {
          const { data } = await client.session.create({ query: { directory } })
            assessmentSession = data
          } catch {
            debug("Failed to create self-assessment session")
            lastReflectedMsgId.set(sessionId, lastUserMsgId)
            return
          }
          if (!assessmentSession?.id) {
            lastReflectedMsgId.set(sessionId, lastUserMsgId)
            return
          }
          judgeSessionIds.add(assessmentSession.id)

          try {
            const modelParts = modelSpec ? modelSpec.split("/") : []
            const providerID = modelParts[0] || ""
            const modelID = modelParts.slice(1).join("/") || ""
            const body: any = { parts: [{ type: "text", text: reflectionPrompt }] }
            if (providerID && modelID) body.model = { providerID, modelID }

            await client.session.promptAsync({
              path: { id: assessmentSession.id },
              body
            })

            selfAssessment = await waitForResponse(client, assessmentSession.id)
            if (selfAssessment) {
              assessmentModelSpec = modelSpec || null
              break
            }
          } catch (e: any) {
            debug("promptAsync failed (self-assessment):", e?.message || e)
            reportError(e, { plugin: "reflection-3", op: "prompt-self-assessment" })
            continue
          } finally {
            try {
              await client.session.delete({ path: { id: assessmentSession.id }, query: { directory } })
            } catch {}
            judgeSessionIds.delete(assessmentSession.id)
          }
        }

        if (!selfAssessment) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        debug("Self-assessment received")

        // Check if user sent a new message or aborted during assessment
        const abortTime = recentlyAbortedSessions.get(sessionId)
        if (abortTime) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        let currentMessages: any[] | undefined
        try {
          const { data } = await client.session.messages({ path: { id: sessionId } })
          currentMessages = Array.isArray(data) ? data : undefined
        } catch {
          debug("Session deleted during reflection, aborting:", sessionId.slice(0, 8))
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }
        const currentUserMsgId = getLastRelevantUserMessageId(currentMessages || [])
        if (currentUserMsgId && currentUserMsgId !== initialUserMsgId) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, initialUserMsgId)
          return
        }

        let analysis: ReflectionAnalysis | null = null
        const parsedAssessment = parseSelfAssessmentJson(selfAssessment)
        if (parsedAssessment) {
          analysis = evaluateSelfAssessment(parsedAssessment, context)
        } else {
          analysis = await analyzeSelfAssessmentWithLLM(
            client,
            directory,
            context,
            selfAssessment,
            judgeSessionIds,
            effectiveToolReflectionPrompt
          )
        }

        if (!analysis) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          await showToast(client, directory, "Reflection analysis failed", "warning")
          return
        }

        debug("Reflection analysis completed")

        let crossReview: { modelSpec: string; response: string } | null = null
        if (analysis.complete) {
          debug("Task complete, attempting cross-model review (assessmentModel:", assessmentModelSpec || "unknown", ")")
          crossReview = await runCrossModelReview(
            client,
            directory,
            context,
            selfAssessment,
            analysis,
            lastAssistantText,
            assessmentModelSpec,
            judgeSessionIds,
            effectiveToolReflectionPrompt
          )
          if (crossReview) {
            debug("Cross-model review completed by", crossReview.modelSpec)
          } else {
            debug("Cross-model review skipped (no cross-model mapping or error)")
          }
        }

        // Compute routing early so it can be included in saved data
        const routingConfig = await loadRoutingConfig()
        const routingCategory = await classifyTaskForRoutingWithLLM(client, directory, context, judgeSessionIds)
        const routingModel = getRoutingModel(routingConfig, routingCategory)

        await saveReflectionData(directory, sessionId, {
          task: context.taskSummary,
          assessment: selfAssessment.slice(0, 4000),
          analysis,
          crossReview,
          routing: routingModel ? { category: routingCategory, model: routingModel } : null,
          timestamp: new Date().toISOString()
        })

        await writeVerdictSignal(directory, sessionId, analysis.complete, analysis.severity)

        if (analysis.complete) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          await showToast(client, directory, `Task complete ✓ (${analysis.severity})`, "success")
          debug("Reflection complete")
          return
        }

        if (analysis.requiresHumanAction && !analysis.shouldContinue) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          const hint = (Array.isArray(analysis.missing) && analysis.missing[0]) || "User action required"
          await showToast(client, directory, `Action needed: ${hint}`, "warning")
          debug("Reflection requires human action (no agent-actionable work remaining)")
          return
        }

        // Re-check for new user messages or abort before feedback injection
        // (analysis/judge phase can take significant time)
        let preFeedbackMessages: any[] | undefined
        try {
          const { data } = await client.session.messages({ path: { id: sessionId } })
          preFeedbackMessages = Array.isArray(data) ? data : undefined
        } catch {
          debug("Session deleted before feedback injection, aborting:", sessionId.slice(0, 8))
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }
        const preFeedbackUserMsgId = getLastRelevantUserMessageId(preFeedbackMessages || [])
        if (preFeedbackUserMsgId && preFeedbackUserMsgId !== initialUserMsgId) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, initialUserMsgId)
          debug("User sent new message during analysis, skipping feedback")
          return
        }
        const preFeedbackAbort = recentlyAbortedSessions.get(sessionId)
        if (preFeedbackAbort) {
          attempts.delete(attemptKey)
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          debug("Session aborted during analysis, skipping feedback")
          return
        }

        const nextAttemptCount = (attempts.get(attemptKey) || 0) + 1
        attempts.set(attemptKey, nextAttemptCount)
        if (nextAttemptCount >= MAX_ATTEMPTS) {
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          await showToast(client, directory, `Max attempts (${MAX_ATTEMPTS}) reached`, "warning")
          debug("Max attempts reached for", sessionId.slice(0, 8))
          return
        }

        const loopCheck = detectPlanningLoop(preFeedbackMessages || messages)
        const usePlanningLoopMessage = shouldApplyPlanningLoop(context.taskType, loopCheck.detected)
        const actionLoopCheck = detectActionLoop(preFeedbackMessages || messages)
        const feedbackText = buildEscalatingFeedback(
          nextAttemptCount,
          analysis.severity || "MEDIUM",
          {
            feedback: analysis.reason || "Task incomplete",
            missing: analysis.missing,
            next_actions: analysis.nextActions
          },
          usePlanningLoopMessage,
          actionLoopCheck.detected
        )

        // Apply task-based model routing to feedback injection
        const feedbackBody: any = { parts: [{ type: "text", text: feedbackText }] }
        if (routingModel) {
          feedbackBody.model = routingModel
          debug("Routing feedback to", routingCategory, "model:", JSON.stringify(routingModel))
        }

        try {
          await client.session.promptAsync({
            path: { id: sessionId },
            body: feedbackBody
          })
        } catch (e: any) {
          debug("promptAsync failed (feedback):", e?.message || e)
          reportError(e, { plugin: "reflection-3", op: "prompt-feedback" })
          lastReflectedMsgId.set(sessionId, lastUserMsgId)
          return
        }

        // Prevent reflection loop: mark this task as reflected so the next
        // session.idle (triggered by the agent responding to feedback) does not
        // start another reflection cycle for the same user message.
        lastReflectedMsgId.set(sessionId, lastUserMsgId)

        debug("Reflection pushed continuation")

        const routingInfo = routingModel ? ` [${routingCategory} → ${routingModel.modelID}]` : ""
        await showToast(client, directory, `Pushed agent to continue${routingInfo}`, "info")
      } finally {
        activeReflections.delete(sessionId)
      }
    }

  return {
    config: async (_config) => {
      return
    },
    tool: (setReflectionTool || reflectionToggleTool) ? {
      ...(setReflectionTool ? { set_reflection: setReflectionTool } : {}),
      ...(reflectionToggleTool ? { reflection: reflectionToggleTool } : {}),
    } : undefined,
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      debug("event received:", event.type)
      if (event.type === "session.error") {
        const props = (event as any).properties
        const sessionId = props?.sessionID
        const error = props?.error
        if (sessionId && error?.name === "MessageAbortedError") {
          recentlyAbortedSessions.set(sessionId, Date.now())
          debug("Session aborted (Esc), cooldown started:", sessionId.slice(0, 8))
        }
      }

      if (event.type === "session.idle") {
        debug("session.idle received")
        const sessionId = (event as any).properties?.sessionID
        if (!sessionId || typeof sessionId !== "string") return

        const abortTime = recentlyAbortedSessions.get(sessionId)
        if (abortTime) {
          const elapsed = Date.now() - abortTime
          if (elapsed < ABORT_COOLDOWN) return
          recentlyAbortedSessions.delete(sessionId)
        }

        // Issue #109: Brief delay before running reflection to let session.error
        // arrive first (handles race where session.idle fires before session.error
        // when user presses ESC). After the delay, re-check the abort map.
        await new Promise(resolve => setTimeout(resolve, ABORT_RACE_DELAY))
        const postDelayAbortTime = recentlyAbortedSessions.get(sessionId)
        if (postDelayAbortTime) {
          debug("Session aborted during race delay, skipping reflection:", sessionId.slice(0, 8))
          return
        }

        try {
          await runReflection(sessionId)
        } catch (e: any) {
          debug("runReflection error:", e?.message || e)
          reportError(e, { plugin: "reflection-3", op: "run-reflection" })
        }
      }
    }
  }
}

export default Reflection3Plugin
