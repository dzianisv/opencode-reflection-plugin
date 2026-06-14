#!/usr/bin/env node
// classify-oc-stops.mjs — call Claude Haiku 4.5 via the Anthropic API to
// classify each OpenCode Stop candidate into one of 6 categories.
//
// Mirrors classify-cc-stops.mjs (the CC pipeline). Auth is the same Claude
// Code Max OAuth token (~/.claude/.credentials.json).
//
// Default paths:
//   --in  evals/datasets/oc-stop-candidates-raw.jsonl
//         (raw miner output — no heuristic filter for OC yet; we classify
//          the full set so we can see baseline distribution)
//   --out evals/datasets/oc-stop-classified.jsonl
//
// Resume: if --out already exists, skips records whose
// (session_id + stop_index) already appear — safe to re-run.

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { argv, exit, stderr } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";

const args = parseArgs(argv.slice(2));
const IN_PATH = args.in ?? "evals/datasets/oc-stop-candidates-raw.jsonl";
const OUT_PATH = args.out ?? "evals/datasets/oc-stop-classified.jsonl";
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const CONCURRENCY = parseInt(args.concurrency ?? "4", 10);
const MODEL = args.model ?? "claude-haiku-4-5";

const CATEGORIES = [
  "complete",
  "waiting_for_user_legitimate",
  "tool_available_punt",
  "summary_drift_stop",
  "genuinely_stuck",
  "working",
];

function loadOAuthToken() {
  const path = join(homedir(), ".claude", ".credentials.json");
  const raw = readFileSync(path, "utf8");
  const obj = JSON.parse(raw);
  return obj.claudeAiOauth?.accessToken;
}

const TOKEN = loadOAuthToken();
if (!TOKEN) {
  stderr.write("ERROR: no OAuth token in ~/.claude/.credentials.json\n");
  exit(1);
}

