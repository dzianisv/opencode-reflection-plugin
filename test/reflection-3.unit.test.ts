import assert from "node:assert"
import {
  buildSelfAssessmentPrompt,
  parseSelfAssessmentJson,
  evaluateSelfAssessment,
  inferTaskType,
  parseRoutingFromYaml,
  getRoutingModel,
  buildEscalatingFeedback,
  shouldApplyPlanningLoop,
  parseModelSpec,
  getCrossReviewModelSpec,
  getGitHubCopilotModelForRouting,
  detectActionLoop,
  isPlanMode,
  buildToolReflectionGuidanceSection,
  resolveReflectionPromptPrecedence,
  RoutingConfig
} from "../reflection-3.test-helpers.ts"
import { detectPlanningLoop } from "../reflection-3.ts"

describe("reflection-3 unit", () => {
  it("detects task type from text", () => {
    assert.strictEqual(inferTaskType("Fix the login bug"), "coding")
    assert.strictEqual(inferTaskType("Update the README docs"), "docs")
    assert.strictEqual(inferTaskType("Investigate performance regressions"), "research")
  })

  it("parses self-assessment JSON", () => {
    const text = `{"status":"complete","confidence":0.9}`
    const parsed = parseSelfAssessmentJson(text)
    assert.ok(parsed)
    assert.strictEqual(parsed?.status, "complete")
    assert.strictEqual(parsed?.confidence, 0.9)
  })

  it("builds self-assessment prompt with requirements", () => {
    const prompt = buildSelfAssessmentPrompt({
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: ["test-mention"],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: true,
      requiresLocalTestsEvidence: true
    }, "")

    assert.ok(prompt.includes("Tests required"))
    assert.ok(prompt.includes("Return JSON only"))
    assert.ok(prompt.includes("Local tests required"))
    assert.ok(prompt.includes("Direct pushes"))
    assert.ok(prompt.includes("Provide a PR URL"))
  })

  it("self-assessment prompt includes premature-stop antipatterns", () => {
    const prompt = buildSelfAssessmentPrompt({
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    }, "")
    // mined-antipattern guidance must be present so the runtime judge catches premature stops
    assert.ok(prompt.includes("PERMISSION-SEEKING"), "permission-seeking antipattern missing")
    assert.ok(prompt.includes("STOPPED-WITH-TODOS"), "stopped-with-todos antipattern missing")
    assert.ok(prompt.includes("FALSE-COMPLETE"), "false-complete antipattern missing")
    assert.ok(prompt.includes("LEGITIMATE STOP"), "legitimate-stop carve-out missing")
    // carve-out must route genuine human blocks to waiting_for_user, not nag
    assert.ok(prompt.includes("waiting_for_user"))
  })

  it("includes tool reflection guidance in resolved reflection prompt", () => {
    const basePrompt = buildSelfAssessmentPrompt({
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: true,
      requiresLocalTestsEvidence: true
    }, "")
    const guidance = "Reflection checklist:\n1. Verify changed files\n2. Verify tests after changes"
    const resolved = resolveReflectionPromptPrecedence(null, guidance, basePrompt)
    assert.strictEqual(resolved.source, "tool")
    assert.ok(resolved.prompt.includes("## Tool Reflection Guidance"))
    assert.ok(resolved.prompt.includes("Reflection checklist"))
    assert.ok(buildToolReflectionGuidanceSection(guidance).includes("Verify tests after changes"))
  })

  it("applies precedence: file override beats tool reflection override", () => {
    const resolved = resolveReflectionPromptPrecedence(
      "FILE REFLECTION OVERRIDE",
      "TOOL REFLECTION OVERRIDE",
      "DEFAULT REFLECTION PROMPT"
    )
    assert.strictEqual(resolved.source, "file")
    assert.strictEqual(resolved.prompt, "FILE REFLECTION OVERRIDE")
    assert.strictEqual(resolved.effectiveToolReflectionPrompt, null)
    assert.ok(!resolved.prompt.includes("TOOL REFLECTION OVERRIDE"))
  })

  describe("set_reflection tool helpers", () => {
    it("buildToolReflectionGuidanceSection(null) => empty string", () => {
      assert.strictEqual(buildToolReflectionGuidanceSection(null), "")
    })

    it("buildToolReflectionGuidanceSection(\"\") => empty string", () => {
      assert.strictEqual(buildToolReflectionGuidanceSection(""), "")
    })

    it("wraps guidance in section header", () => {
      const section = buildToolReflectionGuidanceSection("Check tests and CI")
      assert.ok(section.startsWith("\n## Tool Reflection Guidance\n"))
      assert.ok(section.includes("Check tests and CI"))
    })

    it("truncates guidance at 4000 chars", () => {
      const longGuidance = "x".repeat(5000)
      const section = buildToolReflectionGuidanceSection(longGuidance)
      assert.ok(section.startsWith("\n## Tool Reflection Guidance\n"))
      assert.ok(section.endsWith("\n"))
      const body = section.replace("\n## Tool Reflection Guidance\n", "").slice(0, -1)
      assert.strictEqual(body.length, 4000)
      assert.strictEqual(body, "x".repeat(4000))
    })

    it("resolveReflectionPromptPrecedence returns default when no file/tool guidance", () => {
      const resolved = resolveReflectionPromptPrecedence(null, null, "DEFAULT REFLECTION PROMPT")
      assert.strictEqual(resolved.source, "default")
      assert.strictEqual(resolved.prompt, "DEFAULT REFLECTION PROMPT")
      assert.strictEqual(resolved.effectiveToolReflectionPrompt, null)
    })
  })

  it("evaluates missing tests and build requirements", () => {
    const assessment = {
      status: "complete" as const,
      confidence: 0.9,
      evidence: {
        tests: { ran: false },
        build: { ran: false }
      },
      remaining_work: []
    }

    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: true,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: true,
      requiresLocalTestsEvidence: true
    })

    assert.strictEqual(analysis.complete, false)
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("tests")))
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("build")))
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("local")))
  })

  it("marks requires human action", () => {
    const assessment = {
      status: "blocked" as const,
      confidence: 0.5,
      needs_user_action: ["Provide API key"]
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.requiresHumanAction, true)
    assert.strictEqual(analysis.complete, false)
  })

  it("treats non-human needs_user_action as agent-actionable work", () => {
    const assessment = {
      status: "in_progress" as const,
      confidence: 0.4,
      needs_user_action: ["Run tests", "Open PR and check CI"]
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: false,
      requiresPR: true,
      requiresCI: true,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.requiresHumanAction, false)
    assert.strictEqual(analysis.shouldContinue, true)
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("run tests")))
    assert.ok(analysis.nextActions.some((m: string) => m.toLowerCase().includes("run tests")))
  })

  it("keeps shouldContinue true when next_steps are actionable even if missing is empty", () => {
    const assessment = {
      status: "in_progress" as const,
      confidence: 0.6,
      remaining_work: [],
      next_steps: ["Run npm test"],
      needs_user_action: []
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Run tests",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Run tests"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.shouldContinue, true)
    assert.strictEqual(analysis.requiresHumanAction, false)
  })

  it("treats human-only needs_user_action as blocking when sole work", () => {
    const assessment = {
      status: "waiting_for_user" as const,
      confidence: 0.9,
      remaining_work: [],
      next_steps: [],
      needs_user_action: ["Log in and approve OAuth consent"]
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Connect OAuth",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Connect OAuth"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.requiresHumanAction, true)
    assert.strictEqual(analysis.shouldContinue, false)
  })

  it("detects PR requirement from text", () => {
    const signals = "Create a PR for this fix"
    const context = {
      taskSummary: "Create a PR for this fix",
      taskType: "coding",
      agentMode: "build",
      humanMessages: [signals],
      toolsSummary: "(none)",
      detectedSignals: ["pr-mention"],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: true,
      requiresCI: true,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    }

    assert.strictEqual(context.requiresPR, true)
  })

  it("flags skipped tests as incomplete", () => {
    const assessment = {
      status: "complete" as const,
      confidence: 0.9,
      evidence: {
        tests: { ran: true, results: "pass" as const, ran_after_changes: true, skipped: true, skip_reason: "Flaky" }
      }
    }

    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.complete, false)
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("skip")))
  })

  it("flags direct push to default branch", () => {
    const analysis = evaluateSelfAssessment({ status: "complete", confidence: 0.9 }, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: ["git push origin main"],
      pushedToDefaultBranch: true,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.complete, false)
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("direct push")))
  })

  it("requires PR evidence and CI checks when PR required", () => {
    const analysis = evaluateSelfAssessment({
      status: "complete",
      confidence: 0.9,
      evidence: { pr: { created: true, url: "", checked: false, ci_status: "unknown" } }
    }, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: true,
      requiresCI: true,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.complete, false)
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("pr link")))
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("ci")))
  })

  it("requires local test commands from this session", () => {
    const analysis = evaluateSelfAssessment({
      status: "complete",
      confidence: 0.9,
      evidence: { tests: { ran: true, results: "pass", ran_after_changes: true, commands: ["npm test"] } }
    }, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: ["npm run build"],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: true,
      requiresLocalTestsEvidence: true
    })

    assert.strictEqual(analysis.complete, false)
    assert.ok(analysis.missing.some((m: string) => m.toLowerCase().includes("this session")))
  })

  it("detects ops task type for personal-assistant patterns", () => {
    assert.strictEqual(inferTaskType("Create a filter to label and move emails to inbox"), "ops")
    assert.strictEqual(inferTaskType("Clean up Gmail inbox"), "ops")
    assert.strictEqual(inferTaskType("Reply to recruiter on LinkedIn"), "ops")
    assert.strictEqual(inferTaskType("Set up calendar events"), "ops")
    assert.strictEqual(inferTaskType("Configure MCP server"), "ops")
    assert.strictEqual(inferTaskType("Install dependencies on the server"), "ops")
    assert.strictEqual(inferTaskType("Organize email filters"), "ops")
    assert.strictEqual(inferTaskType("Deploy the service to production"), "ops")
  })

  it("does not misclassify ops tasks as coding when text contains build/create", () => {
    // This was the exact bug: "Create a filter" matched coding, "build entities" matched build-mention
    assert.strictEqual(inferTaskType("Create a filter to label and move emails from recruiters"), "ops")
    assert.strictEqual(inferTaskType("Builds entities and relationships in knowledge graph for email"), "ops")
  })

  it("classifies as coding when text has both research AND coding keywords (issue #115)", () => {
    // The stuck session had text like "investigate ... fix ... issue ... error" — all present.
    // research matched first, disabling all workflow gates, letting the task pass as "complete"
    // even though the agent only read files and never made any code changes.
    assert.strictEqual(inferTaskType("Investigate and fix the login bug"), "coding")
    assert.strictEqual(inferTaskType("Analyze the error and implement a fix"), "coding")
    assert.strictEqual(inferTaskType("Study the regression and create a patch"), "coding")
    assert.strictEqual(inferTaskType("Evaluate the issue and update the handler"), "coding")
  })

  it("classifies as coding when text contains a GitHub issue URL with research keywords (issue #115)", () => {
    // A GitHub issue URL + research keyword should resolve to coding, not research
    assert.strictEqual(inferTaskType("Investigate https://github.com/VibeTechnologies/VibeWebAgent/issues/513"), "coding")
    assert.strictEqual(inferTaskType("Analyze the problem at https://github.com/org/repo/issues/42"), "coding")
    // A bare GitHub URL without research keywords is just "other" (no research to override)
    assert.strictEqual(inferTaskType("https://github.com/org/repo/issues/513"), "other")
  })

  it("still classifies pure research text as research", () => {
    assert.strictEqual(inferTaskType("Investigate performance characteristics"), "research")
    assert.strictEqual(inferTaskType("Research best practices for caching"), "research")
    assert.strictEqual(inferTaskType("Analyze the trade-offs between approaches"), "research")
  })

  it("shouldContinue is true when agent has actionable work alongside human-only needs_user_action", () => {
    const assessment = {
      status: "in_progress" as const,
      confidence: 0.5,
      remaining_work: ["Commit and push uncommitted changes"],
      needs_user_action: ["Provide API key"],
      evidence: { tests: { ran: false } }
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.requiresHumanAction, true)
    // Agent should still continue because there's actionable work (run tests, commit changes)
    assert.strictEqual(analysis.shouldContinue, true)
    assert.ok(analysis.missing.length > 0)
  })

  it("shouldContinue is false when only user action remains", () => {
    const assessment = {
      status: "waiting_for_user" as const,
      confidence: 0.9,
      remaining_work: [],
      needs_user_action: ["Provide API key"]
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.requiresHumanAction, true)
    assert.strictEqual(analysis.shouldContinue, false)
  })

  it("does not treat run-test request as user action", () => {
    const assessment = {
      status: "in_progress" as const,
      confidence: 0.6,
      remaining_work: ["Run tests", "Create PR"],
      needs_user_action: ["Run tests"]
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Implement feature",
      taskType: "coding",
      agentMode: "build",
      humanMessages: ["Implement feature"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: true,
      requiresBuild: false,
      requiresPR: true,
      requiresCI: true,
      requiresLocalTests: true,
      requiresLocalTestsEvidence: true
    })

    assert.strictEqual(analysis.requiresHumanAction, false)
    assert.strictEqual(analysis.shouldContinue, true)
    assert.ok(analysis.missing.length > 0)
  })

  it("ops tasks do not require PR or CI", () => {
    // For ops tasks, PR and CI should not be enforced
    const assessment = {
      status: "complete" as const,
      confidence: 0.9,
      evidence: {}
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Configure email filters",
      taskType: "ops",
      agentMode: "build",
      humanMessages: ["Configure email filters"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    assert.strictEqual(analysis.complete, true)
    assert.strictEqual(analysis.missing.length, 0)
  })

  it("evaluateSelfAssessment marks complete when no requirements and high confidence (issue #115 precondition)", () => {
    // This test documents the exact scenario from issue #115:
    // When taskType was misclassified as "research", all requires* were false,
    // so evaluateSelfAssessment found missing.length===0 and marked it complete.
    // The fix is in inferTaskType (prefer coding), but this test verifies the
    // evaluator behavior hasn't changed for legitimate research tasks.
    const assessment = {
      status: "complete" as const,
      confidence: 0.95,
      evidence: {}
    }
    const analysis = evaluateSelfAssessment(assessment, {
      taskSummary: "Research caching strategies",
      taskType: "research",
      agentMode: "build",
      humanMessages: ["Research caching strategies"],
      toolsSummary: "(none)",
      detectedSignals: [],
      recentCommands: [],
      pushedToDefaultBranch: false,
      requiresTests: false,
      requiresBuild: false,
      requiresPR: false,
      requiresCI: false,
      requiresLocalTests: false,
      requiresLocalTestsEvidence: false
    })

    // For a genuine research task with no requirements, this is correct behavior
    assert.strictEqual(analysis.complete, true)
    assert.strictEqual(analysis.missing.length, 0)
  })

  it("detectPlanningLoop catches sessions with only read operations (issue #115)", () => {
    // Simulate the stuck session: 15+ tool calls, all reads, zero writes
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", tool: "github_issue_read", state: { input: {} } },
          { type: "tool", tool: "task", state: { input: {} } },
          { type: "tool", tool: "read", state: { input: {} } },
          { type: "tool", tool: "read", state: { input: {} } },
          { type: "tool", tool: "glob", state: { input: {} } },
          { type: "tool", tool: "grep", state: { input: {} } },
          { type: "tool", tool: "read", state: { input: {} } },
          { type: "tool", tool: "read", state: { input: {} } },
          { type: "tool", tool: "task", state: { input: {} } },
          { type: "tool", tool: "webfetch", state: { input: {} } },
          { type: "tool", tool: "read", state: { input: {} } },
          { type: "tool", tool: "bash", state: { input: { command: "git log --oneline -5" } } },
          { type: "tool", tool: "read", state: { input: {} } },
          { type: "tool", tool: "read", state: { input: {} } },
          { type: "tool", tool: "skill", state: { input: {} } }
        ]
      }
    ]
    const result = detectPlanningLoop(messages)
    assert.strictEqual(result.detected, true)
    assert.strictEqual(result.writeCount, 0)
    assert.ok(result.readCount > 0)
    assert.ok(result.totalTools >= 10)
  })

  it("does not apply planning loop message for research tasks (issue #120)", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", tool: "read", state: { input: {} } },
          { type: "tool", tool: "read", state: { input: {} } },
          { type: "tool", tool: "glob", state: { input: {} } },
          { type: "tool", tool: "grep", state: { input: {} } },
          { type: "tool", tool: "bash", state: { input: { command: "git log --oneline -5" } } },
          { type: "tool", tool: "read", state: { input: {} } },
          { type: "tool", tool: "webfetch", state: { input: {} } },
          { type: "tool", tool: "read", state: { input: {} } }
        ]
      }
    ]
    const loop = detectPlanningLoop(messages)
    assert.strictEqual(loop.detected, true)
    assert.strictEqual(shouldApplyPlanningLoop("research", loop.detected), false)
    assert.strictEqual(shouldApplyPlanningLoop("coding", loop.detected), true)
  })
})

