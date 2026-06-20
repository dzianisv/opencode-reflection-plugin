// Score judge verdicts against the original promptfoo JS assertions.
// Usage: node eval_score.mjs <cases.json> <verdicts.json>
//  cases.json  : { cases: [{id, description, asserts:[jsString]}] }
//  verdicts.json: [{ id, output }]  where output is the judge's raw text (must contain JSON)
import fs from "node:fs"

const cases = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).cases
const verdicts = JSON.parse(fs.readFileSync(process.argv[3], "utf8"))
const byId = new Map(verdicts.map(v => [v.id, v.output]))

function runAssert(jsBody, output) {
  // promptfoo asserts are function bodies referencing `output` and returning bool
  try {
    const fn = new Function("output", jsBody.includes("return") ? jsBody : `return (${jsBody})`)
    return fn(output) === true
  } catch (e) {
    return false
  }
}

let passed = 0
const failures = []
for (const c of cases) {
  const output = byId.get(c.id)
  if (output == null) {
    failures.push({ id: c.id, description: c.description, reason: "no verdict produced" })
    continue
  }
  const results = c.asserts.map(a => runAssert(a, output))
  const allPass = results.every(Boolean)
  if (allPass) passed++
  else {
    let verdict = null
    const m = output.match(/\{[\s\S]*\}/)
    if (m) { try { verdict = JSON.parse(m[0]) } catch {} }
    failures.push({
      id: c.id,
      description: c.description,
      failedAsserts: c.asserts.filter((_, i) => !results[i]),
      verdict: verdict ? { complete: verdict.complete, severity: verdict.severity, requires_human_action: verdict.requires_human_action } : "UNPARSEABLE",
    })
  }
}

const total = cases.length
console.log(JSON.stringify({
  passed, total, pct: Math.round((passed / total) * 1000) / 10,
  failures,
}, null, 1))
