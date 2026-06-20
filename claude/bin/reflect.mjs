#!/usr/bin/env node
/**
 * reflect.mjs — Claude Code Stop hook entry-point
 *
 * Reads the CC Stop hook payload from stdin (JSON), applies safety rails,
 * reads the transcript tail, builds a stop-context object, and (once task-11
 * lands) invokes the judge LLM to decide whether to inject a follow-up prompt.
 *
 * Parallel group A, task #10.  Tasks 11 & 12 land classifier + feedback templates.
 *
 * Public API (re-exported for unit tests — task 14):
 *   readTranscriptTail(path, maxBytes?)  → Entry[]
 *   buildStopContext(stopPayload, transcriptTail) → StopContext
 *   loopGuard(stopPayload) → boolean
 *   readAttempts(session_id, cwd) → number
 *   writeAttemptCounter(session_id, n, cwd) → void
 *   writeVerdict(session_id, verdictObj, cwd) → void
 *   debug(obj) → void
 */

import fs from 'node:fs';
import path from 'node:path';
import { classifyStop } from '../lib/judge.mjs';
import { buildFeedback, INJECT_CATEGORIES } from '../lib/feedback.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = parseInt(process.env.REFLECTION_CC_MAX_ATTEMPTS ?? '3', 10);
const DEBUG_ENABLED = process.env.REFLECTION_CC_DEBUG === '1';
const TRANSCRIPT_MAX_BYTES = 200_000;
const TRANSCRIPT_MAX_ENTRIES = 50;

// ---------------------------------------------------------------------------
// Fail-safe: never block a Stop on a plugin crash
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  _debugRaw({ msg: 'uncaught_exception', error: String(err), stack: err?.stack });
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  _debugRaw({ msg: 'unhandled_rejection', reason: String(reason) });
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

/**
 * Internal helper — writes without needing cwd (used in crash handlers).
 * Falls back to stderr if the file write fails.
 */
function _debugRaw(obj) {
  if (!DEBUG_ENABLED) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
  try {
    // We may not have cwd at crash time; write to /tmp as best-effort.
    fs.appendFileSync('/tmp/reflect-cc-crash.log', line);
  } catch {
    process.stderr.write(line);
  }
}

/**
 * Append a timestamped JSON line to `.reflection/debug.log` under `cwd`.
 * No-op unless REFLECTION_CC_DEBUG=1.
 *
 * @param {object} obj - arbitrary JSON-serialisable data
 * @param {string} [cwd] - working directory (optional; falls back to process.cwd())
 */
export function debug(obj, cwd) {
  if (!DEBUG_ENABLED) return;
  const dir = path.join(cwd ?? process.cwd(), '.reflection');
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'debug.log'), line);
  } catch (err) {
    // debug must never throw
    process.stderr.write(`[reflect.mjs] debug write failed: ${err}\n`);
  }
}

// ---------------------------------------------------------------------------
// cwd sanitization
// ---------------------------------------------------------------------------

/**
 * Validates the `cwd` field from a Stop hook payload before any fs writes.
 * Requires an absolute path that survives normalization unchanged (no `..`).
 *
 * @param {string} cwd
 * @returns {string} normalized absolute cwd
 * @throws {Error} "reflect: invalid cwd"
 */