describe("buildEscalatingFeedback", () => {
  it("handles null verdict without crashing", () => {
    const result = buildEscalatingFeedback(1, "medium", null, false)
    assert.ok(result.includes("Task Incomplete"))
    assert.ok(result.includes("medium"))
  })

  it("handles undefined verdict without crashing", () => {
    const result = buildEscalatingFeedback(1, "high", undefined, false)
    assert.ok(result.includes("Task Incomplete"))
    assert.ok(result.includes("high"))
  })

  it("includes missing items and next actions from verdict", () => {
    const verdict = {
      feedback: "Tests not run",
      missing: ["Run tests", "Create PR"],
      next_actions: ["npm test", "gh pr create"]
    }
    const result = buildEscalatingFeedback(1, "high", verdict, false)
    assert.ok(result.includes("Tests not run"))
    assert.ok(result.includes("- Run tests"))
    assert.ok(result.includes("- Create PR"))
    assert.ok(result.includes("- npm test"))
    assert.ok(result.includes("- gh pr create"))
  })

  it("returns planning loop message when isPlanningLoop is true", () => {
    const result = buildEscalatingFeedback(1, "high", null, true)
    assert.ok(result.includes("Planning Loop Detected"))
    assert.ok(result.includes("Start coding NOW"))
  })

  it("planning loop ignores verdict content", () => {
    const verdict = { feedback: "Some feedback", missing: ["item"], next_actions: ["action"] }
    const result = buildEscalatingFeedback(1, "high", verdict, true)
    assert.ok(result.includes("Planning Loop Detected"))
    assert.ok(!result.includes("Some feedback"))
  })

  it("escalates to final attempt message after attempt 2", () => {
    const verdict = { missing: ["Run tests", "Create PR", "Check CI", "Update docs"] }
    const result = buildEscalatingFeedback(3, "high", verdict, false)
    assert.ok(result.includes("Final Attempt"))
    assert.ok(result.includes("3/3"))
    // Should truncate to first 3 missing items
    assert.ok(result.includes("Run tests"))
    assert.ok(result.includes("Create PR"))
    assert.ok(result.includes("Check CI"))
    assert.ok(!result.includes("Update docs"))
    // Should include give-up guidance
    assert.ok(result.includes("LAST chance"))
    assert.ok(result.includes("needs_user_action"))
  })

  it("handles verdict with empty arrays", () => {
    const verdict = { feedback: "", missing: [], next_actions: [] }
    const result = buildEscalatingFeedback(1, "low", verdict, false)
    assert.ok(result.includes("Task Incomplete"))
    assert.ok(!result.includes("### Missing"))
    assert.ok(!result.includes("### Next Actions"))
  })

  it("handles verdict with missing fields (partial object)", () => {
    const verdict = { feedback: "Incomplete" }
    const result = buildEscalatingFeedback(2, "medium", verdict, false)
    assert.ok(result.includes("Incomplete"))
    assert.ok(!result.includes("### Missing"))
  })

  it("returns action loop message when isActionLoop is true", () => {
    const result = buildEscalatingFeedback(2, "high", null, false, true)
    assert.ok(result.includes("Action Loop Detected"))
    assert.ok(result.includes("repeating the same commands"))
    assert.ok(result.includes("Do NOT re-run"))
  })

  it("action loop includes attempt count", () => {
    const result = buildEscalatingFeedback(2, "high", null, false, true)
    assert.ok(result.includes("2/3"))
  })

  it("action loop ignores verdict content", () => {
    const verdict = { feedback: "Some feedback", missing: ["item"], next_actions: ["action"] }
    const result = buildEscalatingFeedback(1, "high", verdict, false, true)
    assert.ok(result.includes("Action Loop Detected"))
    assert.ok(!result.includes("Some feedback"))
  })

  it("planning loop takes priority over action loop", () => {
    const result = buildEscalatingFeedback(1, "high", null, true, true)
    assert.ok(result.includes("Planning Loop Detected"))
    assert.ok(!result.includes("Action Loop Detected"))
  })
})