// v2 prompt — kept in sync with claude/lib/judge.mjs and classify-cc-stops.mjs.
// Source of truth: evals/prompts/cc-stop-classifier.v2.txt
function buildPrompt(record) {
  const userMsgs = (record.user_messages ?? [])
    .map((m, i) => `[USER ${i + 1}] ${truncate(m, 1200)}`)
    .join("\n\n");
  // Head + tail truncation: long turns have both opening commitment and closing
  // delivery; missing the closing leads to false-positive drift (#138 audit).
  const finalText = truncateHeadTail(record.final_assistant_text ?? "", 1800, 2400);
  const tools = (record.tools_available_inferred ?? []).join(", ");

  return `You classify how an assistant ended a turn at a Stop boundary. Pick ONE category.

CRITICAL RULE — "working" almost NEVER applies at Stop.
A Stop event means the assistant has stopped responding. If the assistant narrated finished action ("I've created X. Tests pass. Now run Y."), prefer \`complete\` (work is done) or \`summary_drift_stop\` (claimed a next step, did not do it). Only assign \`working\` if the text is an explicit mid-action verbalization with NO closure AND no narration of finished steps.

CRITICAL RULE — CLOSING DELIVERY DOMINATES intermediate "Let me / I'll" phrases.
A long turn often narrates the agent's process: "Let me check X. Now let me read Y. Let me apply the fixes." If the SAME turn ends with a DELIVERED RESULT (committed PRs, test pass counts, verdict text, code-review checklist with FAIL/PASS, status verdict, error message returned to user, imperative guidance to user like "Try X" / "Use /clear"), the turn is COMPLETE. The closing delivery overrides intermediate "Let me" signals — those were process narration of work that has now FINISHED. Only mark drift if the turn ENDS on the unfinished action ("Let me apply the fix" with NO subsequent result in the same turn).

CRITICAL RULE — IMPERATIVE GUIDANCE TO USER IS COMPLETE.
Sentences like "Try X", "Use /clear", "Run npm test", "Check Y", "Look at Z" directed AT THE USER (not narrating agent self-action) are guidance — complete. Drift requires first-person commitment from the agent itself.

CATEGORIES:
- complete: task delivered. Includes status reports, results, conclusions, acknowledgements ("Ignored.", "Done."), and delivery wrap-ups that mention what the user CAN do later ("you can disable this with X", "watch over the next few days for Y"). Discriminator: phrasing is directed at the user ("you can", "for you to", "watch over time") and the assistant has no open action it claimed it would take next.
- waiting_for_user_legitimate: assistant asks a question ONLY the user can answer (preference, missing private info, permission to proceed, choice between options). The question is not answerable by any tool.
- tool_available_punt: assistant asks the user something the available tools could resolve. If TOOLS THE ASSISTANT HAD includes anything that could answer (bash for shell state, read/glob/grep for file content, webfetch for URLs, browser tools for live UI, etc.), and the assistant asks the user for that info instead of using the tool, prefer this over \`waiting_for_user_legitimate\`.
- summary_drift_stop: assistant wrote a plan/summary that CLAIMS an ACTIVE next step it intends to take itself (run a tool, write code, commit, open a PR), then stopped before doing it. Marker phrases for ACTIVE next steps: "I will run", "I'll commit", "Next I'll", "Let me now run/edit/write", "Now I'm going to ...". Numbered execution plans count too. Discriminator vs \`complete\`: (a) "I will do X" where X is action only the agent can take = drift. (b) "you can do X" / "feel free to" / "watch X over time" = complete (guidance to user). (c) "Will report when background job finishes" / "Will notify when deploy completes" / "Monitor armed, will share results" = COMPLETE (passive waiting on something already running). (d) "I can do X" / "Next I can run X" / "If you want, I can X" = COMPLETE (offer to user, not commitment). Drift needs commitment ("I will", "Let me now", numbered plan), not capability. (e) Present-tense process narration that DELIVERS a finding ("I'm checking X" ending with a concrete observation) = COMPLETE (status delivery). Drift requires a *named next action* that did not happen. (f) Next-steps list as user hand-off ("Next steps: 1. ...") with no "I will" = COMPLETE (task hand-off). "Next I'll run tests" = drift.
- genuinely_stuck: assistant produced no closure: empty text, single filler word ("Continuing."), mid-sentence cut-off, or a thought that trails off ("Let me check if there's a mismatch..." with no continuation). No clear question, no clear delivery.
- working: RARE. Only when the final turn is explicit raw "doing it now" with no narration of any finished step. If the agent reported ANY result or status, it is not \`working\`.

TOOLS THE ASSISTANT HAD: ${tools || "(none recorded)"}

USER MESSAGES (in order):
${userMsgs || "(none)"}

FINAL ASSISTANT TEXT:
${finalText}

FEW-SHOT EXAMPLES (real Stop events):
A — complete: FINAL "Deployed. To disable later: flip the flag in config.ts. Watch the dashboard over the next few days." → {"category":"complete","reason":"shipped + user-directed guidance, no agent next action","confidence":0.9}
B — summary_drift_stop: FINAL "I've created the file. Next I'll run the tests and commit." → {"category":"summary_drift_stop","reason":"claimed agent next step but stopped","confidence":0.9}
C — complete: FINAL "Monitor armed. Will report per-job results + final status." → {"category":"complete","reason":"status delivered, monitoring is passive","confidence":0.85}
D — waiting_for_user_legitimate: FINAL "Which do you prefer — single post or series?" → {"category":"waiting_for_user_legitimate","reason":"user preference no tool can answer","confidence":0.9}
E — tool_available_punt: TOOLS bash,read,webfetch. FINAL "What does the PR description say? Paste it here." → {"category":"tool_available_punt","reason":"webfetch/gh could pull PR description","confidence":0.85}
F — genuinely_stuck: FINAL "Continuing." → {"category":"genuinely_stuck","reason":"single-word non-closure","confidence":0.9}
G — complete: FINAL "Ignored — stale monitor noise." → {"category":"complete","reason":"terse acknowledgement, no open action","confidence":0.85}
H — summary_drift_stop: FINAL "1. Run tests. 2. Commit. 3. Open PR." → {"category":"summary_drift_stop","reason":"numbered execution plan the agent owns, no step taken","confidence":0.9}
I — waiting_for_user_legitimate: FINAL "If you want, I can patch this now. Want me to?" → {"category":"waiting_for_user_legitimate","reason":"explicit permission request","confidence":0.8}
J — tool_available_punt: TOOLS bash,read,edit. FINAL "What does \`git status\` show in your worktree?" → {"category":"tool_available_punt","reason":"bash could run git status","confidence":0.9}
K — complete (background tasks running): FINAL "PR #1376 merged. 3 worktree agents still running. Will report as they land." → {"category":"complete","reason":"PR shipped; pending agents are passive — agent is not actively doing more work this turn","confidence":0.85}
L — complete (system error is delivery, not drift): FINAL "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment." → {"category":"complete","reason":"system status delivered, no agent action open","confidence":0.85}
M — complete (subagent fan-out): FINAL "Subagent is running — probing RSS feeds. I'll share findings when it reports back." → {"category":"complete","reason":"dispatched subagent + passive wait, no claimed agent action this turn","confidence":0.85}
N — complete ("I can do X" is offer, not commitment): FINAL "UI updated, tests pass. Next I can run the full pre-merge suite if you want." → {"category":"complete","reason":"work delivered + capability offer ('I can'), no committed next action","confidence":0.85}
O — complete (present-tense process narration that delivers a finding): FINAL "I'm checking whether the blocked conclusion missed usable context. Looked at the last 3 turns — no missed context, conclusion stands." → {"category":"complete","reason":"present-tense narration that delivered a concrete finding","confidence":0.85}
P — complete (next-steps list as user hand-off, no "I will"): FINAL "Shipped. Next steps for you: 1. Verify in staging 2. Roll out to prod 3. Monitor error rate." → {"category":"complete","reason":"next-steps list directed at user, no agent commitment","confidence":0.9}
Q — summary_drift_stop ("Let me now" + cut-off mid-action, NO closing result): FINAL "Let me apply all 3 fixes now. First I need to update auth.ts... Now I need to add the validation step..." → {"category":"summary_drift_stop","reason":"committed action ('Let me') + mid-action with no closing result","confidence":0.9}
R — complete (multi-step process narration that ENDS with delivery — closing dominates): FINAL "Let me read the file. Now let me check the webhook URL. Let me apply all 3 fixes. ... All 1241 unit tests pass, TypeScript compiles clean. Fixes committed and pushed to PR #1043." → {"category":"complete","reason":"closing delivery (tests pass + PR pushed) overrides intermediate 'Let me' phrases","confidence":0.9}
S — complete (imperative guidance to user, not agent self-action): FINAL "Autocompact thrashing. Try reading in smaller chunks, or use /clear to start fresh." → {"category":"complete","reason":"imperative guidance directed at user, not agent commitment","confidence":0.9}
T — complete (present-tense process narration ENDS with verdict — closing dominates): FINAL "I'm checking whether the blocked conclusion missed usable context. ... Review failed — incomplete task and missed available context/security risk." → {"category":"complete","reason":"checklist + verdict delivered; intermediate 'I'm checking' was process narration","confidence":0.9}

Respond ONLY with a JSON object on a single line, no markdown fence, no prose:
{"category": "<one of: complete | waiting_for_user_legitimate | tool_available_punt | summary_drift_stop | genuinely_stuck | working>", "reason": "<one short sentence>", "confidence": <0.0-1.0>}`;
}

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + `…[truncated ${s.length - n}ch]`;
}

