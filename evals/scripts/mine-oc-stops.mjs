#!/usr/bin/env node
/**
 * mine-oc-stops.mjs
 *
 * Scans OpenCode session transcripts in the local SQLite database
 * (~/.local/share/opencode/opencode.db by default; override with --db or
 * OPENCODE_DB) and extracts "Stop boundaries" — points where the assistant
 * ended a turn (last assistant message before a user reply or before session
 * end).
 *
 * Emits one JSONL record per stop with the same schema as
 * cc-stop-candidates-raw.jsonl, so downstream filter/classify/audit scripts
 * can treat CC and OC datasets uniformly.
 *
 * Usage:
 *   node evals/scripts/mine-oc-stops.mjs
 *   node evals/scripts/mine-oc-stops.mjs --limit 20
 *   node evals/scripts/mine-oc-stops.mjs --db ~/.local/share/opencode/opencode-dev.db
 *   node evals/scripts/mine-oc-stops.mjs --project /home/azureuser/workspace/vibebrowser/vibe
 *   node evals/scripts/mine-oc-stops.mjs --out /tmp/oc-candidates.jsonl
 *
 * Data access: spawns `sqlite3 -readonly -json` subprocesses (no
 * better-sqlite3 dependency required).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let limitSessions = Infinity;
let filterProject = null; // worktree string match
let outPath = null;
let dbPath = process.env.OPENCODE_DB || path.join(os.homedir(), '.local/share/opencode/opencode.db');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) {
    limitSessions = parseInt(args[++i], 10);
    if (isNaN(limitSessions) || limitSessions < 1) {
      console.error('--limit must be a positive integer');
      process.exit(1);
    }
  } else if (args[i] === '--project' && args[i + 1]) {
    filterProject = args[++i];
  } else if (args[i] === '--out' && args[i + 1]) {
    outPath = args[++i];
  } else if (args[i] === '--db' && args[i + 1]) {
    dbPath = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`Usage: node mine-oc-stops.mjs [--limit N] [--project WORKTREE] [--out PATH] [--db PATH]`);
    process.exit(0);
  }
}

const REPO_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const DEFAULT_OUT = path.join(REPO_ROOT, 'evals', 'datasets', 'oc-stop-candidates-raw.jsonl');
const outputPath = outPath || DEFAULT_OUT;

if (!fs.existsSync(dbPath)) {
  console.error(`[error] OC database not found: ${dbPath}`);
  console.error(`        Set --db PATH or OPENCODE_DB env var.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SQLite via subprocess
// ---------------------------------------------------------------------------

function sql(query) {
  const r = spawnSync('sqlite3', ['-readonly', '-json', dbPath, query], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024, // 1 GiB — some sessions are huge
  });
  if (r.status !== 0) {
    throw new Error(`sqlite3 failed (${r.status}): ${r.stderr}`);
  }
  const out = r.stdout.trim();
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new Error(`sqlite3 JSON parse failed: ${err.message}\nFirst 300 chars: ${out.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRUNCATE_AT = 4000;

function truncate(text) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= TRUNCATE_AT) return text;
  return text.slice(0, TRUNCATE_AT) + '…[truncated]';
}

/**
 * Slugify a worktree path the same way CC stores its project dirs:
 *   /home/azureuser/workspace/vibebrowser/vibe → -home-azureuser-workspace-vibebrowser-vibe
 * This lets downstream tools cross-reference CC and OC project_slug values.
 */
function worktreeToSlug(worktree) {
  if (!worktree || worktree === '/') return 'global';
  return worktree.replace(/[\/.]/g, '-');
}

/**
 * Skip OpenCode SDK / dev projects (the user develops OC itself locally).
 * We skip if the worktree basename suggests it's an OC core/dev tree.
 * Also skip the global "/" project (no real worktree).
 */
function shouldSkipProject(worktree) {
  if (!worktree || worktree === '/') return true;
  const base = path.basename(worktree).toLowerCase();
  // Skip the OpenCode source tree and dev tooling
  const SKIP_BASENAMES = new Set([
    'opencode',
    'opencode-sdk',
    'opencode-ai',
    'opencode-plugins', // user uses CC for this
  ]);
  if (SKIP_BASENAMES.has(base)) return true;
  // Also skip anything under .local/share/opencode/worktree/ (OC's internal worktrees)
  if (worktree.includes('/.local/share/opencode/')) return true;
  return false;
}

/**
 * Real user text? Filter out OC's injected tool-result-style user parts:
 *   - "Called the X tool with the following input: ..."
 *   - "<path>...</path>" file content injections
 *   - empty/blank
 */