export function sanitizeCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Error('reflect: invalid cwd');
  }
  const resolved = path.resolve(cwd);
  if (resolved !== cwd) {
    throw new Error('reflect: invalid cwd');
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Loop guard
// ---------------------------------------------------------------------------

/**
 * Returns true if this Stop was triggered by a previous block injection
 * (CC sets stop_hook_active=true on the immediate next Stop after a block).
 * When true the hook MUST exit 0 — no further processing.
 *
 * @param {{ stop_hook_active?: boolean }} stopPayload
 * @returns {boolean}
 */
export function loopGuard(stopPayload) {
  return stopPayload?.stop_hook_active === true;
}

// ---------------------------------------------------------------------------
// Attempt counter
// ---------------------------------------------------------------------------

/**
 * Returns the current inject attempt count for this session.
 * File shape: { count: number, last_iso: string }
 * Returns 0 if the file is absent or unreadable.
 *
 * @param {string} session_id
 * @param {string} cwd
 * @returns {number}
 */
export function readAttempts(session_id, cwd) {
  const file = path.join(cwd, '.reflection', `${session_id}_attempts.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.count === 'number' ? parsed.count : 0;
  } catch {
    debug({ msg: 'attempts_file_corrupt', file }, cwd);
    return 0;
  }
}

/**
 * Writes the attempt counter for a session.
 * Creates `.reflection/` directory if absent.
 *
 * @param {string} session_id
 * @param {number} n
 * @param {string} cwd
 */
export function writeAttemptCounter(session_id, n, cwd) {
  const dir = path.join(cwd, '.reflection');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session_id}_attempts.json`);

  // Concurrency guard: if file exists, only write when newCount > existingCount.
  // Ensures max-of-attempts wins across racing Stop hooks on same session.
  let existingCount = 0;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.count === 'number') existingCount = parsed.count;
  } catch {
    // missing or corrupt — treat as 0
  }
  if (n <= existingCount) return;

  // Atomic write: write to tmp + rename (POSIX rename is atomic).
  const tmp = path.join(dir, `${session_id}_attempts.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ count: n, last_iso: new Date().toISOString() }), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Verdict file
// ---------------------------------------------------------------------------

/**
 * Writes a verdict object to `.reflection/verdict_${session_id}.json`.
 * Creates the directory if absent.
 *
 * @param {string} session_id
 * @param {object} verdictObj - arbitrary JSON-serialisable verdict
 * @param {string} cwd
 */
export function writeVerdict(session_id, verdictObj, cwd) {
  const dir = path.join(cwd, '.reflection');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `verdict_${session_id}.json`);
  fs.writeFileSync(file, JSON.stringify(verdictObj, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Transcript tail reader
// ---------------------------------------------------------------------------

/**
 * Reads the last `maxBytes` of a Claude Code JSONL transcript file, parses
 * complete JSON lines, and returns the last TRANSCRIPT_MAX_ENTRIES entries
 * that are either `type==="user"` or `type==="assistant"` (strips tool_use,
 * tool_result, attachment, and all other entry types — see design.md §Input Shape).
 *
 * Transcript JSONL line shape (inferred from real files):
 *
 *   type === "assistant":
 *     { type, parentUuid, uuid, sessionId, timestamp, message: {
 *         role: "assistant",
 *         content: Array<
 *           | { type: "text", text: string }
 *           | { type: "thinking", thinking: string }
 *           | { type: "tool_use", id, name, input }
 *         >
 *       }, ... }
 *
 *   type === "user":
 *     { type, parentUuid, uuid, sessionId, timestamp, message: {
 *         role: "user",
 *         content: string | Array<
 *           | { type: "tool_result", tool_use_id, content }
 *         >
 *       }, ... }
 *
 *   Other top-level types seen in practice:
 *     "attachment", "last-prompt", "permission-mode", "bridge-session",
 *     "file-history-snapshot", "tools_changed", "hook_success",
 *     "hook_additional_context", "skill_listing", "task_reminder",
 *     "create", "tool_reference", "direct", "text", "message" (inner)
 *
 * @param {string} filePath - absolute path to *.jsonl transcript
 * @param {number} [maxBytes=200_000] - max bytes to read from the tail
 * @returns {Array<object>} - filtered transcript entries (user + assistant only)
 */
export function readTranscriptTail(filePath, maxBytes = TRANSCRIPT_MAX_BYTES) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }

  const fileSize = stat.size;
  const readSize = Math.min(maxBytes, fileSize);
  const offset = fileSize - readSize;

  let buffer;
  let fd;
  try {
    buffer = Buffer.alloc(readSize);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, readSize, offset);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  const rawText = buffer.toString('utf8');

  // Split on newlines; first line may be a partial line if we truncated mid-line
  const lines = rawText.split('\n');

  // Skip the first segment — it's likely a partial line from the tail offset
  const startIdx = offset === 0 ? 0 : 1;

  /** @type {Array<object>} */
  const filtered = [];

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }

    const t = entry?.type;
    if (t === 'user' || t === 'assistant') {
      // For user entries: skip those whose message.content is purely tool_result
      // arrays (these are the CC mechanism for tool output, not conversational turns).
      if (t === 'user') {
        const content = entry?.message?.content;
        if (Array.isArray(content)) {
          const allToolResults = content.every((c) => c?.type === 'tool_result');
          if (allToolResults) continue; // exclude pure tool-result user turns
        }
      }
      filtered.push(entry);
    }
  }

  // Return the last N entries
  return filtered.slice(-TRANSCRIPT_MAX_ENTRIES);
}

// ---------------------------------------------------------------------------
// Stop context builder
// ---------------------------------------------------------------------------

/**
 * Extracts a clean "stop context" object from the Stop payload + transcript tail.
 * This is the shape passed to the judge LLM (task 11).
 *
 * @param {object} stopPayload - CC Stop hook JSON from stdin
 * @param {string} stopPayload.session_id
 * @param {string} stopPayload.cwd
 * @param {string} stopPayload.transcript_path
 * @param {string} [stopPayload.response] - last assistant text (shortcut from CC)
 * @param {string} [stopPayload.hook_event_name]
 * @param {Array<object>} transcriptTail - filtered entries from readTranscriptTail()
 * @returns {{
 *   session_id: string,
 *   attempt: number,
 *   user_messages: string[],
 *   final_assistant_text: string,
 *   tools_available_inferred: string[],
 *   raw_tail: Array<object>
 * }}
 */
export function buildStopContext(stopPayload, transcriptTail) {
  const session_id = stopPayload?.session_id ?? 'unknown';
  const cwd = stopPayload?.cwd ?? process.cwd();
  const attempt = readAttempts(session_id, cwd);

  // Extract human-readable user messages (text content only)
  const user_messages = [];
  for (const entry of transcriptTail) {
    if (entry.type !== 'user') continue;
    const content = entry?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      user_messages.push(content.trim());
    } else if (Array.isArray(content)) {
      // Grab only text blocks from mixed content arrays
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          user_messages.push(block.text.trim());
        }
      }
    }
  }

  // Derive final assistant text: prefer CC's `response` field (it IS the last turn),
  // fall back to the last assistant entry's text content from the tail.
  let final_assistant_text = (stopPayload?.response ?? '').trim();
  if (!final_assistant_text) {
    // Walk tail in reverse, find last assistant entry with a text block
    for (let i = transcriptTail.length - 1; i >= 0; i--) {
      const entry = transcriptTail[i];
      if (entry.type !== 'assistant') continue;
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      const textBlocks = content.filter((c) => c?.type === 'text');
      if (textBlocks.length > 0) {
        final_assistant_text = textBlocks.map((b) => b.text).join('\n').trim();
        break;
      }
    }
  }

  // Infer available tools from tool_use entries visible in the session.
  // We look through ALL lines in the raw tail (including assistant messages with
  // tool_use content blocks) for tool names actually used, as a proxy for
  // "tools available". Task 11 may refine this further.
  const toolNames = new Set();
  for (const entry of transcriptTail) {
    if (entry.type !== 'assistant') continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        toolNames.add(block.name);
      }
    }
  }
  const tools_available_inferred = [...toolNames].sort();

  return {
    session_id,
    attempt,
    user_messages,
    final_assistant_text,
    tools_available_inferred,
    raw_tail: transcriptTail,
  };
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

/**
 * Reads all of stdin and returns as a string.
 * @returns {Promise<string>}
 */
async function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();

  let payload;
  try {
    payload = JSON.parse(input);
  } catch (err) {
    debug({ msg: 'stdin_parse_error', error: String(err) }, process.cwd());
    process.exit(0);
  }

  // ── 1. LOOP GUARD (most important check — runs first, always) ──────────────
  if (loopGuard(payload)) {
    debug({ msg: 'loop_guard_triggered', session_id: payload.session_id }, payload.cwd);
    process.exit(0);
  }

  const { session_id, transcript_path } = payload;
  // Sanitize cwd from payload before any fs writes — throws on invalid input.
  // uncaughtException handler exits 0 (fail-safe: no inject, no fs ops).
  const cwd = sanitizeCwd(payload?.cwd ?? process.cwd());

  // ── 2. ATTEMPT CAP ────────────────────────────────────────────────────────
  const attempts = readAttempts(session_id, cwd);
  if (attempts >= MAX_ATTEMPTS) {
    debug({ msg: 'attempt_cap_reached', session_id, attempts, max: MAX_ATTEMPTS }, cwd);
    process.exit(0);
  }

  // ── 3. TRANSCRIPT TAIL ───────────────────────────────────────────────────
  // CC's Stop hook fires before the transcript flush of the final assistant
  // turn completes on some paths. Poll briefly for an assistant entry with
  // text content to appear before classifying. Bail-out conditions:
  //   - we already have a usable ctx (assistant text non-empty)
  //   - poll budget exhausted (~1s total)
  let tail = transcript_path ? readTranscriptTail(transcript_path) : [];
  let ctx = buildStopContext(payload, tail);
  const FLUSH_POLL_MS = 100;
  const FLUSH_POLL_MAX = 10;
  for (let i = 0; i < FLUSH_POLL_MAX && !ctx.final_assistant_text; i++) {
    await new Promise((r) => setTimeout(r, FLUSH_POLL_MS));
    tail = transcript_path ? readTranscriptTail(transcript_path) : [];
    ctx = buildStopContext(payload, tail);
  }

  // Fail-safe: if we STILL have no final assistant text after polling, the
  // transcript probably hasn't flushed and we cannot classify reliably.
  // Skip rather than risk a false-positive inject.
  if (!ctx.final_assistant_text) {
    debug({ msg: 'no_assistant_text_after_poll', session_id, tail_len: tail.length }, cwd);
    process.exit(0);
  }

  debug(
    {
      msg: 'stop_received',
      session_id,
      attempts,
      user_msg_count: ctx.user_messages.length,
      final_assistant_text_len: ctx.final_assistant_text.length,
      tools_available_inferred: ctx.tools_available_inferred,
    },
    cwd,
  );

  // ── 5. JUDGE LLM CALL ─────────────────────────────────────────────────────
  let verdict;
  try {
    verdict = await classifyStop(ctx);
  } catch (e) {
    debug({ msg: 'judge_threw', err: String(e?.message ?? e) }, cwd);
    verdict = { category: 'API_ERROR', reason: String(e?.message ?? e), confidence: 0 };
  }

  debug({ msg: 'verdict', category: verdict.category, confidence: verdict.confidence }, cwd);

  const nextAttempt = attempts + 1;
  const verdictRecord = {
    ...verdict,
    session_id,
    attempt: nextAttempt,
    timestamp: new Date().toISOString(),
    injected: false,
  };

  // ── 6. INJECT DECISION ───────────────────────────────────────────────────
  if (INJECT_CATEGORIES.has(verdict.category)) {
    const fb = buildFeedback(verdict.category, ctx, nextAttempt);
    if (fb.shouldInject) {
      writeAttemptCounter(session_id, nextAttempt, cwd);
      verdictRecord.injected = true;
      verdictRecord.feedback_reason = fb.reason;
      writeVerdict(session_id, verdictRecord, cwd);

      // Stop hook payload shape (per CC v2.x hookify rule_engine.py +
      // empirical test 2026-05-26): { decision: "block", reason }.
      // `reason` is the text CC injects as the agent's next-turn instruction
      // (rendered as `Stop hook feedback:\n<reason>`). `systemMessage` is
      // accepted but appears to be dropped from the conversation in v2.1.150,
      // so we put the full guidance in `reason`. `hookSpecificOutput` /
      // `additionalContext` is rejected as Invalid input by Stop.
      const out = {
        decision: 'block',
        reason: fb.additionalContext || fb.reason,
      };
      process.stdout.write(JSON.stringify(out));
      debug({ msg: 'inject_sent', category: verdict.category, attempt: nextAttempt, reason: fb.reason }, cwd);
      process.exit(0);
    }
  }

  // No inject: write verdict, exit clean.
  writeVerdict(session_id, verdictRecord, cwd);
  debug({ msg: 'no_inject', category: verdict.category, attempt: nextAttempt }, cwd);
  process.exit(0);
}

main();
