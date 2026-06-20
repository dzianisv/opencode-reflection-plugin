#!/usr/bin/env python3
"""Export high-signal 'did the agent stop too early?' examples for LLM classification.

Candidate = an example where the agent STOPPED/ASKED/DEFERRED and the user actually replied.
The user's follow-up is the ground-truth signal: if they said 'continue' or corrected the agent,
the stop was likely premature — exactly what the reflection plugin should have caught.

Writes one small prompt file per candidate to /tmp/stop-candidates/ + an index json.
Pure local, no LLM.
"""
import glob, os, json
import xml.etree.ElementTree as ET

SRC = os.path.join(os.path.dirname(__file__), "..", ".dataset")
OUT = "/tmp/stop-candidates"
STOP_TYPES = {"asked_question", "stopped_with_todos", "stopped_with_todos_and_question",
              "verification_deferral", "empty_output"}
CAP = 2200

def main():
    os.makedirs(OUT, exist_ok=True)
    for f in glob.glob(os.path.join(OUT, "*")):
        os.remove(f)
    index = []
    n = 0
    for p in sorted(glob.glob(os.path.join(SRC, "*.xml"))):
        root = ET.parse(p).getroot()
        sid = root.get("id"); source = root.get("source")
        task = (root.findtext("task") or "")[:600]
        for ex in root.findall("example"):
            c = ex.find("classification")
            st = c.get("stop_type")
            reac = c.get("followup_reaction")
            if st not in STOP_TYPES:
                continue
            if reac == "none":
                continue  # no follow-up = no ground truth
            ai = (ex.findtext("ai_output") or "")[:CAP]
            fu = (ex.findtext("user_followup") or "")[:800]
            ctx = (ex.findtext("context") or "")[:600]
            cid = f"{n:03d}"
            body = (
                f"SESSION TASK (what the user originally wanted):\n{task}\n\n"
                f"IMMEDIATE CONTEXT (the user turn the agent was responding to):\n{ctx}\n\n"
                f"AGENT OUTPUT (the turn where it stopped/handed back):\n{ai}\n\n"
                f"USER'S ACTUAL FOLLOW-UP (ground truth for whether the stop was right):\n{fu}\n\n"
                f"HEURISTIC LABELS: stop_type={st}, followup_reaction={reac}\n"
            )
            open(os.path.join(OUT, f"cand-{cid}.txt"), "w").write(body)
            index.append({"cid": cid, "session": sid, "source": source,
                          "turn": ex.get("turn"), "stop_type": st, "followup_reaction": reac})
            n += 1
    json.dump(index, open(os.path.join(OUT, "index.json"), "w"), indent=1)
    print(f"exported {n} stop-candidate examples -> {OUT}")
    from collections import Counter
    print("by stop_type:", dict(Counter(x['stop_type'] for x in index).most_common()))
    print("by followup:", dict(Counter(x['followup_reaction'] for x in index).most_common()))

if __name__ == "__main__":
    main()