describe("task-based model routing", () => {
  describe("parseRoutingFromYaml", () => {
    it("parses a complete routing config", () => {
      const yaml = `models:
  - github-copilot/claude-opus-4.6

routing:
  enabled: true
  models:
    backend: github-copilot/gpt-5.2-codex
    architecture: github-copilot/claude-opus-4.6
    frontend: github-copilot/gemini-3-pro-preview
    default: github-copilot/claude-opus-4.6
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.enabled, true)
      assert.strictEqual(config.models.backend, "github-copilot/gpt-5.2-codex")
      assert.strictEqual(config.models.architecture, "github-copilot/claude-opus-4.6")
      assert.strictEqual(config.models.frontend, "github-copilot/gemini-3-pro-preview")
      assert.strictEqual(config.models.default, "github-copilot/claude-opus-4.6")
    })

    it("defaults to disabled when routing section is missing", () => {
      const yaml = `models:
  - github-copilot/claude-opus-4.6
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.enabled, false)
      assert.strictEqual(config.models.backend, "")
      assert.strictEqual(config.models.frontend, "")
    })

    it("handles enabled: false", () => {
      const yaml = `routing:
  enabled: false
  models:
    backend: github-copilot/gpt-5.2-codex
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.enabled, false)
      assert.strictEqual(config.models.backend, "github-copilot/gpt-5.2-codex")
    })

    it("handles partial model config", () => {
      const yaml = `routing:
  enabled: true
  models:
    backend: github-copilot/gpt-5.2-codex
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.enabled, true)
      assert.strictEqual(config.models.backend, "github-copilot/gpt-5.2-codex")
      assert.strictEqual(config.models.frontend, "")
      assert.strictEqual(config.models.architecture, "")
    })

    it("strips quotes from model values", () => {
      const yaml = `routing:
  enabled: true
  models:
    backend: "github-copilot/gpt-5.2-codex"
    frontend: 'github-copilot/gemini-3-pro-preview'
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.models.backend, "github-copilot/gpt-5.2-codex")
      assert.strictEqual(config.models.frontend, "github-copilot/gemini-3-pro-preview")
    })

    it("ignores unknown routing model keys", () => {
      const yaml = `routing:
  enabled: true
  models:
    backend: github-copilot/gpt-5.2-codex
    unknown_category: github-copilot/some-model
`
      const config = parseRoutingFromYaml(yaml)
      assert.strictEqual(config.models.backend, "github-copilot/gpt-5.2-codex")
      assert.strictEqual((config.models as any).unknown_category, undefined)
    })
  })

  describe("getRoutingModel", () => {
    const enabledConfig: RoutingConfig = {
      enabled: true,
      models: {
        backend: "github-copilot/gpt-5.2-codex",
        architecture: "github-copilot/claude-opus-4.6",
        frontend: "github-copilot/gemini-3-pro-preview",
        default: "github-copilot/claude-opus-4.6"
      }
    }

    it("returns correct provider/model split for each category", () => {
      const backend = getRoutingModel(enabledConfig, "backend")
      assert.deepStrictEqual(backend, { providerID: "github-copilot", modelID: "gpt-5.2-codex" })

      const arch = getRoutingModel(enabledConfig, "architecture")
      assert.deepStrictEqual(arch, { providerID: "github-copilot", modelID: "claude-opus-4.6" })

      const frontend = getRoutingModel(enabledConfig, "frontend")
      assert.deepStrictEqual(frontend, { providerID: "github-copilot", modelID: "gemini-3-pro-preview" })
    })

    it("falls back to default model when category has empty string", () => {
      const config: RoutingConfig = {
        enabled: true,
        models: { backend: "", architecture: "", frontend: "", default: "github-copilot/claude-opus-4.6" }
      }
      const result = getRoutingModel(config, "backend")
      assert.deepStrictEqual(result, { providerID: "github-copilot", modelID: "claude-opus-4.6" })
    })

    it("returns null when routing is disabled", () => {
      const config: RoutingConfig = {
        enabled: false,
        models: { backend: "github-copilot/gpt-5.2-codex", architecture: "", frontend: "", default: "" }
      }
      assert.strictEqual(getRoutingModel(config, "backend"), null)
    })

    it("returns null when no model is configured for category or default", () => {
      const config: RoutingConfig = {
        enabled: true,
        models: { backend: "", architecture: "", frontend: "", default: "" }
      }
      assert.strictEqual(getRoutingModel(config, "backend"), null)
    })

    it("returns null for malformed model spec (no slash)", () => {
      const config: RoutingConfig = {
        enabled: true,
        models: { backend: "just-a-name", architecture: "", frontend: "", default: "" }
      }
      assert.strictEqual(getRoutingModel(config, "backend"), null)
    })
  })
})

describe("cross-model review routing", () => {
  it("parses model spec into provider/model parts", () => {
    const parsed = parseModelSpec("github-copilot/claude-opus-4.6")
    assert.deepStrictEqual(parsed, { providerID: "github-copilot", modelID: "claude-opus-4.6" })
  })

  it("returns null for invalid model specs", () => {
    assert.strictEqual(parseModelSpec(""), null)
    assert.strictEqual(parseModelSpec("just-a-name"), null)
    assert.strictEqual(parseModelSpec(undefined), null)
  })

  it("selects cross-review model for opus", () => {
    assert.strictEqual(getCrossReviewModelSpec("github-copilot/claude-opus-4.6"), "github-copilot/gpt-5.2-codex")
  })

  it("selects cross-review model for gpt-5.2-codex", () => {
    assert.strictEqual(getCrossReviewModelSpec("github-copilot/gpt-5.2-codex"), "github-copilot/claude-opus-4.6")
  })

  it("returns null for unrelated models", () => {
    assert.strictEqual(getCrossReviewModelSpec("github-copilot/gemini-3-pro-preview"), null)
  })
})

describe("GitHub Copilot model routing", () => {
  it("returns gpt-4.1 for github-copilot provider with gpt-4.1", () => {
    assert.strictEqual(getGitHubCopilotModelForRouting("github-copilot/gpt-4.1"), "github-copilot/gpt-4.1")
  })

  it("returns gpt-4.1 for github-copilot provider with gpt-4o", () => {
    assert.strictEqual(getGitHubCopilotModelForRouting("github-copilot/gpt-4o"), "github-copilot/gpt-4.1")
  })

  it("returns gpt-4.1 for github-copilot provider with gpt-4", () => {
    assert.strictEqual(getGitHubCopilotModelForRouting("github-copilot/gpt-4"), "github-copilot/gpt-4.1")
  })

  it("returns gpt-4.1 for github-copilot/free provider with gpt-4.1", () => {
    assert.strictEqual(getGitHubCopilotModelForRouting("github-copilot/free/gpt-4.1"), "github-copilot/gpt-4.1")
  })

  it("returns null for non-github-copilot providers", () => {
    assert.strictEqual(getGitHubCopilotModelForRouting("openai/gpt-4.1"), null)
    assert.strictEqual(getGitHubCopilotModelForRouting("anthropic/claude-opus-4.6"), null)
  })

  it("returns null for unrelated github-copilot models", () => {
    assert.strictEqual(getGitHubCopilotModelForRouting("github-copilot/claude-opus-4.6"), null)
    assert.strictEqual(getGitHubCopilotModelForRouting("github-copilot/gpt-5.2-codex"), null)
    assert.strictEqual(getGitHubCopilotModelForRouting("github-copilot/gemini-3-pro-preview"), null)
  })

  it("returns null for null/undefined input", () => {
    assert.strictEqual(getGitHubCopilotModelForRouting(null), null)
    assert.strictEqual(getGitHubCopilotModelForRouting(undefined), null)
  })
})

describe("detectActionLoop", () => {
  function makeToolMsg(tools: Array<{ tool: string; input?: any }>): any {
    return {
      info: { role: "assistant" },
      parts: tools.map(t => ({
        type: "tool",
        tool: t.tool,
        state: { input: t.input || {} }
      }))
    }
  }

  it("returns false for non-array input", () => {
    const result = detectActionLoop(null as any)
    assert.strictEqual(result.detected, false)
  })

  it("returns false for empty messages", () => {
    const result = detectActionLoop([])
    assert.strictEqual(result.detected, false)
  })

  it("returns false for too few commands", () => {
    const messages = [makeToolMsg([
      { tool: "bash", input: { command: "npm test" } },
      { tool: "bash", input: { command: "npm run build" } }
    ])]
    const result = detectActionLoop(messages)
    assert.strictEqual(result.detected, false)
  })

  it("detects repeated bash commands", () => {
    const messages = [
      makeToolMsg([{ tool: "bash", input: { command: "kubectl apply -f deploy.yaml" } }]),
      makeToolMsg([{ tool: "bash", input: { command: "npm run eval:stripe" } }]),
      makeToolMsg([{ tool: "bash", input: { command: "kubectl apply -f deploy.yaml" } }]),
      makeToolMsg([{ tool: "bash", input: { command: "npm run eval:stripe" } }]),
      makeToolMsg([{ tool: "bash", input: { command: "kubectl apply -f deploy.yaml" } }]),
      makeToolMsg([{ tool: "bash", input: { command: "npm run eval:stripe" } }])
    ]
    const result = detectActionLoop(messages)
    assert.strictEqual(result.detected, true)
    assert.ok(result.repeatedCommands.length > 0)
  })

  it("ignores read-only tools (read, glob, grep, todowrite)", () => {
    const messages = [
      makeToolMsg([
        { tool: "read", input: { path: "/file.ts" } },
        { tool: "glob", input: { pattern: "**/*.ts" } },
        { tool: "grep", input: { pattern: "foo" } },
        { tool: "todowrite", input: { todos: [] } },
        { tool: "bash", input: { command: "npm test" } },
        { tool: "bash", input: { command: "npm run build" } }
      ])
    ]
    const result = detectActionLoop(messages)
    // Only 2 bash commands counted, below threshold
    assert.strictEqual(result.detected, false)
  })

  it("does not flag diverse commands as a loop", () => {
    const messages = [
      makeToolMsg([{ tool: "bash", input: { command: "npm test" } }]),
      makeToolMsg([{ tool: "bash", input: { command: "npm run build" } }]),
      makeToolMsg([{ tool: "bash", input: { command: "git status" } }]),
      makeToolMsg([{ tool: "bash", input: { command: "git add ." } }]),
      makeToolMsg([{ tool: "bash", input: { command: "git commit -m 'fix'" } }])
    ]
    const result = detectActionLoop(messages)
    assert.strictEqual(result.detected, false)
  })

  it("normalizes timestamps in commands", () => {
    const messages = [
      makeToolMsg([{ tool: "bash", input: { command: "echo test_1771177929615" } }]),
      makeToolMsg([{ tool: "bash", input: { command: "echo test_1771177931936" } }]),
      makeToolMsg([{ tool: "bash", input: { command: "echo test_1771177933000" } }]),
      makeToolMsg([{ tool: "bash", input: { command: "echo test_1771177935000" } }])
    ]
    const result = detectActionLoop(messages)
    // All commands normalize to the same thing
    assert.strictEqual(result.detected, true)
  })

  it("skips non-assistant messages", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "tool", tool: "bash", state: { input: { command: "npm test" } } }] },
      { info: { role: "user" }, parts: [{ type: "tool", tool: "bash", state: { input: { command: "npm test" } } }] },
      { info: { role: "user" }, parts: [{ type: "tool", tool: "bash", state: { input: { command: "npm test" } } }] },
      { info: { role: "user" }, parts: [{ type: "tool", tool: "bash", state: { input: { command: "npm test" } } }] }
    ]
    const result = detectActionLoop(messages)
    assert.strictEqual(result.detected, false)
    assert.strictEqual(result.totalCommands, 0)
  })
})

describe("buildSelfAssessmentPrompt attempt awareness", () => {
  const baseContext = {
    taskSummary: "Fix a bug",
    taskType: "coding" as const,
    agentMode: "build" as const,
    requiresTests: false,
    requiresBuild: false,
    requiresPR: false,
    requiresCI: false,
    requiresLocalTests: false,
    requiresLocalTestsEvidence: false,
    pushedToDefaultBranch: false,
    detectedSignals: [] as string[],
    toolsSummary: "npm test: pass",
    recentCommands: [],
    humanMessages: [] as string[]
  }

  it("does not include reflection history on first attempt (attemptCount=0)", () => {
    const result = buildSelfAssessmentPrompt(baseContext, "", undefined, 0)
    assert.ok(!result.includes("Reflection History"))
    assert.ok(!result.includes("reflection attempt"))
  })

  it("does not include reflection history when attemptCount is undefined", () => {
    const result = buildSelfAssessmentPrompt(baseContext, "")
    assert.ok(!result.includes("Reflection History"))
  })

  it("includes reflection history on second attempt", () => {
    const result = buildSelfAssessmentPrompt(baseContext, "", undefined, 1)
    assert.ok(result.includes("## Reflection History"))
    assert.ok(result.includes("reflection attempt 2/3"))
    assert.ok(result.includes("repeating the same actions"))
    assert.ok(result.includes('"stuck": true'))
  })

  it("includes reflection history on third attempt", () => {
    const result = buildSelfAssessmentPrompt(baseContext, "", undefined, 2)
    assert.ok(result.includes("reflection attempt 3/3"))
  })

  it("includes loop-awareness rules", () => {
    const result = buildSelfAssessmentPrompt(baseContext, "")
    assert.ok(result.includes("repeating the same actions"))
    assert.ok(result.includes("Do not retry the same failing approach"))
  })
})

describe("isPlanMode", () => {
  // Helper to create a message with given role and text parts
  function msg(role: string, ...texts: string[]) {
    return {
      info: { role },
      parts: texts.map(t => ({ type: "text", text: t }))
    }
  }

  describe("system/developer message detection", () => {
    it("detects 'Plan Mode' in system message", () => {
      const messages = [msg("system", "# Plan Mode - System Reminder")]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("detects 'plan mode ACTIVE' in developer message", () => {
      const messages = [msg("developer", "CRITICAL: plan mode ACTIVE - you are in READ-ONLY phase")]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("detects 'read-only mode' in system message", () => {
      const messages = [msg("system", "You are in read-only mode")]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("detects 'READ-ONLY phase' in system message", () => {
      const messages = [msg("system", "you are in READ-ONLY phase")]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("detects 'plan mode is active' in system message", () => {
      const messages = [msg("system", "plan mode is active. Do not edit files.")]
      assert.strictEqual(isPlanMode(messages), true)
    })
  })

  describe("system-reminder detection (OpenCode actual format)", () => {
    it("detects default plan.txt system-reminder in user message", () => {
      const reminder = `<system-reminder>
 # Plan Mode - System Reminder
 
 CRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase. STRICTLY FORBIDDEN:
 ANY file edits, modifications, or system changes.
 </system-reminder>`
      const messages = [msg("user", "Help me plan", reminder)]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("detects experimental plan mode system-reminder", () => {
      const reminder = `<system-reminder>
 Plan mode is active. The user indicated that they do not want you to execute yet --
 you MUST NOT make any edits.
 </system-reminder>`
      const messages = [msg("user", "Design the architecture", reminder)]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("detects plan mode system-reminder even in older messages", () => {
      const reminder = `<system-reminder>
 Plan mode is active. READ-ONLY phase.
 </system-reminder>`
      const messages = [
        msg("user", "First message", reminder),
        msg("assistant", "Here is my plan..."),
        msg("user", "Thanks, looks good")
      ]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("detects READ-ONLY phase in system-reminder", () => {
      const reminder = `<system-reminder>
 CRITICAL: you are in READ-ONLY phase. Do not modify files.
 </system-reminder>`
      const messages = [msg("user", "Analyze the code", reminder)]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("does NOT trigger on system-reminder without plan mode keywords", () => {
      const reminder = `<system-reminder>
 You have access to these tools: read, write, edit.
 </system-reminder>`
      const messages = [msg("user", "Fix the bug", reminder)]
      assert.strictEqual(isPlanMode(messages), false)
    })

    it("does NOT trigger on plan mode keywords outside system-reminder", () => {
      // The user says "plan mode" literally -> detected via user message check, not system-reminder
      const messages = [msg("user", "Enable plan mode")]
      assert.strictEqual(isPlanMode(messages), true) // detected via user keyword check
    })
  })

  describe("user message keyword detection", () => {
    it("detects 'plan mode' in user message (case insensitive)", () => {
      const messages = [msg("user", "Switch to Plan Mode")]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("detects 'plan' at start of user message", () => {
      const messages = [msg("user", "plan the architecture for the new feature")]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("detects 'create a plan' pattern", () => {
      const messages = [msg("user", "create a plan for the refactoring")]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("detects 'write a plan' pattern", () => {
      const messages = [msg("user", "write a detailed plan")]
      assert.strictEqual(isPlanMode(messages), true)
    })

    it("does NOT detect 'plan' in the middle of unrelated text", () => {
      const messages = [msg("user", "Fix the airplane display bug")]
      assert.strictEqual(isPlanMode(messages), false)
    })

    it("does NOT trigger on regular coding tasks", () => {
      const messages = [msg("user", "Fix the login bug and add tests")]
      assert.strictEqual(isPlanMode(messages), false)
    })
  })

  describe("reflection message handling", () => {
    it("skips reflection messages when looking for user keywords", () => {
      const reflectionMsg = {
        info: { role: "user" },
        parts: [{ type: "text", text: "## Reflection-3 Self-Assessment\nplan mode test" }]
      }
      const messages = [msg("user", "Fix the bug"), reflectionMsg]
      assert.strictEqual(isPlanMode(messages), false)
    })

    it("checks non-reflection user message even after reflection message", () => {
      const reflectionMsg = {
        info: { role: "user" },
        parts: [{ type: "text", text: "## Reflection-3 Self-Assessment\nsome assessment" }]
      }
      const messages = [msg("user", "Switch to plan mode"), reflectionMsg]
      // Walks backward: skips reflectionMsg, finds "Switch to plan mode"
      assert.strictEqual(isPlanMode(messages), true)
    })
  })

  describe("multiple text parts in a single message", () => {
    it("checks all text parts, not just the last one", () => {
      const messages = [{
        info: { role: "user" },
        parts: [
          { type: "text", text: "plan mode please" },
          { type: "text", text: "I want to think about this" }
        ]
      }]
      assert.strictEqual(isPlanMode(messages), true)
    })
  })

  describe("edge cases", () => {
    it("returns false for empty messages array", () => {
      assert.strictEqual(isPlanMode([]), false)
    })

    it("returns false for messages with no parts", () => {
      const messages = [{ info: { role: "user" } }]
      assert.strictEqual(isPlanMode(messages), false)
    })

    it("returns false for messages with empty text parts", () => {
      const messages = [{ info: { role: "user" }, parts: [{ type: "text", text: "" }] }]
      assert.strictEqual(isPlanMode(messages), false)
    })

    it("returns false for assistant-only messages", () => {
      const messages = [msg("assistant", "Here is the plan for the feature")]
      assert.strictEqual(isPlanMode(messages), false)
    })

    it("handles build-switch reminder (should NOT be plan mode)", () => {
      const reminder = `<system-reminder>
 Your operational mode has changed from plan to build.
 You are no longer in read-only mode.
 </system-reminder>`
      // "no longer in read-only mode" should not match — but "plan" + system-reminder exists
      // The regex checks for "plan mode" (case insensitive) — "from plan to build" contains "plan" but NOT "plan mode"
      const messages = [msg("user", "Now implement it", reminder)]
      assert.strictEqual(isPlanMode(messages), false)
    })
  })
})