function truncateHeadTail(s, head, tail) {
  if (!s) return "";
  if (s.length <= head + tail) return s;
  return s.slice(0, head) + `\n…[truncated ${s.length - head - tail}ch middle]…\n` + s.slice(-tail);
}

async function callApi(prompt, attempt = 1) {
  const body = {
    model: MODEL,
    max_tokens: 250,
    system: "You are a precise classifier. Output JSON only.",
    messages: [{ role: "user", content: prompt }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "authorization": `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt > 4) throw new Error(`api error ${res.status} after ${attempt} attempts`);
    const wait = Math.min(60000, 2000 * Math.pow(2, attempt));
    stderr.write(`  api ${res.status} — retry in ${wait}ms (attempt ${attempt})\n`);
    await new Promise(r => setTimeout(r, wait));
    return callApi(prompt, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`api ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const text = json.content?.[0]?.text ?? "";
  return parseClassification(text, json.usage);
}

function parseClassification(text, usage) {
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const match = s.match(/\{[\s\S]*\}/);
  if (!match) {
    return { category: "PARSE_ERROR", reason: `no json: ${s.slice(0, 100)}`, confidence: 0, _usage: usage };
  }
  try {
    const obj = JSON.parse(match[0]);
    if (!CATEGORIES.includes(obj.category)) {
      obj.category = "PARSE_ERROR_BAD_CAT_" + obj.category;
      obj.confidence = 0;
    }
    obj._usage = usage;
    return obj;
  } catch (e) {
    return { category: "PARSE_ERROR", reason: e.message, confidence: 0, _usage: usage };
  }
}

function loadAlreadyClassified() {
  const seen = new Set();
  if (!existsSync(OUT_PATH)) return seen;
  const raw = readFileSync(OUT_PATH, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      seen.add(`${o.session_id}::${o.stop_index}`);
    } catch {}
  }
  return seen;
}

async function main() {
  const lines = readFileSync(IN_PATH, "utf8").split("\n").filter(Boolean);
  const seen = loadAlreadyClassified();
  stderr.write(`Loaded ${lines.length} candidates, already classified: ${seen.size}\n`);

  const todo = [];
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const key = `${rec.session_id}::${rec.stop_index}`;
    if (seen.has(key)) continue;
    todo.push(rec);
    if (todo.length >= LIMIT) break;
  }
  stderr.write(`To classify: ${todo.length} (concurrency=${CONCURRENCY}, model=${MODEL})\n\n`);

  let done = 0;
  let totalUsage = { in: 0, out: 0 };
  const startedAt = Date.now();

  async function worker(idx) {
    while (idx < todo.length) {
      const rec = todo[idx];
      idx += CONCURRENCY;
      try {
        const prompt = buildPrompt(rec);
        const cls = await callApi(prompt);
        if (cls._usage) {
          totalUsage.in += cls._usage.input_tokens ?? 0;
          totalUsage.out += cls._usage.output_tokens ?? 0;
        }
        delete cls._usage;
        const out = { ...rec, classification: cls };
        appendFileSync(OUT_PATH, JSON.stringify(out) + "\n");
        done++;
        if (done % 20 === 0 || done === todo.length) {
          const elapsed = (Date.now() - startedAt) / 1000;
          const rate = done / elapsed;
          stderr.write(`[${done}/${todo.length}] ${rate.toFixed(1)}/s  tokens in=${totalUsage.in} out=${totalUsage.out}\n`);
        }
      } catch (e) {
        stderr.write(`  fail ${rec.session_id}::${rec.stop_index}: ${e.message}\n`);
        const out = { ...rec, classification: { category: "API_ERROR", reason: e.message, confidence: 0 } };
        appendFileSync(OUT_PATH, JSON.stringify(out) + "\n");
        done++;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, todo.length); i++) {
    workers.push(worker(i));
  }
  await Promise.all(workers);

  stderr.write(`\n=== CLASSIFY DONE ===\n`);
  stderr.write(`Classified : ${done}\n`);
  stderr.write(`Tokens     : in=${totalUsage.in} out=${totalUsage.out}\n`);
  stderr.write(`Output     : ${OUT_PATH}\n`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

main().catch(e => {
  stderr.write(`FATAL: ${e.stack}\n`);
  exit(1);
});
