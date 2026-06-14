/**
 * judge.mjs — in-hook LLM classifier for Claude Code Stop hooks.
 *
 * Exported surface:
 *   classifyStop(stopContext, opts?) → Promise<Classification>
 *
 * stopContext shape (built by buildStopContext in reflect.mjs):
 *   { session_id, attempt, user_messages, final_assistant_text,
 *     tools_available_inferred, raw_tail }
 *
 * Classification shape:
 *   { category, reason, confidence, raw_text?, usage? }
 *
 * Auth: reads OAuth token from ~/.claude/.credentials.json — no API key needed.
 * Net:  POST https://api.anthropic.com/v1/messages via global fetch (Node 18+).
 * Deps: none (stdlib only).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const DEFAULT_MODEL = process.env.REFLECTION_CC_MODEL ?? 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TOKENS = 250;

const CATEGORIES = [
  'complete',
  'waiting_for_user_legitimate',
  'tool_available_punt',
  'summary_drift_stop',
  'genuinely_stuck',
  'working',
];

// ---------------------------------------------------------------------------
// Error sanitization
// ---------------------------------------------------------------------------

/**
 * Strips credentials from response bodies / error text before it lands in
 * Error.message or debug logs. Truncates to 200 chars.
 *
 * @param {string} text
 * @returns {string}
 */
function sanitizeError(text) {
  if (typeof text !== 'string') text = String(text ?? '');
  let s = text;
  s = s.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer <REDACTED>');
  s = s.replace(/"authorization"\s*:\s*"[^"]*"/gi, '"authorization":"<REDACTED>"');
  s = s.replace(/"x-api-key"\s*:\s*"[^"]*"/gi, '"x-api-key":"<REDACTED>"');
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Loads the OAuth access token from ~/.claude/.credentials.json.
 * Throws a sentinel error (prefixed "judge:") if the file is missing,
 * unreadable, or the token is absent/empty — caller treats this as no-inject.
 *
 * @returns {string} access token
 */
function loadOAuthToken() {
  const credPath = join(homedir(), '.claude', '.credentials.json');
  let raw;
  try {
    raw = readFileSync(credPath, 'utf8');
  } catch (err) {
    throw new Error(`judge: cannot read credentials file: ${err.message}`);
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`judge: credentials file is not valid JSON: ${err.message}`);
  }

  const token = obj?.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error('judge: no claudeAiOauth.accessToken in ~/.claude/.credentials.json');
  }
  return token;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Truncates a string to n characters, appending a truncation note if cut.
 * Mirrors the helper in classify-cc-stops.mjs verbatim.
 *
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + `…[truncated ${s.length - n}ch]`;
}

/**
 * Truncates with head + tail preservation. Long final_assistant_text often
 * has both opening commitment and closing delivery; keeping both is critical
 * for accurate classification (see prompt-tune-v2 audit, #138).
 *
 * @param {string} s
 * @param {number} head - chars to keep from start
 * @param {number} tail - chars to keep from end
 * @returns {string}
 */
function truncateHeadTail(s, head, tail) {
  if (!s) return '';
  if (s.length <= head + tail) return s;
  return s.slice(0, head) + `\n…[truncated ${s.length - head - tail}ch middle]…\n` + s.slice(-tail);
}

/**
 * Builds the classifier prompt from a stopContext object.
 *
 * IMPORTANT: This prompt is duplicated in three places that MUST stay in sync:
 *   - claude/lib/judge.mjs (this file — runs in the live hook)
 *   - evals/scripts/classify-cc-stops.mjs (offline CC labeling)
 *   - evals/scripts/classify-oc-stops.mjs (offline OC labeling)
 * Source of truth: evals/prompts/cc-stop-classifier.v2.txt
 * Follow-up: extract into a shared module the hook can import without I/O.
 *
 * @param {object} ctx - stopContext from buildStopContext()
 * @returns {string}
 */