function isRealUserText(text) {
  if (!text || typeof text !== 'string') return false;
  const s = text.trim();
  if (!s) return false;
  if (/^Called the \w+ tool with the following input:/i.test(s)) return false;
  if (/^<path>/.test(s)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Per-session processing
// ---------------------------------------------------------------------------

/**
 * Pull all (message, part) rows for a session, ordered by time.
 * Returns array of { msg_id, role, msg_time, part_id, part_time, p_type, p_text, p_tool, p_reason }.
 */
function readSessionRows(sessionId) {
  // Use ' for SQL strings, escape any ' in the ID (session IDs are ULIDs, safe).
  const escId = sessionId.replace(/'/g, "''");
  const query = `
    SELECT
      m.id AS msg_id,
      json_extract(m.data, '$.role') AS role,
      m.time_created AS msg_time,
      p.id AS part_id,
      p.time_created AS part_time,
      json_extract(p.data, '$.type') AS p_type,
      json_extract(p.data, '$.text') AS p_text,
      json_extract(p.data, '$.tool') AS p_tool,
      json_extract(p.data, '$.reason') AS p_reason
    FROM message m
    LEFT JOIN part p ON p.message_id = m.id
    WHERE m.session_id = '${escId}'
    ORDER BY m.time_created ASC, m.id ASC, p.time_created ASC, p.id ASC;
  `;
  return sql(query);
}

/**
 * Group rows into messages, preserving order.
 */
function groupMessages(rows) {
  const messages = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || cur.msg_id !== r.msg_id) {
      cur = {
        msg_id: r.msg_id,
        role: r.role,
        time: r.msg_time,
        parts: [],
      };
      messages.push(cur);
    }
    if (r.part_id) {
      cur.parts.push({
        type: r.p_type,
        text: r.p_text,
        tool: r.p_tool,
        reason: r.p_reason,
      });
    }
  }
  return messages;
}

/**
 * Extract real user prompt text from a user message (text parts only,
 * filtered through isRealUserText).
 */
function extractUserText(msg) {
  const parts = [];
  for (const p of msg.parts) {
    if (p.type === 'text' && isRealUserText(p.text)) {
      parts.push(p.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Extract final assistant text from one or more consecutive assistant messages
 * grouped into a "stop" turn: concatenate all `text` parts.
 */
function extractAssistantText(msgs) {
  const parts = [];
  for (const m of msgs) {
    for (const p of m.parts) {
      if (p.type === 'text' && p.text && p.text.trim()) {
        parts.push(p.text);
      }
    }
  }
  return parts.join('\n').trim();
}

/**
 * Was this assistant-group a real "stop" (vs continuing with more tool calls)?
 * In OC, each LLM call within an assistant message ends with a step-finish
 * part carrying a `reason`. The reasons we have seen are:
 *   - tool-calls: model invoked tools and will continue → NOT a stop
 *   - stop: model produced a final text answer → STOP
 *   - length / content-filter / other: edge cases, treat as stop
 *
 * We look at the LAST step-finish across the whole assistant group.
 */
function isStopGroup(msgs) {
  let lastReason = null;
  for (const m of msgs) {
    for (const p of m.parts) {
      if (p.type === 'step-finish' && p.reason) {
        lastReason = p.reason;
      }
    }
  }
  // If there's no step-finish at all (interrupted/aborted), treat as stop too.
  if (lastReason == null) return true;
  return lastReason !== 'tool-calls';
}

/**
 * Collect distinct tool names called within this session up to a point.
 * We maintain a running set as we walk messages.
 */
function collectToolsFromMsgs(msgs, toolSet, toolCountRef) {
  for (const m of msgs) {
    for (const p of m.parts) {
      if (p.type === 'tool' && p.tool) {
        toolSet.add(p.tool);
        toolCountRef.n += 1;
      }
    }
  }
}

/**
 * Main per-session algorithm.
 */
function processSession(sessionId, projectSlug) {
  const rows = readSessionRows(sessionId);
  if (rows.length === 0) return { stops: [], realUserCount: 0 };

  const messages = groupMessages(rows);

  const stops = [];
  const toolsSeen = new Set();
  const toolCountRef = { n: 0 };
  const userMessages = []; // accumulated real user prompt texts
  let realUserCount = 0;

  // Walk messages, grouping consecutive assistant messages into "assistant turns".
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];

    if (m.role === 'user') {
      const txt = extractUserText(m);
      if (txt) {
        realUserCount++;
        userMessages.push(truncate(txt));
      }
      // Non-real user messages (compaction, tool-result injections) are
      // dropped silently — they don't break the assistant turn we just saw.
      i++;
      continue;
    }

    if (m.role === 'assistant') {
      // Collect all consecutive assistant messages into one logical turn.
      const group = [];
      while (i < messages.length && messages[i].role === 'assistant') {
        group.push(messages[i]);
        i++;
      }

      // Update tool stats from this group
      collectToolsFromMsgs(group, toolsSeen, toolCountRef);

      // Was this a stop? (last step-finish reason != tool-calls)
      if (!isStopGroup(group)) {
        // Mid-flight tool-call group; the next message should be another
        // assistant (continuation) — keep walking. If it's a user, something
        // unusual happened (e.g. user interjected) — we still don't count it
        // as a clean stop.
        continue;
      }

      // It's a stop. Determine whether the next event is a user reply
      // (real user) or end-of-session. Either way we emit.
      const finalText = extractAssistantText(group);
      const lastMsg = group[group.length - 1];

      stops.push({
        project_slug: projectSlug,
        session_id: sessionId,
        stop_index: stops.length,
        timestamp: lastMsg.time ? new Date(lastMsg.time).toISOString() : null,
        user_messages: [...userMessages],
        final_assistant_text: truncate(finalText),
        tools_available_inferred: [...toolsSeen],
        prior_tool_uses_count: toolCountRef.n,
        session_total_turns: 0, // patched below
      });

      continue;
    }

    // Unknown role — skip
    i++;
  }

  // Patch session_total_turns
  for (const s of stops) s.session_total_turns = realUserCount;

  return { stops, realUserCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Probe sqlite3
  const probe = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.error('[error] sqlite3 CLI not found on PATH.');
    process.exit(1);
  }
  console.error(`[info] sqlite3 ${probe.stdout.trim().split(' ')[0]} — db=${dbPath}`);

  // Load projects
  const projects = sql(`SELECT id, worktree, name FROM project;`);
  console.error(`[info] Found ${projects.length} projects in DB`);

  // Filter projects
  const useProjects = projects.filter(p => {
    if (filterProject && p.worktree !== filterProject) return false;
    if (shouldSkipProject(p.worktree)) {
      console.error(`[skip] project ${p.worktree || '(no worktree)'} — dev/SDK/global`);
      return false;
    }
    return true;
  });
  console.error(`[info] Processing ${useProjects.length} projects after filter`);

  // Ensure out dir
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outStream = fs.createWriteStream(outputPath, { encoding: 'utf8', flags: 'w' });

  // Stats
  let totalSessionsScanned = 0;
  let totalSessionsSkipped = 0;
  let totalCandidatesEmitted = 0;
  const candidatesPerProject = {};
  let sessionCount = 0;

  for (const proj of useProjects) {
    if (sessionCount >= limitSessions) break;

    const slug = worktreeToSlug(proj.worktree);
    candidatesPerProject[slug] = 0;

    // Pull sessions in this project (not archived). Get a quick message count.
    const escPid = proj.id.replace(/'/g, "''");
    const sessions = sql(`
      SELECT s.id, s.title, s.time_created,
             (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
      FROM session s
      WHERE s.project_id = '${escPid}'
        AND s.time_archived IS NULL
      ORDER BY s.time_updated DESC;
    `);

    console.error(`[scan] ${slug} — ${sessions.length} session(s)`);

    for (const ses of sessions) {
      if (sessionCount >= limitSessions) break;

      // Quick skip: sessions with very few messages can't have 3 user turns
      if (ses.msg_count < 6) {
        totalSessionsSkipped++;
        totalSessionsScanned++;
        sessionCount++;
        continue;
      }

      let result;
      try {
        result = processSession(ses.id, slug);
      } catch (err) {
        console.error(`[warn] session ${ses.id}: ${err.message}`);
        totalSessionsSkipped++;
        totalSessionsScanned++;
        sessionCount++;
        continue;
      }

      totalSessionsScanned++;
      sessionCount++;

      if (result.realUserCount < 3) {
        totalSessionsSkipped++;
        continue;
      }

      let emitted = 0;
      for (const stop of result.stops) {
        outStream.write(JSON.stringify(stop) + '\n');
        emitted++;
        totalCandidatesEmitted++;
        candidatesPerProject[slug]++;
      }

      if (emitted > 0) {
        console.error(`[done] ${ses.id.slice(0, 16)}… → ${emitted} stop(s) (${result.realUserCount} user turns)`);
      }
    }
  }

  await new Promise((resolve, reject) => {
    outStream.end(err => (err ? reject(err) : resolve()));
  });

  console.error('\n=== SUMMARY ===');
  console.error(`Sessions scanned : ${totalSessionsScanned}`);
  console.error(`Sessions skipped : ${totalSessionsSkipped}`);
  console.error(`Candidates emitted: ${totalCandidatesEmitted}`);
  console.error(`Output written to : ${outputPath}`);
  console.error('\nCandidates per project_slug:');
  for (const [slug, count] of Object.entries(candidatesPerProject).sort((a, b) => b[1] - a[1])) {
    if (count > 0) console.error(`  ${slug}: ${count}`);
  }
}

main().catch(err => {
  console.error(`[fatal] ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
