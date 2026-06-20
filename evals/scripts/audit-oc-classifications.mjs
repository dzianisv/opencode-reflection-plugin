#!/usr/bin/env node
// audit-oc-classifications.mjs — sample N records per category from the OC
// classified JSONL for supervisor (human or LLM) spot-check, and emit a
// redacted gold subset for committing under evals/datasets/.
//
// Mirrors audit-cc-classifications.mjs (same redaction rules).
//
// Usage:
//   node evals/scripts/audit-oc-classifications.mjs \
//     --in evals/datasets/oc-stop-classified.jsonl \
//     --out evals/datasets/oc-stop-labeled-gold-redacted.jsonl \
//     --per-cat 5

import { readFileSync, writeFileSync } from "node:fs";
import { argv, stderr } from "node:process";

const args = parseArgs(argv.slice(2));
const IN = args.in ?? "evals/datasets/oc-stop-classified.jsonl";
const OUT = args.out ?? "evals/datasets/oc-stop-labeled-gold-redacted.jsonl";
const PER_CAT = parseInt(args["per-cat"] ?? "5", 10);

function redact(s) {
  if (!s) return s;
  let out = s;
  out = out.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<REDACTED:email>");
  out = out.replace(/\bsk-ant-[A-Za-z0-9_\-]{20,}/g, "<REDACTED:token>");
  out = out.replace(/\bghp_[A-Za-z0-9]{20,}/g, "<REDACTED:token>");
  out = out.replace(/\bgho_[A-Za-z0-9]{20,}/g, "<REDACTED:token>");
  out = out.replace(/\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._\-]{20,}/gi, "Authorization: Bearer <REDACTED:token>");
  out = out.replace(/\bx-api-key\s*:\s*[A-Za-z0-9_\-]{20,}/gi, "x-api-key: <REDACTED:token>");
  out = out.replace(/\b(sk|pk|rk)_(test|live)_[A-Za-z0-9]{20,}/g, "<REDACTED:stripe>");
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, "<REDACTED:aws-access-key>");
  // JWT-shaped tokens: three dot-separated base64url segments.
  out = out.replace(/\b[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]{10,}\b/g, "<REDACTED:jwt>");
  // long alphanumeric likely-secrets (40+ chars no spaces)
  out = out.replace(/\b[A-Za-z0-9_\-]{40,}\b/g, m => {
    if (/^[0-9a-f]{32,64}$/i.test(m)) return m; // keep hashes
    return "<REDACTED:secret>";
  });
  out = out.replace(/\/home\/[\w.-]+\//g, "<REDACTED:home>/");
  out = out.replace(/github\.com\/[\w.-]+\/[\w.-]+/g, "github.com/<REDACTED>/<REDACTED>");
  return out;
}

function redactRecord(r) {
  return {
    project_slug: r.project_slug ? "<REDACTED:project>" : undefined,
    session_id: "<REDACTED:sid>",
    stop_index: r.stop_index,
    timestamp: r.timestamp,
    user_messages: (r.user_messages || []).map(redact),
    final_assistant_text: redact(r.final_assistant_text || ""),
    tools_available_inferred: r.tools_available_inferred || [],
    prior_tool_uses_count: r.prior_tool_uses_count,
    session_total_turns: r.session_total_turns,
    heuristic_tags: r.heuristic_tags,
    classification: r.classification,
    gold_label: null,
    gold_note: null,
  };
}

function main() {
  const lines = readFileSync(IN, "utf8").split("\n").filter(Boolean);
  const byCat = new Map();
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const cat = rec.classification?.category ?? "UNKNOWN";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(rec);
  }

  stderr.write(`Distribution:\n`);
  for (const [cat, arr] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    stderr.write(`  ${cat.padEnd(36)} ${arr.length}\n`);
  }

  // Stratified sample — use a fixed seed-ish deterministic sample to make
  // the gold file reproducible across runs.
  const out = [];
  for (const [cat, arr] of byCat) {
    // Deterministic sample: every Nth across the list
    const step = Math.max(1, Math.floor(arr.length / PER_CAT));
    for (let i = 0; i < arr.length && out.filter(o => o.classification?.category === cat).length < PER_CAT; i += step) {
      out.push(arr[i]);
    }
  }

  const redacted = out.map(redactRecord);
  writeFileSync(OUT, redacted.map(o => JSON.stringify(o)).join("\n") + "\n");

  stderr.write(`\nGold candidates: ${redacted.length}\n`);
  stderr.write(`Output         : ${OUT}\n`);
  stderr.write(`Next: edit each record, set "gold_label" to the correct category, optional "gold_note".\n`);
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

main();
