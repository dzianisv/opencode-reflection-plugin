# Reflection-3: A Completion Verification Layer for Autonomous AI Coding Agents

*Why the reflection layer is the reason I only use open-source coding agents.*

## Abstract

AI coding agents routinely stop before their work is done. They claim success without running tests, merge code without verifying CI, or get stuck in planning loops without producing a single edit. Closed-source agents offer no mechanism to fix this -- you get what the vendor ships, and you wait for their next release. Open-source agents like [OpenCode](https://opencode.ai) and [Codex](https://github.com/openai/codex) are different: they expose the hooks, events, and session lifecycle that make it possible to build verification layers on top. **Reflection-3** is a plugin for OpenCode that exploits this openness by injecting a structured self-assessment and verification loop after every agent turn. When the agent goes idle, Reflection-3 inspects the session history, builds a task context, requests a structured self-assessment, evaluates it against workflow gates (tests, builds, PRs, CI), and -- if the task is incomplete -- pushes the agent to continue with targeted feedback. We describe the system design, the evaluation methodology we developed to validate it, and why this kind of infrastructure is only possible when the agent runtime is open.

## 1. Why Open-Source Coding Agents

I work with OpenCode and Codex. Nothing else. Not because they are the most polished or the most marketed, but because they are the only agents where I can change what happens after the model speaks.

Every coding agent has the same core problem: the model generates plausible output and then stops. Sometimes the output is correct. Sometimes it is incomplete. Sometimes it is wrong. The difference between a useful agent and a frustrating one is not the model -- it is what happens in that gap between "the model produced text" and "the task is actually done."

Closed-source agents (Cursor, Windsurf, Copilot Workspace) treat this gap as a product decision. They ship their own heuristics, their own retry logic, their own definition of "done." If their definition does not match yours, you file a feature request and wait. You cannot hook into the session lifecycle. You cannot intercept the idle event. You cannot inject a verification prompt. You cannot route feedback to a different model. You are a consumer of someone else's quality threshold.

Open-source agents treat this gap as an extension point. OpenCode fires a `session.idle` event with the full message history. It exposes `session.chat` for injecting messages, `session.create` for spawning ephemeral sessions, `session.delete` for cleanup. It lets plugins read tool call history, detect command patterns, and write verdict files that other plugins consume. Codex similarly exposes its execution model for external orchestration.

This is not a philosophical preference. It is an engineering requirement. The reflection layer described in this paper -- 1,800 lines of loop detection, workflow gate verification, escalating feedback, cross-model review, and structured evaluation -- exists because the runtime let me build it. None of it would be possible on a closed platform. Every hour I spend improving Reflection-3 compounds into every future session across every project. On a closed platform, that same hour would be spent adapting my workflow to someone else's constraints.

The rest of this paper describes what that reflection layer does, how it is evaluated, and why it matters for anyone who takes agent-assisted development seriously.

## 2. Problem Statement

Large language models are strong code generators but unreliable task completers. In a typical session, the agent might:

- **Stop prematurely** after editing a file, without running tests or creating a pull request.
- **Fall into a planning loop** -- reading files, running `git status`, and writing todo lists indefinitely without producing code.
- **Fall into an action loop** -- repeatedly re-running a failing test or deployment without changing the underlying code.
- **Claim completion** without evidence, using phrases like "the fix is ready" when no build or test command was executed.
- **Skip required workflow steps** like creating a PR, verifying CI checks, or running local tests after the latest changes.
- **Push directly to main/master**, bypassing the pull request workflow entirely.

These failure modes are silent. The user, trusting the agent's claim, moves on -- only to discover later that tests were never run, the PR was never created, or the code doesn't even compile. In agentic workflows where the human is not watching every step, this is a critical reliability gap.

### 2.1 Ground Truth from Real Sessions

We quantified this gap by mining 143 local OpenCode and Claude Code sessions. Using `compact()` to strip tool_result messages (which carry `role=user` and would otherwise inflate the count 8x), we extracted 634 real user-follow-up examples -- turns where the agent stopped and the user replied.

A 3-way majority-vote Haiku classifier labeled each of 227 cases where the agent stopped or asked, using the user's next message as the ground truth signal. Result:

**177/227 stops (78%) were premature.** Breakdown:
- **91 permission-seeking**: the response ended with a yes/no question about something the agent could do itself ("Want me to run the tests?", "Should I create the PR?")
- **68 stopped-with-todos**: the response listed "remaining tasks" or "next steps" and then stopped without doing them
- **41 legitimate**: genuine human blocks (OAuth, 2FA, credential retrieval) or complete tasks with evidence

This 78% figure is not an editorial claim. It is a measurement. It drove the prompt's antipattern section and the decisive PERMISSION-SEEKING test: if the final turn is a yes/no question about something the agent can do with its own tools and the action carries no irreversible risk, it is premature.

## 3. Relation to Reflexion

In the taxonomy of Lilian Weng's [*LLM Powered Autonomous Agents*](https://lilianweng.github.io/posts/2023-06-23-agent/) and Shinn et al. (2023), this plugin is a **Reflexion**-style self-improvement loop. The mapping is almost one-to-one:

| Reflexion concept | This plugin |
| --- | --- |
| **Actor** — the policy LLM that acts | The coding agent (OpenCode / Claude Code) |
| **Evaluator** — scores the trajectory | LLM-as-judge self-assessment, run in an isolated session |
| **Self-reflection** — verbal feedback added to working memory | Feedback string injected back into the chat / Stop-hook `block` reason |
| **Heuristic: "inefficient" trajectory** | `PLANNING_LOOP` detector — many tool calls, low write ratio |
| **Heuristic: "hallucination" = repeated actions** | `ACTION_LOOP` detector — same commands repeated above threshold |
| **"Up to three reflections in working memory"** | `MAX_ATTEMPTS = 3` |

**Where it differs from textbook Reflexion:**

- **Trigger granularity.** Classic Reflexion evaluates at episode end / trajectory failure. This plugin fires on every `session.idle` / `Stop` boundary -- i.e., every time the agent *thinks* it's done. The primary job is catching premature stops, not just failed runs.
- **Evaluator design.** Reflexion's evaluator is a task-specific heuristic. Here the evaluator's rubric is mined from 227 real stops (78% premature), layered on top of the two Reflexion-style heuristics.
- **Verbal, not numeric.** Like Reflexion (and unlike RLHF), feedback is natural language fed straight back into context -- no fine-tuning, no reward model, no gradient updates.

## 4. Design Principles

Reflection-3 is designed around three principles:

1. **Evidence over claims.** The agent must produce structured evidence of its work (test commands, PR URLs, CI status). Verbal assertions like "done" or "verified" are insufficient.

2. **Workflow gates, not style checks.** The plugin enforces objective process requirements -- tests ran and passed, PR exists, CI is green -- not subjective quality judgments about the code itself.

3. **Escalating feedback, not infinite loops.** The plugin provides increasingly direct feedback across a bounded number of attempts (default: 3), then yields control back to the user rather than looping forever.

## 5. System Architecture

### 5.1 Trigger and Guard Phase

Reflection-3 hooks into OpenCode's `session.idle` event, which fires whenever the agent finishes producing output. Before running any analysis, several guard checks prevent unnecessary or harmful reflection:

- **Judge/classifier session detection**: Sessions created by the plugin itself (for self-assessment, judging, or routing classification) are skipped to prevent recursive reflection.
- **Plan mode detection**: Sessions where the user explicitly requested a plan (not implementation) are skipped.
- **Abort detection**: When the user presses ESC to cancel, a brief race window (`ABORT_RACE_DELAY = 1500ms`) allows the `session.error` event to arrive before reflection starts. Sessions aborted within a 10-second cooldown window are skipped.
- **Deduplication**: Each user message is tracked by a signature. If reflection already ran for a given user message in a given session, it is not repeated.

### 5.2 Task Context Construction

The plugin builds a `TaskContext` object by scanning the full message history:

- **Task type inference**: A heuristic classifier categorizes the task as `coding`, `docs`, `research`, `ops`, or `other` based on keyword patterns in user messages and agent responses. This determines which workflow gates apply.
- **Repository signal detection**: The plugin reads `package.json` to determine if `test` and `build` scripts exist, and checks for `test/` or `tests/` directories.
- **Tool command extraction**: All bash commands from the session are extracted and analyzed. The plugin detects test commands (`npm test`, `pytest`, `go test`, `cargo test`), build commands, `gh pr` invocations, `git push` commands, and more.
- **Workflow requirement derivation**: Based on the task type and repository signals, the plugin determines which gates are required: local tests, build verification, PR creation, CI checks.

### 5.3 Self-Assessment

Rather than prompting the active agent session (which would pollute its context with JSON-format instructions), Reflection-3 creates an **ephemeral session** and sends a structured self-assessment prompt. The prompt includes:

- The task summary and detected type
- Workflow requirements (which gates must be satisfied)
- Recent tool commands and signals
- The agent's last response
- The current attempt count (for escalation context)

The self-assessment prompt asks the model to return a JSON object with fields including:
- `status`: complete, in_progress, blocked, stuck, or waiting_for_user
- `confidence`: numeric confidence score
- `evidence.tests`: whether tests ran, results, whether they ran after the latest changes, exact commands
- `evidence.build`: whether the build ran and its results
- `evidence.pr`: whether a PR was created, URL, CI status, whether CI was checked
- `remaining_work`, `next_steps`, `needs_user_action`
- `stuck` flag and `alternate_approach`

The ephemeral session is deleted after the response is received.

### 5.4 Evaluation Engine

If the JSON parses successfully, `evaluateSelfAssessment()` applies deterministic workflow gate checks against the structured evidence:

1. **Test verification**: If tests are required, the assessment must show `tests.ran === true`, `results === "pass"`, `ran_after_changes === true`, and must not be skipped for reasons like "flaky" or "not important".
2. **Local test command matching**: If local tests are required, the exact commands listed in the assessment must match commands actually executed in the session (cross-referenced against the extracted tool commands).
3. **Build verification**: If a build is required, `build.ran === true` and `results === "pass"`.
4. **PR and CI verification**: If a PR is required, the assessment must show the PR was created, provide a URL, and confirm CI checks passed. The plugin also cross-references against detected `gh pr` signals in the command history.
5. **Direct push detection**: If `git push` to `main` or `master` was detected, the task is flagged as requiring a PR instead.
6. **Stuck detection**: If the agent reports being stuck, it is prompted to rethink its approach.

If JSON parsing fails, the plugin falls back to a **judge session** -- a separate LLM call that analyzes the raw self-assessment text and returns a structured verdict.

### 5.5 Human Action Classification

A critical distinction in the evaluation is between items that **require human action** (OAuth consent, 2FA codes, API key retrieval from dashboards) and items the **agent should handle itself** (running commands, editing files, creating PRs). The plugin uses pattern matching to classify each "needs user action" item:

- Items matching human-only patterns (auth, login, credentials, upload) and NOT matching agent-action patterns are classified as human-only.
- If only human-only items remain, the plugin shows a toast notification and does **not** push the agent to continue.
- If agent-actionable items remain (even alongside human-only items), the plugin pushes feedback.

### 5.6 Loop Detection

Two distinct loop detectors run before feedback injection:

**Planning Loop Detector**: Fires when the agent has made many tool calls (>= 8) but the ratio of write operations to total operations is below 10%. This catches the common pattern where the agent reads files, checks git status, creates todo lists, and researches endlessly without writing any code. When detected for coding tasks, the feedback is an explicit "STOP: Planning Loop Detected" message instructing the agent to start implementing.

**Action Loop Detector**: Fires when the same commands are repeated 3+ times and repeated commands constitute >= 60% of all commands. This catches the pattern where the agent re-runs failing tests or deployments without changing the code that caused the failure.

### 5.7 Feedback and Routing

When the task is determined incomplete, the plugin constructs escalating feedback:

- **Attempts 1-2**: Structured feedback with missing items and next actions.
- **Attempt 3 (final)**: Direct warning that this is the last attempt, instructing the agent to either complete the work or explain what is blocking it.

Optionally, the feedback can be **model-routed**: a lightweight LLM classifier categorizes the task as `backend`, `architecture`, `frontend`, or `default`, and the feedback prompt is sent with a model override matching the task category. This allows routing architecture problems to Claude, backend tasks to GPT, and frontend work to Gemini.

### 5.8 Cross-Model Architecture

The logical extension of self-reflection is **cross-model review**. No matter how rigorous the prompt, a model reviewing its own work shares the same tokenizer biases, reasoning blind spots, and context window limitations as the "author" model. True reliability requires an adversarial or orthogonal review process.

We are currently prototyping a `CrossReview` plugin architecture that implements a "Committee of Agents":

1.  **Author (Claude-4.6-Opus):** Responsible for architecture, implementation, and initial self-assessment.
2.  **Reviewer (GPT-5.3-Codex):** A distinct model that receives the diff and the task description. Its prompt is optimized for logic verification and edge-case detection. It does not see the Author's reasoning chain, only the output.
3.  **Auditor (MiniMax-M2.5):** A specialized, high-context model focused purely on security (e.g., secret leaks, injection vulnerabilities) and specification compliance.

#### Plugin Architecture Example

The architecture relies on the `SessionManager` to spawn parallel, isolated context windows for each reviewer:

```typescript
interface ReviewSession {
  role: 'author' | 'reviewer' | 'auditor';
  modelId: string;
  verdict?: ReviewVerdict;
}

class CrossReviewOrchestrator {
  async runReview(task: Task, diff: string): Promise<Consensus> {
    // 1. Author (already done in main session)
    const authorVerdict = await this.getSelfAssessment(task);

    // 2. Spawn Reviewer (GPT-5.3)
    const reviewerSession = await this.sessionManager.create({
      model: 'gpt-5.3-codex',
      systemPrompt: PROMPTS.CODE_REVIEWER
    });
    const reviewerVerdict = await reviewerSession.analyze(diff);

    // 3. Spawn Auditor (MiniMax-M2.5)
    const auditorSession = await this.sessionManager.create({
      model: 'minimax-m2.5',
      systemPrompt: PROMPTS.SECURITY_AUDITOR
    });
    const auditorVerdict = await auditorSession.analyze(diff);

    // 4. Synthesize
    return this.consensusEngine.merge([
      authorVerdict,
      reviewerVerdict,
      auditorVerdict
    ]);
  }
}
```

If the Reviewer or Auditor dissents (e.g., Claude thinks it's done, but MiniMax finds a regex DoS vulnerability), the plugin injects the dissenting opinion back into the Author's session as a high-priority "Code Review Comment," blocking completion until resolved. This mirrors a human engineering team's workflow: code is not merged until independent reviewers approve.

### 5.9 Artifacts

Every reflection run produces two artifact files:

- **`verdict_<session>.json`**: A compact signal file (complete/incomplete, severity) consumed by downstream plugins (TTS reads it to decide whether to speak, Telegram reads it to gate notifications).
- **`<session>_<timestamp>.json`**: A full analysis record including task summary, self-assessment text, evaluation analysis, cross-review results, and routing decisions.

## 6. Claude Code Support

OpenCode fires `session.idle`. Claude Code fires `Stop`. They are different runtimes with different hook contracts, but the reflection idea applies to both.

### 6.1 Stop Hook Contract

Claude Code (v2.1.159+) supports external hooks via `hooks.json`. The contract has several non-obvious requirements that differ from what the documentation implies:

- **Event name is `Stop`, not `stop`** (case-sensitive).
- **Hook format is an array of hook groups**, not a flat object.
- **Payload field is `last_assistant_message`**, not `response`.
- **To re-prompt**: emit `{"decision":"block","reason":"<text>"}` to stdout and exit 0.
- **To approve**: exit 0 with no output.
- **Loop guard**: `stop_hook_active` in the env signals that the hook is already running; the hook must check this to prevent infinite re-prompt cycles.

Working `hooks.json`:
```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/bin/reflect.mjs",
        "timeout": 30
      }]
    }]
  }
}
```

### 6.2 macOS Keychain Auth

An unexpected production bug surfaced during the port: on macOS, Claude Code stores OAuth credentials in the **login keychain** (as a generic password named `Claude Code-credentials`), not in `~/.claude/.credentials.json`. The file path that worked on Linux was silently absent on macOS, causing the in-hook judge to fail all API calls without any error surfaced to the user.

Fix: try the file first; fall back to `security find-generic-password -s "Claude Code-credentials" -w` on darwin:

```js
if (platform() === 'darwin') {
  const out = execFileSync(
    'security',
    ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
    { encoding: 'utf8', timeout: 5_000 }
  );
  return JSON.parse(out.trim());
}
```

Verified by a live `claude -p` session: Stop hook fired → keychain-authed judge call succeeded → `block` decision emitted → agent re-prompted. The authentication path had never worked on macOS before this fix.

### 6.3 Install

**Claude Code** — via plugin marketplace:
```
/plugin marketplace add dzianisv/opencode-plugins
/plugin install reflection-cc
```

**OpenCode** — via `opencode.json`:
```json
{ "plugin": ["opencode-reflection"] }
```

The OpenCode package (`packages/reflection/`, published as `opencode-reflection` on npm) uses a symlink-swap trick for local development: `reflection-3.ts` is a symlink to the repo root during development; `prepack` copies the real file before `npm pack` and `postpack` restores the symlink.

## 7. Evaluation Methodology

Validating a reflection system is challenging because the ground truth ("was the task really complete?") is subjective and context-dependent. We developed a multi-layered evaluation strategy combining unit tests, prompt evaluations (evals), and end-to-end integration tests.

### 7.1 Unit Tests

The unit test suite (`test/reflection-3.unit.test.ts`, `test/reflection.test.ts`, `test/abort-race.test.ts`, `test/bad-request.test.ts`) covers the deterministic components of the system:

- **Task type inference**: Validates that `inferTaskType` correctly categorizes mixed signals (e.g., "investigate and fix this bug" should be `coding`, not `research`).
- **Self-assessment parsing**: Tests JSON extraction from model output, handling of malformed JSON, edge cases with missing fields.
- **Workflow gate evaluation**: Tests every gate independently -- missing tests, failing tests, skipped tests, missing PR, unchecked CI, direct push to main, etc.
- **Human action classification**: Tests the boundary between human-only actions (OAuth, 2FA) and agent-executable actions (running commands, editing files).
- **Planning loop detection**: Tests the read/write ratio calculation across various tool call distributions.
- **Action loop detection**: Tests command repetition counting and threshold evaluation.
- **Abort race condition**: Simulates the timing race between `session.idle` and `session.error` events to verify that aborted sessions are not reflected upon.
- **Error resilience**: Tests that `promptAsync` failures, session deletion during reflection, and other error conditions are handled gracefully without crashing the plugin.
- **Escalating feedback**: Tests that feedback messages become progressively more direct and include the correct attempt count.

### 7.2 Prompt Evaluations (Promptfoo)

The most novel aspect of our evaluation is the use of [Promptfoo](https://promptfoo.dev) to systematically test the LLM judge's accuracy. We maintain four evaluation suites:

#### 8.2.1 Judge Accuracy Evaluation (34 test cases)

The primary eval (`evals/promptfooconfig.yaml`) tests the judge prompt (`evals/prompts/task-verification.txt`) against 30 carefully constructed scenarios. Each test case provides a task description, tool usage history, and agent response, then asserts whether the judge correctly identifies the task as complete or incomplete. Categories include:

- **True positives** (should be complete): Simple file creation, passing test execution, bug fix with verification, multi-file refactoring with tests.
- **True negatives** (should be incomplete): Failed tests, mid-task stops, agents stopped after reading only, commit without testing, skipped/flaky tests.
- **Edge cases**: Human action required (OAuth, 2FA), task deviation (agent did something different than asked), multi-verification tasks (both voice AND browser tests required), planning-only sessions, retry loops, gold-plating, context exhaustion.

Each test uses JavaScript assertions to parse the judge's JSON output and verify the `complete`, `severity`, and `requires_human_action` fields. The eval tracks:
- **Judge accuracy**: Does the judge correctly identify complete vs. incomplete tasks?
- **False positive rate**: How often does the judge incorrectly mark incomplete tasks as complete?
- **False negative rate**: How often does the judge incorrectly mark complete tasks as incomplete?
- **Severity accuracy**: Does the judge assign appropriate severity levels?

#### 8.2.2 Stuck Detection Evaluation (16 test cases)

Tests whether the model correctly classifies session state as `genuinely_stuck`, `waiting_for_user`, `working`, or `complete`. Scenarios include:
- Agents asking clarifying questions (should be `waiting_for_user`, not stuck)
- Active tool execution (should be `working`)
- Mid-sentence stops with no output (should be `genuinely_stuck`)
- Rate limiting and tool failures
- Planning loops (reading without writing)
- Long-running builds

#### 5.2.3 Post-Compression Nudge Evaluation (14 test cases)

Tests the correct action after context window compression: `needs_github_update`, `continue_task`, `needs_clarification`, or `task_complete`. Relevant because when OpenCode compresses the context window mid-task, the agent may lose track of what it was doing.

#### 8.2.3 Agent Evaluation Benchmark (10 test cases)

A holistic 0-5 scoring rubric evaluating overall agent task performance, from COMPLETE (5) through PARTIAL (3) to NO_ATTEMPT (0).

### 7.3 Evaluation Prompt Engineering

The judge prompt (`evals/prompts/task-verification.txt`) encodes evaluation rules developed iteratively through observed failure modes. Key rules include:

- **Security severity override**: Any security vulnerability forces `severity: BLOCKER` and `complete: false`.
- **Progress status detection**: Phrases like "IN PROGRESS", "Next steps:", or "Phase X of Y" force `complete: false` regardless of other indicators.
- **Delegation/deferral detection**: Agents that present options and ask "which would you prefer?" instead of completing the work are marked incomplete.
- **Human action required distinction**: A clear separation between "agent physically cannot do this" (OAuth, 2FA) and "agent chose not to do this" (running a command it has access to).
- **Temporal consistency**: Claims of readiness before verification ran, or later outputs contradicting earlier "done" claims, trigger rejection.
- **Task deviation detection**: If the agent performs a different task than requested (e.g., user asks to "check history and post YC update", agent deletes emails instead), this is a critical failure.
- **Flaky test protocol**: Tests dismissed as "flaky" without mitigation (rerun, quarantine, stabilization fix) trigger `severity >= HIGH`.

The antipattern section of the prompt is directly derived from the 227-session mining described in Section 2.1: PERMISSION-SEEKING and STOPPED-WITH-TODOS correspond precisely to the 91 + 68 observed cases.

### 7.4 Eval Model Selection and CI Cost

`promptfoo eval` exits non-zero on any single case failure. With the high-fidelity judge (`gpt-5.1`) this is correct -- it scores 34/34 -- but at meaningful cost per run.

We benchmarked every model available on our dev Azure endpoint (probed by actual chat call, not the region catalog -- 99% of catalog entries return `DeploymentNotFound`):

| Model | Judge score | Relative cost |
|-------|-------------|---------------|
| `gpt-5.1` | 34/34 | 1× (baseline) |
| `gpt-5.4` | 33/34 | ~8× cheaper |
| `gpt-5.4-mini` | 33/34 | ~15× cheaper |
| `gpt-5.4-nano` | 33/34 | ~25× cheaper |

The entire `gpt-5.4` family tops out at 33/34. The one miss is **calibration variance on a borderline case**, not a gap in the premature-stop logic the suite exists to protect. Crucially, patching the prompt to fix the cheap-model miss regressed `gpt-5.1` from 34/34 to 33/34 on a different borderline case. The models disagree on a gray area; the correct response is not to tune the prompt toward either one.

Solution: run CI with `gpt-5.4-nano` (~25× cheaper) and gate on `EVAL_PASS_THRESHOLD=0.97` -- a post-run pass-rate check that overrides promptfoo's native per-case exit code when the pass rate is at or above the threshold. The logic only ever relaxes a failing run; it never reddens a passing run, and a second case failure brings the rate below the threshold and turns CI red. The high-fidelity judge remains available as a one-line swap.

```js
// scripts/run-promptfoo.mjs
const threshold = parseFloat(process.env.EVAL_PASS_THRESHOLD ?? "")
if (exitCode !== 0 && Number.isFinite(threshold) && rate >= threshold) {
  process.exit(0)  // tolerate known borderline miss
}
process.exit(exitCode)
```

### 7.5 CI Integration

Evaluations run automatically via GitHub Actions on every PR that touches `reflection-3.ts` or `evals/**`. The workflow:
1. Runs the 34-case judge suite via `gpt-5.4-nano` with `EVAL_PASS_THRESHOLD=0.97`.
2. Uploads JSON results as artifacts.
3. Posts a summary comment on the PR with pass rates per suite.
4. Generates a step summary for the Actions UI.

A second failure (rate drops below 97%) turns the check red. This creates a regression safety net that is also economical enough to run on every PR.

### 7.6 End-to-End Tests

Full E2E tests (`test/e2e.test.ts`, `test/reflection-static.eval.test.ts`) start an actual OpenCode server with the reflection plugin loaded, send real tasks (e.g., "create a Python hello world script"), and verify:
- Reflection triggers after the agent goes idle
- Self-assessment is requested and received
- Workflow gates are evaluated
- Feedback is injected when appropriate
- Verdict signals are written to disk

A dedicated race condition E2E test (`test/reflection-race-condition.test.ts`) verifies that reflection aborts correctly when the user sends a new message during analysis.

## 8. Impact on Developer Experience

### 8.1 Reduced Silent Failures

Before Reflection-3, the most common failure mode was the agent stopping after partial work and the user not noticing. The plugin transforms this into an explicit feedback loop: if tests weren't run, the agent is told to run them. If the PR wasn't created, the agent is told to create one. This shifts the failure mode from "silent incomplete" to "visible and corrected."

### 8.2 Enforced Workflow Discipline

Many organizations have workflow requirements that developers follow habitually but agents ignore: run tests after changes, create PRs instead of pushing to main, verify CI before claiming completion. Reflection-3 makes these requirements machine-enforceable, bringing agent workflows up to the same standard as human developers.

### 8.3 Planning Loop Intervention

A particularly frustrating failure mode is the agent that endlessly reads files and plans without writing code. The planning loop detector catches this pattern and produces a pointed intervention: "You have been reading files, checking git status, and creating todo lists without writing any code. Start coding NOW. No more planning." In practice, this intervention is effective at unsticking agents that would otherwise loop indefinitely.

### 8.4 Bounded Autonomy

The escalating feedback mechanism with a maximum attempt count (default: 3) provides bounded autonomy. The agent gets multiple chances to complete its work, with increasingly direct guidance, but the system never loops forever. After the final attempt, control returns to the user with a clear status report.

### 8.5 Cross-Plugin Integration

The verdict signal files (`.reflection/verdict_<session>.json`) enable downstream plugins to make reflection-aware decisions. The TTS plugin reads the verdict to decide whether to speak the completion message. The Telegram plugin reads the verdict to gate notifications -- preventing "task complete" notifications when reflection determined the task was actually incomplete.

## 9. Limitations and Future Work

**Context cost.** Running self-assessment in an ephemeral session adds latency and token cost. The assessment prompt, including task context and the agent's last response, can be 2000-4000 tokens. For fast, simple tasks, this overhead may not be justified.

**Heuristic task typing.** The task type classifier uses regex patterns, which can misclassify ambiguous tasks. An LLM-based classifier would be more accurate but adds latency.

**Single-turn assessment.** The self-assessment evaluates a single point in time. It does not track whether the agent made progress between attempts, only whether the current state satisfies the workflow gates.

**Model dependence.** The quality of self-assessment depends on the model's ability to introspect on its own work accurately. Weaker models (filtered by `JUDGE_BLOCKED_PATTERNS`) are excluded from assessment duties, but even strong models can confabulate evidence.

**Eval cost/fidelity frontier.** The full `gpt-5.4` family tops out at 33/34 on the judge suite; the miss is calibration variance on a borderline case, not a gap in the premature-stop logic. The current approach (threshold tolerance at 97%) covers the judge suite. The stuck/compression/agent suites were not re-validated against cheaper models and still run on `gpt-5.1` at manual dispatch -- that coverage gap is the next cost-reduction target.

Future work includes richer progress tracking across reflection attempts, integration with code review tools for quality assessment (beyond workflow gates), and adaptive gate configuration based on project-specific CI/CD pipelines. The Claude Code port (section 6) remains experimental -- the stopped-with-todos and permission-seeking classifiers have not yet been validated against a CC-native dataset equivalent to the 227-session OpenCode benchmark.

## 10. Conclusion

Reflection-3 addresses a practical gap in autonomous AI coding: the distance between generating code and completing a task. By combining structured self-assessment, deterministic workflow gate evaluation, loop detection, and escalating feedback, the plugin transforms unreliable agent sessions into bounded, verifiable workflows. The multi-layered evaluation strategy -- unit tests for deterministic logic, promptfoo evals for judge accuracy, and E2E tests for system integration -- provides confidence that the reflection system itself is reliable.

But the deeper point is this: Reflection-3 exists because OpenCode is open. The plugin hooks into `session.idle`, creates ephemeral sessions, injects feedback, reads tool history, and writes verdict signals that other plugins consume. None of these extension points exist in closed-source agents. The entire verification layer -- every workflow gate, every loop detector, every escalating feedback message -- is user-authored infrastructure that compounds over time. When I improve the judge prompt, every future session benefits. When I add a new eval case, the regression net gets tighter. When I fix a false positive, every project in every repository sees the fix immediately.

This is why I use open-source coding agents exclusively. Not because the models are better -- they are the same models. Not because the UI is better -- it is a terminal. Because the runtime is mine. I can verify what the agent claims. I can enforce what the agent skips. I can detect when the agent is stuck and intervene with precision. And when the reflection layer itself has a bug, I can fix it, test it, and deploy it in the same session.

The agents that win will not be the ones with the best chat interface. They will be the ones that let their users build the verification and orchestration layers that the models themselves cannot provide. OpenCode and Codex are that kind of agent. Reflection-3 is proof of what becomes possible when the runtime gets out of your way.

---

*Reflection-3 is an open-source plugin for the OpenCode CLI. Source code, evaluation configs, and test suites are available at [github.com/anomalyco/opencode-plugins](https://github.com/anomalyco/opencode-plugins).*
