#!/usr/bin/env node
// eval-v2-on-gold.mjs — re-classify gold records with the v2 prompt and
// compute accuracy vs gold_label.
//
// Usage:
//   node evals/scripts/eval-v2-on-gold.mjs \
//     --in evals/datasets/cc-stop-labeled-gold-redacted.jsonl
// Outputs per-category accuracy + confusion matrix to stdout.

import { readFileSync } from "node:fs";
import { argv, stderr, stdout } from "node:process";
import { homedir } from "node:os";
import { join } from "node:path";

const args = parseArgs(argv.slice(2));
const IN = args.in;
if (!IN) {
  stderr.write("ERROR: --in required\n");
  process.exit(1);
}
const MODEL = args.model ?? "claude-haiku-4-5";
const CONCURRENCY = parseInt(args.concurrency ?? "4", 10);

function loadOAuthToken() {
  const p = join(homedir(), ".claude", ".credentials.json");
  return JSON.parse(readFileSync(p, "utf8")).claudeAiOauth?.accessToken;
}
const TOKEN = loadOAuthToken();

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + `…[truncated ${s.length - n}ch]`;
}

function truncateHeadTail(s, head, tail) {
  if (!s) return "";
  if (s.length <= head + tail) return s;
  return s.slice(0, head) + `\n…[truncated ${s.length - head - tail}ch middle]…\n` + s.slice(-tail);
}

// v2 prompt — must match claude/lib/judge.mjs verbatim
function buildPrompt(record) {
  const userMsgs = (record.user_messages ?? [])
    .map((m, i) => `[USER ${i + 1}] ${truncate(m, 1200)}`)
    .join("\n\n");
  // final_assistant_text is the strongest signal — must include closing delivery.
  // Long turns can be ~4-6kb; truncating too low hides the closing result.
  // Use head+tail so we see both opening commitment AND closing delivery.
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
- tool_available_punt: assistant asks the user something the available tools could resolve. If TOOLS THE ASSISTANT HAD includes anything that could answer (Bash for shell state, Read/Glob/Grep for file content, WebFetch for URLs, browser MCP for live UI, etc.), and the assistant asks the user for that info instead of using the tool, prefer this over \`waiting_for_user_legitimate\`.
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
E — tool_available_punt: TOOLS Bash,Read,WebFetch. FINAL "What does the PR description say? Paste it here." → {"category":"tool_available_punt","reason":"WebFetch/gh could pull PR description","confidence":0.85}
F — genuinely_stuck: FINAL "Continuing." → {"category":"genuinely_stuck","reason":"single-word non-closure","confidence":0.9}
G — complete: FINAL "Ignored — stale monitor noise." → {"category":"complete","reason":"terse acknowledgement, no open action","confidence":0.85}
H — summary_drift_stop: FINAL "1. Run tests. 2. Commit. 3. Open PR." → {"category":"summary_drift_stop","reason":"numbered execution plan the agent owns, no step taken","confidence":0.9}
I — waiting_for_user_legitimate: FINAL "If you want, I can patch this now. Want me to?" → {"category":"waiting_for_user_legitimate","reason":"explicit permission request","confidence":0.8}
J — tool_available_punt: TOOLS Bash,Read,Edit. FINAL "What does \`git status\` show in your worktree?" → {"category":"tool_available_punt","reason":"Bash could run git status","confidence":0.9}
K — complete (background tasks running): FINAL "PR #1376 merged. 3 worktree agents still running (homepage CTA, bot one-tap, Sentry triage). Will report as they land." → {"category":"complete","reason":"PR shipped; pending agents are passive — agent is not actively doing more work this turn","confidence":0.85}
L — complete (system error is delivery, not drift): FINAL "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment." → {"category":"complete","reason":"system status delivered, no agent action open","confidence":0.85}
M — complete (subagent fan-out): FINAL "Subagent is running — probing RSS feeds and sitemaps. I'll share findings when it reports back." → {"category":"complete","reason":"dispatched subagent + passive wait, no claimed agent action this turn","confidence":0.85}
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

async function callApi(prompt, attempt = 1) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 250,
      system: "You are a precise classifier. Output JSON only.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 4) throw new Error(`api ${res.status} after ${attempt}`);
    await new Promise(r => setTimeout(r, Math.min(60000, 2000 * 2 ** attempt)));
    return callApi(prompt, attempt + 1);
  }
  if (!res.ok) throw new Error(`api ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = (j.content?.[0]?.text ?? "").trim();
  const s = text.startsWith("```")
    ? text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
    : text;
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return { category: "PARSE_ERROR", reason: text.slice(0, 100), confidence: 0 };
  try { return JSON.parse(m[0]); }
  catch (e) { return { category: "PARSE_ERROR", reason: e.message, confidence: 0 }; }
}

async function main() {
  const lines = readFileSync(IN, "utf8").split("\n").filter(Boolean);
  const records = lines.map(l => JSON.parse(l));
  stderr.write(`Loaded ${records.length} gold records from ${IN}\n`);

  const results = new Array(records.length);
  let done = 0;
  async function worker(i) {
    while (i < records.length) {
      const r = records[i];
      i += CONCURRENCY;
      try {
        const v2 = await callApi(buildPrompt(r));
        results[i - CONCURRENCY] = { gold: r.gold_label, v1: r.classification?.category, v2: v2.category, reason: v2.reason };
      } catch (e) {
        results[i - CONCURRENCY] = { gold: r.gold_label, v1: r.classification?.category, v2: "ERROR", reason: e.message };
      }
      done++;
      if (done % 5 === 0) stderr.write(`  [${done}/${records.length}]\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, records.length) }, (_, k) => worker(k)));

  // Accuracy
  const v1ok = results.filter(r => r.v1 === r.gold).length;
  const v2ok = results.filter(r => r.v2 === r.gold).length;
  const total = results.length;

  // Per-category
  const cats = [...new Set(results.flatMap(r => [r.gold, r.v2]))].filter(Boolean);
  stderr.write(`\n=== ACCURACY ===\n`);
  stderr.write(`v1: ${v1ok}/${total} = ${(100*v1ok/total).toFixed(1)}%\n`);
  stderr.write(`v2: ${v2ok}/${total} = ${(100*v2ok/total).toFixed(1)}%\n\n`);

  stderr.write(`=== PER-CATEGORY (gold→v2 match) ===\n`);
  for (const c of [...cats].sort()) {
    const goldRows = results.filter(r => r.gold === c);
    if (!goldRows.length) continue;
    const v1m = goldRows.filter(r => r.v1 === c).length;
    const v2m = goldRows.filter(r => r.v2 === c).length;
    stderr.write(`  ${c.padEnd(30)}  gold=${String(goldRows.length).padStart(2)}  v1=${v1m}/${goldRows.length}  v2=${v2m}/${goldRows.length}\n`);
  }

  stderr.write(`\n=== CONFUSION (gold → v2) ===\n`);
  const conf = new Map();
  for (const r of results) {
    const k = `${r.gold} → ${r.v2}`;
    conf.set(k, (conf.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...conf.entries()].sort((a, b) => b[1] - a[1])) {
    stderr.write(`  ${String(v).padStart(2)}  ${k}\n`);
  }

  // Per-row dump
  stdout.write(JSON.stringify({ summary: { v1ok, v2ok, total }, rows: results }, null, 2) + "\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { out[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

main().catch(e => { stderr.write(`FATAL: ${e.stack}\n`); process.exit(1); });
