import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const evalsDir = path.resolve(__dirname, "..", "evals")

const env = { ...process.env }
const rawBase = env.AZURE_OPENAI_BASE_URL || env.AZURE_OPENAI_API_BASE_URL

if (rawBase) {
  try {
    const url = new URL(rawBase)
    const baseHost = `${url.protocol}//${url.host}`
    if (baseHost && rawBase !== baseHost) {
      env.AZURE_OPENAI_BASE_URL = baseHost
      env.AZURE_OPENAI_API_BASE_URL = baseHost
    }
  } catch {
    // Leave env as-is if AZURE_OPENAI_BASE_URL is not a valid URL
  }
}

const cliArgs = process.argv.slice(2)
const args = ["promptfoo", "eval", ...cliArgs]
const result = spawnSync("npx", args, {
  cwd: evalsDir,
  env,
  stdio: "inherit",
})

const exitCode = result.status ?? 1

// Suite pass-rate threshold (cost/fidelity lever).
//
// promptfoo exits non-zero if ANY single case fails. That is the right default
// for the high-fidelity gpt-5.1 judge (it scores a clean 34/34). But when a
// cheaper model is used to cut CI cost (e.g. azureopenai:chat:gpt-5.4-nano,
// ~25x cheaper), it scores ~33/34 — it disagrees with gpt-5.1 on a small number
// of *borderline* cases (calibration variance, not the premature-stop logic the
// suite exists to protect). EVAL_PASS_THRESHOLD lets CI stay green at a defined
// pass rate while still going red on a real regression (a 2nd failure).
//
// Set EVAL_PASS_THRESHOLD=0.97 to tolerate <=1 of 34 cases. Unset => native
// promptfoo behavior (every case must pass). The check only ever RELAXES a
// failing run; it never turns a passing run red, and a hard error (no output
// file, unparseable) falls back to promptfoo's own exit code.
const threshold = parseFloat(process.env.EVAL_PASS_THRESHOLD ?? "")
if (exitCode !== 0 && Number.isFinite(threshold) && threshold > 0 && threshold <= 1) {
  // Find the -o / --output JSON path from the forwarded args.
  let outPath
  for (let i = 0; i < cliArgs.length - 1; i++) {
    if ((cliArgs[i] === "-o" || cliArgs[i] === "--output") && cliArgs[i + 1].endsWith(".json")) {
      outPath = cliArgs[i + 1]
    }
  }
  if (outPath) {
    try {
      const resolved = path.isAbsolute(outPath) ? outPath : path.resolve(evalsDir, outPath)
      const report = JSON.parse(readFileSync(resolved, "utf8"))
      const cases = report.results?.results ?? []
      const total = cases.length
      const passed = cases.filter((c) => c.success === true).length
      const rate = total > 0 ? passed / total : 0
      const failed = cases.filter((c) => c.success === false)
      if (total > 0 && rate >= threshold) {
        console.log(
          `\n[run-promptfoo] pass rate ${passed}/${total} (${(rate * 100).toFixed(1)}%) ` +
            `>= EVAL_PASS_THRESHOLD ${(threshold * 100).toFixed(1)}% — treating as PASS.`,
        )
        if (failed.length) {
          console.log(`[run-promptfoo] tolerated borderline failures (${failed.length}):`)
          for (const c of failed) {
            console.log(`  - ${c.testCase?.description ?? c.description ?? "(no description)"}`)
          }
        }
        process.exit(0)
      }
      console.log(
        `\n[run-promptfoo] pass rate ${passed}/${total} (${(rate * 100).toFixed(1)}%) ` +
          `< EVAL_PASS_THRESHOLD ${(threshold * 100).toFixed(1)}% — FAIL.`,
      )
    } catch (err) {
      console.error(`[run-promptfoo] could not apply EVAL_PASS_THRESHOLD: ${err.message}`)
    }
  }
}

process.exit(exitCode)
