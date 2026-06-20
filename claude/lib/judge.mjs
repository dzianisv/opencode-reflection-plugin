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
 * Builds the classifier prompt from a stopContext object.
 * Prompt content is identical to classify-cc-stops.mjs's buildPrompt().
 *
 * @param {object} ctx - stopContext from buildStopContext()
 * @returns {string}
 */
function buildPrompt(ctx) {
  const userMsgs = (ctx.user_messages ?? [])
    .map((m, i) => `[USER ${i + 1}] ${truncate(m, 1200)}`)
    .join('\n\n');
  const finalText = truncate(ctx.final_assistant_text ?? '', 2400);
  const tools = (ctx.tools_available_inferred ?? []).join(', ');

  return `You classify how a Claude Code assistant ended a turn. Pick ONE category.

CATEGORIES:
- complete: task is done; assistant delivered the answer or finished the requested work.
- waiting_for_user_legitimate: assistant asks a question that ONLY the user can answer (preference, missing info no tool can fetch).
- tool_available_punt: assistant punts to the user about something the available tools could resolve. The assistant has access to tools like Bash, WebFetch, browser MCP, etc., yet asks the user instead of trying.
- summary_drift_stop: assistant wrote a summary or plan with a "next step" and STOPPED before doing the next step. e.g., "I've created the file. Next step: run the tests." (without running them.)
- genuinely_stuck: assistant stopped mid-thought or without clear conclusion; no question, no summary, just halted. Often short.
- working: rarely a stop; only assign if the final turn is clearly mid-action (e.g., "Running tests now...") with no closure.

TOOLS THE ASSISTANT HAD: ${tools || '(none recorded)'}

USER MESSAGES (in order):
${userMsgs || '(none)'}

FINAL ASSISTANT TEXT:
${finalText}

Respond ONLY with a JSON object on a single line, no markdown fence, no prose:
{"category": "<one of: complete | waiting_for_user_legitimate | tool_available_punt | summary_drift_stop | genuinely_stuck | working>", "reason": "<one short sentence why>", "confidence": <0.0-1.0>}`;
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
