#!/usr/bin/env python3
"""Extract compact per-session digests from OpenCode SQLite + Claude Code jsonl.

Output: one .txt digest per session into OUT_DIR, focused on the signals needed
to reason about WHY an agent stopped/idled: the user task, follow-ups, the
assistant's final message, questions it asked, and tool activity per turn.
"""
import json, os, sqlite3, glob, sys, re

OUT = "/tmp/session-digests"
os.makedirs(OUT, exist_ok=True)

TURN_CAP = 500       # chars per intermediate turn
FINAL_CAP = 1800     # chars for the final assistant turn (stop/idle reasoning)
MIN_USER_TURNS = 1

def clean(s):
    if not isinstance(s, str): s = str(s)
    s = re.sub(r"\s+\n", "\n", s)
    return s.strip()

def trunc(s, n):
    s = clean(s)
    return s if len(s) <= n else s[:n] + " …[truncated]"

def write_digest(source, sid, title, directory, turns, last_finish, body, n_user, n_asst):
    # Only keep sessions with real interaction
    if n_user < MIN_USER_TURNS or n_asst < 1:
        return False
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", sid)[:60]
    path = os.path.join(OUT, f"{source}__{safe}.txt")
    header = (
        f"SOURCE: {source}\nSESSION_ID: {sid}\nTITLE/PROJECT: {title}\n"
        f"DIRECTORY: {directory}\nUSER_TURNS: {n_user}  ASSISTANT_TURNS: {n_asst}\n"
        f"LAST_FINISH_REASON: {last_finish}\n"
        + "=" * 60 + "\nCONVERSATION (compact, oldest→newest)\n" + "=" * 60 + "\n"
    )
    with open(path, "w") as f:
        f.write(header + body)
    return True

# ---------------- OpenCode ----------------
def extract_opencode(db_path, source_tag):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    sessions = con.execute("SELECT * FROM session ORDER BY time_updated DESC").fetchall()
    count = 0
    for s in sessions:
        sid = s["id"]
        msgs = con.execute(
            "SELECT * FROM message WHERE session_id=? ORDER BY time_created ASC", (sid,)
        ).fetchall()
        if not msgs:
            continue
        lines = []
        n_user = n_asst = 0
        last_finish = ""
        for i, m in enumerate(msgs):
            md = json.loads(m["data"])
            role = md.get("role")
            parts = con.execute(
                "SELECT data FROM part WHERE message_id=? ORDER BY time_created ASC", (m["id"],)
            ).fetchall()
            texts, tools = [], []
            for p in parts:
                pd = json.loads(p["data"])
                t = pd.get("type")
                if t == "text" and pd.get("text"):
                    texts.append(pd["text"])
                elif t == "tool":
                    tools.append(pd.get("tool", "?"))
            text = "\n".join(texts).strip()
            is_final = (i == len(msgs) - 1)
            if role == "user":
                n_user += 1
                lines.append(f"\n[USER {n_user}] {trunc(text, TURN_CAP)}")
            elif role == "assistant":
                n_asst += 1
                last_finish = md.get("finish", "") or ""
                toolstr = f" (tools: {','.join(tools)})" if tools else " (no tools)"
                cap = FINAL_CAP if is_final else TURN_CAP
                fin = f" [finish={last_finish}]" if is_final else ""
                lines.append(f"\n[ASSISTANT {n_asst}]{toolstr}{fin} {trunc(text, cap)}")
        title = s["title"] if "title" in s.keys() else ""
        directory = s["directory"] if "directory" in s.keys() else ""
        if write_digest(source_tag, sid, title, directory, len(msgs), last_finish,
                        "\n".join(lines), n_user, n_asst):
            count += 1
    con.close()
    return count

# ---------------- Claude Code ----------------
def claude_text(content):
    if isinstance(content, str):
        return content, []
    texts, tools = [], []
    if isinstance(content, list):
        for p in content:
            if not isinstance(p, dict):
                continue
            t = p.get("type")
            if t == "text":
                texts.append(p.get("text", ""))
            elif t == "tool_use":
                tools.append(p.get("name", "?"))
            elif t == "tool_result":
                pass
    return "\n".join(texts).strip(), tools

def extract_claude(projects_glob):
    count = 0
    for f in glob.glob(projects_glob):
        try:
            raw = [json.loads(l) for l in open(f) if l.strip()]
        except Exception:
            continue
        msgs = [d for d in raw if d.get("type") in ("user", "assistant")]
        if not msgs:
            continue
        # project name from path
        proj = os.path.basename(os.path.dirname(f))
        sid = os.path.splitext(os.path.basename(f))[0]
        lines = []
        n_user = n_asst = 0
        last_finish = ""
        for i, d in enumerate(msgs):
            m = d.get("message", {})
            role = m.get("role")
            text, tools = claude_text(m.get("content"))
            # skip pure tool_result user turns (no human text)
            is_final = (i == len(msgs) - 1)
            if role == "user":
                # tool_result-only user turns have empty text
                if not text:
                    continue
                # skip command stdout / system reminders noise heuristically kept
                n_user += 1
                lines.append(f"\n[USER {n_user}] {trunc(text, TURN_CAP)}")
            elif role == "assistant":
                n_asst += 1
                last_finish = m.get("stop_reason", "") or ""
                toolstr = f" (tools: {','.join(tools)})" if tools else " (no tools)"
                cap = FINAL_CAP if is_final else TURN_CAP
                fin = f" [stop_reason={last_finish}]" if is_final else ""
                body = text if text else "(no text — tool calls only)"
                lines.append(f"\n[ASSISTANT {n_asst}]{toolstr}{fin} {trunc(body, cap)}")
        if write_digest("claude", sid, proj, proj, len(msgs), last_finish,
                        "\n".join(lines), n_user, n_asst):
            count += 1
    return count

if __name__ == "__main__":
    home = os.path.expanduser("~")
    oc = extract_opencode(f"{home}/.local/share/opencode/opencode-local.db", "opencode")
    oc2 = extract_opencode(f"{home}/.local/share/opencode/opencode.db", "opencodeOld")
    cc = extract_claude(f"{home}/.claude/projects/*/*.jsonl")
    print(f"opencode(local): {oc}  opencode(old): {oc2}  claude: {cc}")
    print(f"digests in {OUT}: {len(os.listdir(OUT))}")
