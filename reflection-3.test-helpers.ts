export type TaskType = "coding" | "docs" | "research" | "ops" | "other"
export type AgentMode = "plan" | "build" | "unknown"

export interface WorkflowRequirements {
  requiresTests: boolean
  requiresBuild: boolean
  requiresPR: boolean
  requiresCI: boolean
  requiresLocalTests: boolean
  requiresLocalTestsEvidence: boolean
}

export interface TaskContext extends WorkflowRequirements {
  taskSummary: string
  taskType: TaskType
  agentMode: AgentMode
  humanMessages: string[]
  toolsSummary: string
  detectedSignals: string[]
  recentCommands: string[]
  pushedToDefaultBranch: boolean
}

export interface SelfAssessment {
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

export interface ReflectionAnalysis {
  complete: boolean
  shouldContinue: boolean
  reason: string
  missing: string[]
  nextActions: string[]
  requiresHumanAction: boolean
  severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKER"
}

export function inferTaskType(text: string): TaskType {
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

export function buildSelfAssessmentPrompt(context: TaskContext, agents: string, lastAssistantText?: string, attemptCount?: number): string {
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
  "task_summary": "...",
  "task_type": "feature|bugfix|refactor|docs|research|ops|other",
  "status": "complete|in_progress|blocked|stuck|waiting_for_user",
  "confidence": 0.0,
  "evidence": {
    "tests": { "ran": true/false, "results": "pass|fail|unknown", "ran_after_changes": true/false, "commands": ["..."] },
    "build": { "ran": true/false, "results": "pass|fail|unknown" },
    "pr": { "created": true/false, "url": "", "ci_status": "pass|fail|unknown", "checked": true/false }
  },
  "remaining_work": ["..."],
  "next_steps": ["..."],
  "needs_user_action": ["..."],
  "stuck": true/false,
  "alternate_approach": ""
}

Rules:
- If coding work is complete, confirm tests ran after the latest changes and passed.
- If local tests are required, provide the exact commands run in this session.
- If PR exists, verify CI checks and report status.
- If tests were skipped or marked flaky/not important, the task is incomplete.
- Direct pushes to main/master are not allowed; require a PR instead.
- Provide a PR URL and CI status when a PR is required.
- If stuck, propose an alternate approach.
- If you need user action (auth, 2FA, credentials), list it in needs_user_action.
- If you are repeating the same actions (deploy, test, build) without making progress, set "stuck": true.
- Do not retry the same failing approach more than twice — try something different or report stuck.

PREMATURE-STOP ANTIPATTERNS (mined from 227 real agent stops where the user replied; 78% were premature — the user said "go"/"continue"/"yes do it" or corrected the agent). If the agent's last response matches one of these AND executable work remains, the task is NOT complete — set status "in_progress", and put the concrete next action in remaining_work and next_steps:
- PERMISSION-SEEKING (most common, ~40%): the response ends by asking to do work it can already do — "Want me to…?", "Would you like me to…?", "Should I…?", "Shall I proceed?", or "Try running it now"/"Please run X and confirm" (deferring a check it could run itself). DECISIVE TEST: if the final turn is a yes/no or "want me to X?" question AND X is something the agent can do with its own tools AND X carries no irreversible risk, the stop is premature — it should have just done X. Asking is only legitimate before a destructive/irreversible action (delete prod data, force-push, send an irreversible external message).
- STOPPED-WITH-TODOS (~30%): the response lists "Remaining Tasks"/"Next steps"/"Still TODO"/"What I did NOT do" or names a verify/run/check/create-PR step as "next" — then stops without doing it. Listing remaining work does not complete it; a self-contained named step must be DONE before stopping. Set status "in_progress" with that work in remaining_work.
- FALSE-COMPLETE: claims "done"/"complete"/"ready"/"all tasks complete" but the CORE requested action never happened, a required check was skipped, or there is no evidence. An empty/no-text response, or a response with no write/tool evidence on an action task, is NEVER complete. For an "add a <feature/system>" task, writing files is necessary but NOT sufficient — the new code must be WIRED IN (imported/registered/routed, not orphaned modules) AND verified (test/build/run); "ready to use" with no integration is incomplete (status "in_progress").
- LEGITIMATE STOP (do NOT flag): genuine human-only block (OAuth consent, 2FA code, credential/API-key retrieval, captcha) → status "waiting_for_user" with the item in needs_user_action. Genuine completion WITH evidence (commands+output, tests passing, PR/CI verified) → status "complete"; do not invent missing work.
- SEVERITY/STUCK: a single recoverable technical snag mid-task (knows the fix) is not "stuck". But a policy/process violation — pushing to main when a PR was required, skipping mandated tests — is a real failure: status "in_progress" with the corrective action in remaining_work, never "complete".`
}

export function buildToolReflectionGuidanceSection(toolReflectionPrompt: string | null): string {
  if (!toolReflectionPrompt) return ""
  return `\n## Tool Reflection Guidance\n${toolReflectionPrompt.slice(0, 4000)}\n`
}

export function resolveReflectionPromptPrecedence(
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

export function parseSelfAssessmentJson(text: string | null | undefined): SelfAssessment | null {
  if (typeof text !== "string") return null
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    return JSON.parse(jsonMatch[0]) as SelfAssessment
  } catch {
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

export function evaluateSelfAssessment(assessment: SelfAssessment, context: TaskContext): ReflectionAnalysis {
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
      const normalizedRecent = safeContext.recentCommands.map(cmd => cmd.replace(/\s+/g, " ").trim())
      const normalizedEvidence = ranCommands.map(cmd => cmd.replace(/\s+/g, " ").trim())
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

export type RoutingCategory = "backend" | "architecture" | "frontend" | "default"

export interface RoutingConfig {
  enabled: boolean
  models: Record<RoutingCategory, string>
}

export interface ModelSpecParts {
  providerID: string
  modelID: string
}


export function parseRoutingFromYaml(content: string): RoutingConfig {
  const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
    enabled: false,
    models: { backend: "", architecture: "", frontend: "", default: "" }
  }
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

export function getRoutingModel(config: RoutingConfig, category: RoutingCategory): { providerID: string; modelID: string } | null {
  if (!config.enabled) return null
  const modelSpec = config.models[category] || config.models["default"] || ""
  if (!modelSpec) return null
  const parts = modelSpec.split("/")
  const providerID = parts[0] || ""
  const modelID = parts.slice(1).join("/") || ""
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

export function parseModelSpec(modelSpec: string | null | undefined): ModelSpecParts | null {
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

export function getCrossReviewModelSpec(modelSpec: string | null | undefined): string | null {
  const parsed = parseModelSpec(modelSpec)
  if (!parsed) return null
  const modelID = parsed.modelID.toLowerCase()
  if (modelID === "claude-opus-4.6") return "github-copilot/gpt-5.2-codex"
  if (modelID === "gpt-5.2-codex") return "github-copilot/claude-opus-4.6"
  return null
}

export function getGitHubCopilotModelForRouting(modelSpec: string | null | undefined): string | null {
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

const FEEDBACK_MARKER = "## Reflection-3:"
const MAX_ATTEMPTS = 3
const ACTION_LOOP_MIN_COMMANDS = 4
const ACTION_LOOP_REPETITION_THRESHOLD = 0.6

/**
 * Detects when the agent is repeating the same commands/actions without progress.
 * Unlike detectPlanningLoop (read-heavy without writes), this catches action loops
 * where the agent IS making write-like operations but repeating the same ones.
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
          const normalized = cmd.replace(/\s+/g, " ").replace(/\d{10,}/g, "TIMESTAMP").toLowerCase()
          commands.push(normalized)
        }
      } else if (toolName !== "read" && toolName !== "glob" && toolName !== "grep" && toolName !== "todowrite") {
        const key = `${toolName}:${JSON.stringify(input).slice(0, 100)}`
        commands.push(key)
      }
    }
  }

  if (commands.length < ACTION_LOOP_MIN_COMMANDS) {
    return { detected: false, repeatedCommands: [], totalCommands: commands.length }
  }

  const counts = new Map<string, number>()
  for (const cmd of commands) {
    counts.set(cmd, (counts.get(cmd) || 0) + 1)
  }

  const repeatedCommands: string[] = []
  let repeatedCount = 0
  for (const [cmd, count] of counts) {
    if (count >= 3) {
      repeatedCommands.push(cmd)
      repeatedCount += count
    }
  }

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

export function shouldApplyPlanningLoop(taskType: TaskType, loopDetected: boolean): boolean {
  if (!loopDetected) return false
  return taskType === "coding"
}

const SELF_ASSESSMENT_MARKER = "## Reflection-3 Self-Assessment"

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
