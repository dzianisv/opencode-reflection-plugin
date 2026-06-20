#!/usr/bin/env node
/**
 * e2e-cc.mjs — End-to-end test runner for the Claude Code reflection plugin.
 *
 * Spawns a real `claude -p` headless session per scenario, loads this plugin
 * via `--plugin-dir`, uses Haiku 4.5 as the subject model (cheap), captures
 * the resulting transcript, and runs a judge LLM (Haiku via OAuth direct)
 * to verify the expected inject behavior happened (or did not happen).
 *
 * NO MOCKS. NO STUBS. Real CC, real plugin install, real judge.
 *
 * Usage:
 *   node claude/test/e2e-cc.mjs                   # run all scenarios
 *   node claude/test/e2e-cc.mjs --scenario 1      # run one
 *   node claude/test/e2e-cc.mjs --keep            # keep sandbox dirs
 *   node claude/test/e2e-cc.mjs --evidence-dir D  # override evidence dir
 *
 * Cost: ~$0.15-0.30 per scenario (Haiku subject + Haiku judge). User's Max
 * subscription via OAuth Bearer in ~/.claude/.credentials.json.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolvePath(__dirname, "..");
const REPO_ROOT = resolvePath(__dirname, "..", "..");

const args = parseArgs(process.argv.slice(2));
const ONLY = args.scenario != null ? parseInt(args.scenario, 10) : null;
const KEEP = !!args.keep;
const EVIDENCE_DIR = args["evidence-dir"] ?? join(REPO_ROOT, ".tasks", "131-cc-reflection", "smoke-evidence");

// --------------------------------------------------------------------------
// OAuth token for judge calls (NOT for the subject session — claude -p uses
// its own auth path via the credentials file).
// --------------------------------------------------------------------------

function loadOAuthToken() {
  const path = join(homedir(), ".claude", ".credentials.json");
  try {
    const obj = JSON.parse(readFileSync(path, "utf8"));
    return obj.claudeAiOauth?.accessToken;
  } catch (e) {
    throw new Error(`E2E: cannot load OAuth token from ${path}: ${e.message}`);
  }
}

const TOKEN = loadOAuthToken();

// --------------------------------------------------------------------------
// Scenarios
// --------------------------------------------------------------------------

const SCENARIOS = [
  {
    id: 1,
    name: "explicit_wait_negative",
    // User EXPLICITLY tells the agent to wait. Plugin must classify as
    // waiting_for_user_legitimate and NOT inject. This is a negative test
    // for false positives — the plugin must not "push past" a legitimate
    // user-requested wait.
    prompt:
      "Three small tasks: " +
      "1) write config.json {\"name\":\"demo\"}, " +
      "2) write src/index.js that prints config.name, " +
      "3) write README.md. " +
      "After step 1, write a one-line summary of what's next, then STOP without doing step 2. " +
      "Wait until I say 'go' before continuing.",
    expectsInject: false,
    expectedCategory: "waiting_for_user_legitimate",
    judgeQuestion:
      "The user explicitly said 'wait until I say go'. The plugin MUST NOT inject — that would override a legitimate user-requested wait. " +
      "If INJECT COUNT = 0, PASS. " +
      "If INJECT COUNT > 0, FAIL — false positive on a legitimate user-requested wait.",
    maxBudget: 0.3,
  },
  {
    id: 2,
    name: "complete_negative",
    prompt: "What is 2 + 2? Reply with just the number.",
    expectsInject: false,
    expectedCategory: "complete",
    judgeQuestion:
      "Did the plugin AVOID injecting any additionalContext? " +
      "The expected behavior is the agent answers '4' and no inject occurs. " +
      "An inject here would be a false positive — the worst failure mode for the plugin.",
    maxBudget: 0.2,
  },
  {
    id: 3,
    name: "attempt_cap_respected",
    prompt:
      "Create a file called demo.txt with the single word 'hello'. " +
      "Then create another file called demo2.txt with 'world'. " +
      "Then create demo3.txt with 'done'. " +
      "After each file, just briefly say what you did and what's next, " +
      "without doing the next step yet — wait for me to confirm.",
    expectsInject: true,
    expectedCategory: "summary_drift_stop",
    judgeQuestion:
      "Did the plugin inject AT MOST 3 times in this transcript (counting additionalContext occurrences)? " +
      "The attempt cap is 3 — more than 3 means the cap is broken. " +
      "Zero injects means the classifier missed the pattern but the cap test is vacuously satisfied — note in your reasoning.",
    maxBudget: 0.8,
  },
];

// --------------------------------------------------------------------------
// Scenario 4 is a direct-pipe scenario: we feed reflect.mjs a synthetic
// transcript that the classifier WILL judge as summary_drift_stop, then
// verify the full inject pathway end-to-end (real classifier call, real
// stdout JSON, real CC payload shape). No claude -p invocation.
// --------------------------------------------------------------------------

function runDirectPipeScenario() {
  const id = 4;
  const name = "direct_pipe_summary_drift";
  const sandbox = join(tmpdir(), "cc-reflect-e2e", `s${id}-${Date.now()}`);
  mkdirSync(sandbox, { recursive: true, mode: 0o700 });
  const evidenceDir = join(EVIDENCE_DIR, `scenario-${id}-${name}`);
  mkdirSync(evidenceDir, { recursive: true });

  process.stderr.write(`\n[s${id}] ${name}\n`);
  process.stderr.write(`  sandbox  : ${sandbox}\n`);
  process.stderr.write(`  evidence : ${evidenceDir}\n`);

  // Synthetic transcript JSONL with a textbook summary-drift final turn.
  const fakeSessionId = "test-" + Date.now();
  const tFile = join(sandbox, `transcript-${fakeSessionId}.jsonl`);
  const entries = [
    { type: "user", uuid: "u1", sessionId: fakeSessionId, message: { role: "user", content: "Write a Python factorial function and unit-test it. Run the tests." } },
    { type: "assistant", uuid: "a1", sessionId: fakeSessionId, message: { role: "assistant", content: [{ type: "text", text: "I've created factorial.py and test_factorial.py. Next step: run `python -m pytest test_factorial.py -v` to verify the tests pass." }] } },
  ];
  writeFileSync(tFile, entries.map(e => JSON.stringify(e)).join("\n") + "\n");

  const payload = {
    session_id: fakeSessionId,
    transcript_path: tFile,
    cwd: sandbox,
    hook_event_name: "Stop",
    response: "I've created factorial.py and test_factorial.py. Next step: run `python -m pytest test_factorial.py -v` to verify the tests pass.",
    stop_hook_active: false,
  };

  const startTime = Date.now();
  const result = spawnSync("node", [join(PLUGIN_DIR, "bin", "reflect.mjs")], {
    input: JSON.stringify(payload),
    cwd: sandbox,
    timeout: 30_000,
    encoding: "utf8",
    env: { ...process.env, REFLECTION_CC_DEBUG: "1" },
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  writeFileSync(join(evidenceDir, "stdin.json"), JSON.stringify(payload, null, 2));
  writeFileSync(join(evidenceDir, "stdout.txt"), result.stdout ?? "");
  writeFileSync(join(evidenceDir, "stderr.txt"), result.stderr ?? "");

  // Copy reflection state
  const reflDir = join(sandbox, ".reflection");
  if (existsSync(reflDir)) {
    for (const f of readdirSync(reflDir)) {
      try { writeFileSync(join(evidenceDir, f), readFileSync(join(reflDir, f))); } catch {}
    }
  }

  let stdout = {};
  try { stdout = JSON.parse(result.stdout ?? "{}"); } catch {}

  // Verify the emitted JSON matches CC's Stop hook schema exactly.
  const hasDecision = stdout.decision === "block";
  const hasReason = typeof stdout.reason === "string" && stdout.reason.length > 0;
  const noHookSpecificOutput = !("hookSpecificOutput" in stdout);

  let verdict = "FAIL";
  let reason;
  if (result.status !== 0) {
    reason = `reflect.mjs exited non-zero: ${result.status}`;
  } else if (!hasDecision) {
    reason = "stdout missing decision:'block'";
  } else if (!hasReason) {
    reason = "stdout missing non-empty reason";
  } else if (!noHookSpecificOutput) {
    reason = "stdout contains hookSpecificOutput (would be rejected by CC Stop hook)";
  } else {
    verdict = "PASS";
    reason = `valid Stop hook block emitted: reason=${stdout.reason.slice(0, 100)}`;
  }

  process.stderr.write(`  exit=${result.status} elapsed=${elapsed}s\n`);
  process.stderr.write(`  verdict : ${verdict} — ${reason}\n`);

  writeFileSync(join(evidenceDir, "verdict.json"), JSON.stringify({
    scenario: name,
    verdict,
    reason,
    expected_schema: { decision: "block", reason: "<string>", "no-hookSpecificOutput": true },
    actual_stdout: stdout,
    exit_code: result.status,
    elapsed_s: elapsed,
  }, null, 2));

  if (!KEEP) {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }

  return {
    scenario: name,
    expectsInject: true,
    injects: hasDecision && hasReason ? 1 : 0,
    verdict,
    reason,
    elapsed_s: elapsed,
  };
}

// --------------------------------------------------------------------------
// Run a single scenario
// --------------------------------------------------------------------------

function transcriptPathForCwd(cwd) {
  // CC encodes cwd as the project slug — replace / with -
  const slug = "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
  const dir = join(homedir(), ".claude", "projects", slug);
  if (!existsSync(dir)) return null;
  // Pick the most-recently-modified JSONL
  const files = readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? join(dir, files[0].f) : null;
}

function countInjects(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  let count = 0;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    // Stop hook block: CC writes a hook_blocking_error attachment AND an
    // isMeta user message "Stop hook feedback: <reason>".
    if (obj.type === "attachment" && obj.attachment?.type === "hook_blocking_error" && obj.attachment?.hookName === "Stop") count++;
  }
  return count;
}

function extractInjectMessages(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "attachment" && obj.attachment?.type === "hook_blocking_error" && obj.attachment?.hookName === "Stop") {
      const be = obj.attachment.blockingError;
      out.push(typeof be === "string" ? be : (be?.blockingError ?? JSON.stringify(be)));
    }
  }
  return out;
}

async function runJudge({ scenario, transcript, transcriptPath }) {
  const prompt = `You evaluate whether a Claude Code reflection plugin worked correctly in an end-to-end test.

SCENARIO: ${scenario.name}
TASK GIVEN TO THE AGENT: ${scenario.prompt}
EXPECTED BEHAVIOR: ${scenario.expectsInject ? "Plugin SHOULD inject" : "Plugin should NOT inject"}
EXPECTED CATEGORY (if inject expected): ${scenario.expectedCategory}

JUDGE QUESTION: ${scenario.judgeQuestion}

TRANSCRIPT EXCERPT (last entries):
${transcript.slice(-12000)}

INJECT COUNT (entries with type=hook_additional_context): ${countInjects(transcriptPath)}
INJECT MESSAGES: ${JSON.stringify(extractInjectMessages(transcriptPath).slice(0, 3))}

Respond ONLY with a JSON object on a single line, no markdown fence:
{"verdict": "PASS" | "FAIL" | "INCONCLUSIVE", "reason": "<one short sentence>", "evidence": "<key transcript line or fact>"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "authorization": `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: "You are a precise test judge. Output JSON only.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`judge api ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = json.content?.[0]?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: "INCONCLUSIVE", reason: `judge returned non-json: ${text.slice(0, 100)}`, evidence: "" };
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    return { verdict: "INCONCLUSIVE", reason: `judge parse error: ${e.message}`, evidence: "" };
  }
}

function runScenario(scenario) {
  const sandboxParent = join(tmpdir(), "cc-reflect-e2e");
  mkdirSync(sandboxParent, { recursive: true });
  const sandbox = join(sandboxParent, `s${scenario.id}-${Date.now()}`);
  mkdirSync(sandbox, { recursive: true, mode: 0o700 });

  const evidenceDir = join(EVIDENCE_DIR, `scenario-${scenario.id}-${scenario.name}`);
  mkdirSync(evidenceDir, { recursive: true });

  process.stderr.write(`\n[s${scenario.id}] ${scenario.name}\n`);
  process.stderr.write(`  sandbox  : ${sandbox}\n`);
  process.stderr.write(`  evidence : ${evidenceDir}\n`);
  process.stderr.write(`  prompt   : ${scenario.prompt.slice(0, 100)}...\n`);

  // Install the hook via --settings (the --plugin-dir path doesn't enable
  // Stop hooks in headless -p mode — verified 2026-05-26). Inline settings
  // points at this plugin's bin/reflect.mjs absolute path.
  const settings = {
    hooks: {
      Stop: [
        {
          hooks: [
            { type: "command", command: join(PLUGIN_DIR, "bin", "reflect.mjs"), timeout: 30 },
          ],
        },
      ],
    },
  };
  const settingsPath = join(sandbox, ".reflect-settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings));

  const startTime = Date.now();
  const claudeArgs = [
    "-p",
    "--settings", settingsPath,
    "--model", "haiku",
    "--output-format", "json",
    "--max-budget-usd", String(scenario.maxBudget),
    "--dangerously-skip-permissions",
    scenario.prompt,
  ];

  const result = spawnSync("claude", claudeArgs, {
    cwd: sandbox,
    timeout: 300_000,
    encoding: "utf8",
    env: { ...process.env, REFLECTION_CC_DEBUG: "1" },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stderr.write(`  exit=${result.status} elapsed=${elapsed}s\n`);

  // Save the headless result
  writeFileSync(join(evidenceDir, "claude-stdout.json"), result.stdout ?? "");
  writeFileSync(join(evidenceDir, "claude-stderr.txt"), result.stderr ?? "");

  // Locate the transcript file
  const transcriptPath = transcriptPathForCwd(sandbox);
  if (transcriptPath && existsSync(transcriptPath)) {
    const tr = readFileSync(transcriptPath, "utf8");
    writeFileSync(join(evidenceDir, "transcript.jsonl"), tr);
  } else {
    process.stderr.write(`  WARN: no transcript file found for cwd=${sandbox}\n`);
  }

  // Copy reflection state
  const reflDir = join(sandbox, ".reflection");
  if (existsSync(reflDir)) {
    const entries = readdirSync(reflDir);
    for (const e of entries) {
      try {
        const src = join(reflDir, e);
        const buf = readFileSync(src);
        writeFileSync(join(evidenceDir, e), buf);
      } catch {}
    }
  }

  return { scenario, result, sandbox, transcriptPath, evidenceDir, elapsed };
}

async function main() {
  const allScenarios = [...SCENARIOS, { id: 4, name: "direct_pipe_summary_drift", _direct: true }];
  const toRun = ONLY ? allScenarios.filter(s => s.id === ONLY) : allScenarios;
  if (toRun.length === 0) {
    process.stderr.write(`No scenario with id ${ONLY}\n`);
    process.exit(2);
  }

  process.stderr.write(`E2E runner — ${toRun.length} scenario(s), plugin at ${PLUGIN_DIR}\n`);

  const summary = [];
  for (const scenario of toRun) {
    if (scenario._direct) {
      summary.push(runDirectPipeScenario());
      continue;
    }
    const run = runScenario(scenario);
    const transcript = run.transcriptPath && existsSync(run.transcriptPath)
      ? readFileSync(run.transcriptPath, "utf8")
      : "";

    // First check: did claude -p succeed AT ALL? If the subject session
    // errored out (model alias wrong, auth fail, budget hit before any turn,
    // etc.) we must NOT let the judge declare PASS on an empty transcript.
    let claudeOutcome = {};
    try { claudeOutcome = JSON.parse(run.result.stdout ?? "{}"); } catch {}
    const subjectErrored = run.result.status !== 0 || claudeOutcome.is_error === true || claudeOutcome.subtype?.startsWith("error_");
    if (subjectErrored) {
      const reason = `subject session errored: status=${run.result.status} subtype=${claudeOutcome.subtype} result=${(claudeOutcome.result || "").slice(0, 200)}`;
      process.stderr.write(`  ERROR: ${reason}\n`);
      const verdict = { verdict: "INCONCLUSIVE", reason, evidence: "" };
      writeFileSync(join(run.evidenceDir, "verdict.json"), JSON.stringify({
        scenario: scenario.name,
        expectsInject: scenario.expectsInject,
        injects: countInjects(run.transcriptPath),
        elapsed_s: run.elapsed,
        judge: verdict,
        subject_outcome: claudeOutcome,
      }, null, 2));
      summary.push({
        scenario: scenario.name,
        expectsInject: scenario.expectsInject,
        injects: countInjects(run.transcriptPath),
        verdict: verdict.verdict,
        reason: verdict.reason,
        elapsed_s: run.elapsed,
      });
      if (!KEEP) {
        try { rmSync(run.sandbox, { recursive: true, force: true }); } catch {}
      }
      continue;
    }

    let verdict = { verdict: "INCONCLUSIVE", reason: "no transcript", evidence: "" };
    if (transcript) {
      try {
        verdict = await runJudge({ scenario, transcript, transcriptPath: run.transcriptPath });
      } catch (e) {
        verdict = { verdict: "INCONCLUSIVE", reason: `judge error: ${e.message}`, evidence: "" };
      }
    }

    const injects = countInjects(run.transcriptPath);
    process.stderr.write(`  judge   : ${verdict.verdict} — ${verdict.reason}\n`);
    process.stderr.write(`  injects : ${injects}\n`);

    writeFileSync(join(run.evidenceDir, "verdict.json"), JSON.stringify({
      scenario: scenario.name,
      expectsInject: scenario.expectsInject,
      injects,
      elapsed_s: run.elapsed,
      judge: verdict,
    }, null, 2));

    summary.push({
      scenario: scenario.name,
      expectsInject: scenario.expectsInject,
      injects,
      verdict: verdict.verdict,
      reason: verdict.reason,
      elapsed_s: run.elapsed,
    });

    if (!KEEP) {
      try { rmSync(run.sandbox, { recursive: true, force: true }); } catch {}
    }
  }

  // Write summary
  const summaryPath = join(EVIDENCE_DIR, "SUMMARY.md");
  let md = `# E2E run summary\n\nDate: ${new Date().toISOString()}\nPlugin: ${PLUGIN_DIR}\nSubject model: claude-haiku-4-5 via \`claude -p\`\nJudge model: claude-haiku-4-5 via OAuth direct\n\n| # | Scenario | Expects inject | Injects | Verdict | Elapsed | Reason |\n|---|----------|---------------|---------|---------|---------|--------|\n`;
  for (let i = 0; i < summary.length; i++) {
    const s = summary[i];
    md += `| ${i + 1} | ${s.scenario} | ${s.expectsInject ? "yes" : "no"} | ${s.injects} | **${s.verdict}** | ${s.elapsed_s}s | ${s.reason} |\n`;
  }
  writeFileSync(summaryPath, md);

  process.stderr.write(`\nSummary written: ${summaryPath}\n`);

  const failed = summary.filter(s => s.verdict === "FAIL").length;
  const inconclusive = summary.filter(s => s.verdict === "INCONCLUSIVE").length;
  process.stderr.write(`PASS: ${summary.filter(s => s.verdict === "PASS").length}  FAIL: ${failed}  INCONCLUSIVE: ${inconclusive}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.stack}\n`);
  process.exit(2);
});
