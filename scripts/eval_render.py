#!/usr/bin/env python3
"""Render promptfoo judge eval cases into a flat JSON the harness loop can use.

For each test: substitute {{vars}} into the prompt template and capture the raw
JS assertions verbatim so scoring stays identical to promptfoo.
"""
import yaml, json, re, sys, os

EVALS = os.path.join(os.path.dirname(__file__), "..", "evals")

def render(template, vars):
    out = template
    for k, v in vars.items():
        out = out.replace("{{" + k + "}}", str(v))
        out = out.replace("{{ " + k + " }}", str(v))
    return out

def main(cfg_name="promptfooconfig.yaml", prompt_file="prompts/task-verification.txt"):
    cfg = yaml.safe_load(open(os.path.join(EVALS, cfg_name)))
    # prompt file may be overridden by cfg
    pf = cfg["prompts"][0].replace("file://", "")
    template = open(os.path.join(EVALS, pf)).read()
    cases = []
    for i, t in enumerate(cfg["tests"]):
        vars = t.get("vars", {})
        asserts = [a.get("value", "") for a in t.get("assert", [])]
        cases.append({
            "id": i,
            "description": t.get("description", f"case-{i}"),
            "prompt": render(template, vars),
            "asserts": asserts,
        })
    out = {"cfg": cfg_name, "prompt_file": pf, "cases": cases}
    dest = "/tmp/eval-cases.json"
    json.dump(out, open(dest, "w"), indent=1)
    # also emit one prompt file per case for cheap per-agent reads
    cdir = "/tmp/eval-cases"
    os.makedirs(cdir, exist_ok=True)
    for f in os.listdir(cdir):
        if f.endswith(".txt"):
            os.remove(os.path.join(cdir, f))
    for c in cases:
        with open(os.path.join(cdir, f"case-{c['id']:02d}.txt"), "w") as fh:
            fh.write(c["prompt"])
    print(f"rendered {len(cases)} cases from {cfg_name} -> {dest} (+ per-case files in {cdir})")
    print(f"prompt template: {pf} ({len(template)} chars)")

if __name__ == "__main__":
    main(*(sys.argv[1:] or []))
