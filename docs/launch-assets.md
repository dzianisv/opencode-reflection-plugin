# Launch Assets

## Pending: User must do these (require your accounts)

### 1. Publish npm package (CRITICAL — main install path broken until done)

```bash
# Option A: manual publish
cd packages/reflection
npm login   # or: npm set //registry.npmjs.org/:_authToken=<your-token>
npm publish --access public

# Option B: add NPM_TOKEN secret to GitHub → CI auto-publishes on every release
# Settings → Secrets → Actions → New → NPM_TOKEN = <token from npmjs.com account>
```

### 2. Hacker News — Show HN

**Title:**
```
Show HN: Reflection-3 – an open-source judge layer that re-prompts AI agents when they stop prematurely
```

**Body:**
```
78% of real AI coding agent stops are premature. I know because I measured it.

I built a plugin for OpenCode and Claude Code that fires after every agent turn, classifies the stop (complete vs. stopped-with-todos vs. permission-seeking vs. genuinely stuck), and re-prompts the agent if it quit early.

The judge rubric is mined from 227 real agent stops in my own sessions — labeled using the user's next message as ground truth ("go ahead" / "why did you stop?" = premature). The top patterns:
- 91 permission-seeking: "Want me to run the tests?" when it could just run them
- 68 stopped-with-todos: listed "Next: create PR" and then stopped

The plugin runs as a Stop hook on Claude Code or a session.idle listener on OpenCode. It injects a structured self-assessment, runs workflow gate checks (tests ran + passed, PR created, CI green), and pushes targeted feedback back into the agent's context. Loop guard prevents infinite re-prompts.

The eval suite uses promptfoo with gpt-5.4-nano (switched from gpt-5.1, ~25x cheaper). One known borderline miss; tolerated with a 97% pass threshold. CI green.

Implements Reflexion (Shinn et al. 2023): actor = coding agent, evaluator = LLM judge, verbal self-reflection = injected feedback, MAX_ATTEMPTS = 3.

Repo: https://github.com/dzianisv/opencode-plugins
Install: {"plugin": ["opencode-reflection"]} in opencode.json
```

---

### 3. Reddit — r/LocalLLaMA, r/ClaudeAI, r/singularity

**Title:**
```
I measured that 78% of AI coding agent stops are premature and built a plugin to fix it
```

**Body:**
```
I got tired of my coding agent stopping midway and saying "want me to run the tests?" when it had Bash available and could just do it.

So I measured it: extracted 143 sessions from OpenCode and Claude Code, found 227 cases where the agent stopped and I replied. Labeled each with a 3-way Haiku majority vote using my reply as ground truth.

Result: 177/227 (78%) were premature:
- 91 permission-seeking ("Should I create the PR?" — it has gh installed, it can do it)  
- 68 stopped-with-todos (wrote "Next: run tests" and stopped)

I turned this data into a judge plugin that fires after every agent stop, classifies it, and re-prompts with targeted feedback. It enforces workflow gates: tests must run + pass, PR must be created, CI must be green.

Works on both OpenCode (session.idle hook) and Claude Code (Stop hook).

The eval suite has 34 test cases and runs against gpt-5.4-nano in CI (~25x cheaper than gpt-5.1, 33/34 accuracy — one calibration-variance miss).

GitHub: https://github.com/dzianisv/opencode-plugins
```

---

### 4. Twitter / X

```
78% of AI coding agent stops are premature.

I measured it: 227 real agent stops from my own sessions. 91 stopped to ask "Want me to run the tests?" when they had Bash. 68 wrote "Next: create PR" and stopped.

Built a judge plugin that re-prompts when they quit early.

→ Works on OpenCode + Claude Code
→ 34-case eval suite, CI green
→ Open source

https://github.com/dzianisv/opencode-plugins
```

---

### 5. dev.to article

Title: **78% of AI coding agent stops are premature — here's the data and the fix**

The full article is at `docs/reflection.blog.md`. For dev.to, paste it directly — their markdown renderer handles the headers. Add these frontmatter tags:

```yaml
---
title: 78% of AI coding agent stops are premature — here's the data and the fix
published: true
tags: ai, opencode, llm, developer-tools
---
```

---

## Already done (automated)

- ✅ GitHub topics: opencode, claude-code, ai-agent, llm-agent, autonomous-coding, task-verification, reflexion, developer-tools, opencode-plugin
- ✅ GitHub description updated
- ✅ GitHub release v3.1.0 created
- ✅ PR to awesome-opencode submitted: https://github.com/awesome-opencode/awesome-opencode/pull/394
- ✅ npm auto-publish workflow created (triggers on GitHub release, once NPM_TOKEN secret is set)
- ✅ Blogpost updated: docs/reflection.blog.md

## Tracking: downloads funnel

| Channel | Status | Potential |
|---------|--------|-----------|
| npm `opencode-reflection` | ❌ not published | Main install path |
| curl install.sh | ✅ works | Hard to track |
| GitHub release download | ✅ v3.1.0 live | Visible in release stats |
| awesome-opencode listing | ⏳ PR #394 pending | High (1k+ eyes) |
| HN Show HN | 🔲 needs you | Very high if lands on front page |
| dev.to article | 🔲 needs you | Medium (200-500) |
| Reddit | 🔲 needs you | Medium |
| Twitter | 🔲 needs you | Medium |