function buildPrompt(ctx) {
  const userMsgs = (ctx.user_messages ?? [])
    .map((m, i) => `[USER ${i + 1}] ${truncate(m, 1200)}`)
    .join('\n\n');
  // Head + tail truncation: long turns have both opening commitment and
  // closing delivery; missing the closing leads to false-positive drift.
  const finalText = truncateHeadTail(ctx.final_assistant_text ?? '', 1800, 2400);
  const tools = (ctx.tools_available_inferred ?? []).join(', ');

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

TOOLS THE ASSISTANT HAD: ${tools || '(none recorded)'}

USER MESSAGES (in order):
${userMsgs || '(none)'}

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

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Strips code fences, finds the first {...} block, and JSON.parses it.
 * Validates that category is one of the 6 known values.
 *
 * @param {string} text - raw text from the model
 * @param {object} [usage] - token usage from the API response
 * @returns {{ category: string, reason: string, confidence: number, raw_text: string, usage?: object }}
 */
function parseResponse(text, usage) {
  let s = text.trim();

  // Strip code fences if the model added them despite instructions
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  const match = s.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      category: 'PARSE_ERROR',
      reason: `no json found: ${s.slice(0, 100)}`,
      confidence: 0,
      raw_text: text,
      usage,
    };
  }

  let obj;
  try {
    obj = JSON.parse(match[0]);
  } catch (err) {
    return {
      category: 'PARSE_ERROR',
      reason: err.message,
      confidence: 0,
      raw_text: text,
      usage,
    };
  }

  if (!CATEGORIES.includes(obj.category)) {
    return {
      category: 'PARSE_ERROR',
      reason: `unknown category: ${obj.category}`,
      confidence: 0,
      raw_text: text,
      usage,
    };
  }

  return {
    category: obj.category,
    reason: obj.reason ?? '',
    confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
    raw_text: text,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classifies a Claude Code Stop event using a judge LLM call.
 *
 * @param {object} stopContext - built by buildStopContext() in reflect.mjs:
 *   { session_id, attempt, user_messages, final_assistant_text,
 *     tools_available_inferred, raw_tail }
 * @param {object} [opts]
 * @param {string}      [opts.model]     - override model (default: REFLECTION_CC_MODEL or claude-haiku-4-5)
 * @param {number}      [opts.timeoutMs] - override timeout in ms (default: 15000)
 * @param {AbortSignal} [opts.signal]    - external cancellation signal
 * @returns {Promise<{ category: string, reason: string, confidence: number, raw_text?: string, usage?: object }>}
 */
export async function classifyStop(stopContext, opts = {}) {
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Load token — throws "judge: ..." on failure (caller treats as no-inject)
  let token;
  try {
    token = loadOAuthToken();
  } catch (err) {
    throw err; // already prefixed with "judge:"
  }

  const prompt = buildPrompt(stopContext);

  const body = JSON.stringify({
    model,
    max_tokens: MAX_TOKENS,
    system: 'You are a precise classifier. Output JSON only.',
    messages: [{ role: 'user', content: prompt }],
  });

  // Compose abort signal: hard timeout + optional caller signal
  const timeoutController = new AbortController();
  const timerId = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Merge caller signal if provided
  let signal = timeoutController.signal;
  if (opts.signal) {
    // If either aborts, abort both
    opts.signal.addEventListener('abort', () => timeoutController.abort(), { once: true });
    // We still use timeoutController.signal — it fires on timeout OR on opts.signal abort
  }

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body,
      signal,
    });
  } catch (err) {
    clearTimeout(timerId);
    if (timeoutController.signal.aborted) {
      return {
        category: 'TIMEOUT',
        reason: `judge call exceeded ${timeoutMs}ms`,
        confidence: 0,
      };
    }
    throw new Error(`judge: fetch failed: ${sanitizeError(err.message)}`);
  } finally {
    clearTimeout(timerId);
  }

  if (!res.ok) {
    let body;
    try { body = await res.text(); } catch { body = ''; }
    throw new Error(`judge: api ${res.status}: ${sanitizeError(body)}`);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`judge: failed to parse api response: ${sanitizeError(err.message)}`);
  }

  const rawText = json.content?.[0]?.text ?? '';
  const usage = json.usage
    ? { input_tokens: json.usage.input_tokens, output_tokens: json.usage.output_tokens }
    : undefined;

  return parseResponse(rawText, usage);
}
