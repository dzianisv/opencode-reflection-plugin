# OpenCode Plugins

> ⚠️ **Archived — superseded by [dzianisv/agents-supervisor](https://github.com/dzianisv/agents-supervisor).**
> The reflection/supervisor plugin was extracted into its own repo (rebranded
> "supervisor"): dual-runtime (Claude Code + OpenCode), one shared core, plus
> `/supervisor:train` (learn from your sessions) and a goal loop. Use that repo.
> This repo is kept read-only for history; branch-cleanup recovery notes live in
> [`docs/branch-cleanup-2026-06.md`](docs/branch-cleanup-2026-06.md).

**78% of AI coding agent stops are premature.** This is a judge layer that catches them.

[![Tests](https://github.com/dzianisv/opencode-plugins/actions/workflows/test.yml/badge.svg)](https://github.com/dzianisv/opencode-plugins/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/opencode-reflection.svg)](https://www.npmjs.com/package/opencode-reflection)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

We measured it: 143 real OpenCode + Claude Code sessions, 227 stops classified. **177/227 (78%) were premature** — 91 stopped to ask "Want me to run the tests?" when they had Bash, 68 listed "Next: create PR" and stopped without doing it.

`Reflection-3` fires after every agent turn, classifies the stop as complete or premature, and re-prompts with targeted feedback if the agent quit early. It enforces workflow gates: tests must run and pass, PR must be created, CI must be green.

**Works on OpenCode and Claude Code.**

```json
// opencode.json — add one line
{ "plugin": ["opencode-reflection"] }
```

```
# Claude Code
/plugin marketplace add dzianisv/opencode-plugins
/plugin install reflection-cc
```

<img width="1428" height="926" alt="Reflection plugin in action" src="https://github.com/user-attachments/assets/1f507538-be9e-43a4-a1da-cb328e8e1878" />

---

| Plugin | What it does |
|--------|-------------|
| **reflection-3.ts** | Judge layer — re-prompts agent when it stops prematurely |
| **tts.ts** | TTS + Telegram notifications with two-way voice communication |
| **worktree-status.ts** | Git worktree status tool |

## The problem in detail

Your coding agent says "Want me to run the tests?" — it has Bash. It writes "Next step: create PR" and stops. It claims "done" without running CI. These aren't rare edge cases. We measured 78%.

The reflection plugin catches this by running a judge after every idle event. The judge's rubric is mined from real sessions, not hand-written heuristics:
- **PERMISSION-SEEKING**: final turn is a yes/no question about something the agent can do itself → premature
- **STOPPED-WITH-TODOS**: response lists "remaining tasks" and stops → premature
- **FALSE-COMPLETE**: claims done but no test commands ran → premature

Implements [Reflexion](https://lilianweng.github.io/posts/2023-06-23-agent/) (Shinn et al. 2023): actor = coding agent, evaluator = LLM judge, verbal feedback injected back into context, max 3 retries. See [`docs/reflection.blog.md`](docs/reflection.blog.md) for the full technical writeup.

| Plugin | Description |
|--------|-------------|
| **reflection-3.ts** | Judge layer that verifies task completion and forces agent to continue if incomplete |
| **tts.ts** | Text-to-speech + Telegram notifications with two-way communication |
| **worktree-status.ts** | Git worktree status tool for checking dirty state, branch, and active sessions |

### Key Features

- **Automatic task verification** - Judge evaluates completion after each agent response
- **Self-healing workflow** - Agent receives feedback and continues if work is incomplete
- **Telegram notifications** - Get notified when tasks finish, reply via text or voice
- **Local TTS** - Hear responses read aloud (Coqui VCTK/VITS, Chatterbox, macOS)
- **Voice-to-text** - Reply to Telegram with voice messages, transcribed by local Whisper

## OpenCode Install

Add `"opencode-reflection"` to the `plugin` array in `opencode.json`.

**Global** (`~/.config/opencode/opencode.json` — applies to every project):
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-reflection"]
}
```

**Per-project** (create `opencode.json` at repo root):
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-reflection"]
}
```

**From a local clone** (dev / pin-to-commit):
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-plugins/packages/reflection"]
}
```

OpenCode resolves the entry point from `package.json` `exports`, imports the default export (a `Plugin` function), and calls it at startup. No manual `bun install` needed — OpenCode handles deps.

Restart OpenCode after editing `opencode.json` to activate.

---

## Claude Code Install

### Via `/plugin` marketplace (recommended)

Inside a Claude Code session:

```
/plugin marketplace add dzianisv/opencode-plugins
/plugin install reflection-cc
```

Or from the CLI directly:

```bash
claude plugin marketplace add dzianisv/opencode-plugins
claude plugin install reflection-cc
```

This registers the marketplace from `dzianisv/opencode-plugins` (`.claude-plugin/marketplace.json`) and installs the `reflection-cc` Stop hook into your Claude Code settings. No npm deps required — `reflect.mjs` is self-contained.

### Manual install (always works)

Add the Stop hook to `~/.claude/settings.json` (global) or `.claude/settings.json` (project-level):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/opencode-plugins/claude/bin/reflect.mjs",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

> **Note:** the event name is `"Stop"` (capital S) — lowercase `"stop"` is silently ignored.

**Verify it's running:**
```bash
echo '{"session_id":"test","transcript_path":"/dev/null","stop_hook_active":false}' \
  | node /path/to/opencode-plugins/claude/bin/reflect.mjs
# → exits 0 (no transcript = approve by default)
```

---

## Quick Install (copy-script method — OpenCode only)

```bash
curl -fsSL https://raw.githubusercontent.com/dzianisv/opencode-plugins/main/install.sh | bash
```

Downloads all plugins to `~/.config/opencode/plugin/`, installs dependencies, ready to go. Restart OpenCode after.

**Prerequisites:** [bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)

## Agent Skills

This repo also provides [Agent Skills](https://agentskills.io) — reusable capabilities for AI coding agents.

[![skills.sh](https://skills.sh/b/dzianisv/opencode-plugins)](https://skills.sh/dzianisv/opencode-plugins)

### Install skills

```bash
npx skills add dzianisv/opencode-plugins
```

### Available skills

| Skill | Description |
|-------|-------------|
| **opencode-session-db** | Read OpenCode sessions and messages directly from the SQLite database |
| **agent-evaluation** | Evaluate GenAI agent task execution using LLM-as-judge |
| **feature-workflow** | Standard workflow for developing features from planning through PR merge |
| **plugin-testing** | Verify plugin spec requirements with actionable test cases |
| **readiness-check** | Verify all OpenCode plugin services are healthy and ready |

<details>
<summary>Manual install</summary>

```bash
mkdir -p ~/.config/opencode/plugin && \
curl -fsSL -o ~/.config/opencode/plugin/reflection-3.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-plugins/main/reflection-3.ts && \
curl -fsSL -o ~/.config/opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-plugins/main/tts.ts && \
curl -fsSL -o ~/.config/opencode/plugin/telegram.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-plugins/main/telegram.ts && \
curl -fsSL -o ~/.config/opencode/plugin/worktree.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-plugins/main/worktree.ts

# Install required dependencies
cd ~/.config/opencode && \
  bun add @supabase/supabase-js@^2.49.0 && \
  bun install
```
</details>

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              OpenCode Plugins                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────┐   │
│  │  reflection-3.ts │    │     tts.ts       │    │  worktree-status.ts  │   │
│  │                  │    │                  │    │                      │   │
│  │ • Judge layer    │    │ • Local TTS      │    │ • Git dirty check    │   │
│  │ • Task verify    │    │ • Whisper STT    │    │ • Branch status      │   │
│  │ • Auto-continue  │    │ • Telegram notif │    │ • Active sessions    │   │
│  └──────────────────┘    └────────┬─────────┘    └──────────────────────┘   │
│                                   │                                          │
│                    ┌──────────────┼──────────────┐                          │
│                    ▼              ▼              ▼                          │
│           ┌──────────────┐ ┌────────────┐ ┌──────────────────────┐          │
│           │ TTS Engines  │ │telegram.ts │ │   Supabase Backend   │          │
│           │              │ │  (helper)  │ │                      │          │
│           │ • Coqui XTTS │ │            │ │ • Edge Functions     │          │
│           │ • Chatterbox │ │ • Notifier │ │ • PostgreSQL + RLS   │          │
│           │ • macOS say  │ │ • Supabase │ │ • Realtime subscr.   │          │
│           └──────────────┘ └────────────┘ └──────────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Note:** `telegram.ts` is a helper module (not a standalone plugin) that provides Telegram notification functions used by `tts.ts`.

---

## Reflection Plugin

Evaluates task completion after each agent response and provides feedback if work is incomplete.

### How It Works

1. **Trigger**: `session.idle` event fires when agent finishes responding
2. **Context Collection**: Extracts task, AGENTS.md, tool calls, agent output
3. **Judge Session**: Creates separate hidden session via OpenCode Sessions API for unbiased evaluation
4. **Verdict**: PASS → toast notification | FAIL → feedback injected into chat
5. **Continuation**: Agent receives feedback and continues working

### Relation to Reflexion (Weng 2023 / Shinn et al. 2023)

This plugin is, in the taxonomy of Lilian Weng's [*LLM Powered Autonomous Agents*](https://lilianweng.github.io/posts/2023-06-23-agent/),
a **Reflexion**-style self-improvement loop — not ReAct, Chain-of-Hindsight, or
Algorithm Distillation. The mapping is almost one-to-one:

| Reflexion concept (Weng / Shinn et al.) | This plugin |
| --- | --- |
| **Actor** — the policy LLM that acts | The coding agent (OpenCode / Claude Code) itself |
| **Evaluator** — scores the trajectory | The LLM-as-judge self-assessment (`buildSelfAssessmentPrompt` / `classifyStop`), run in an unbiased hidden session |
| **Self-reflection** — verbal feedback added to memory for the next attempt | The feedback string injected back into the chat / the Stop-hook `block` reason — natural-language, not a scalar reward |
| **Heuristic: "inefficient" trajectory (too long without success)** | `PLANNING_LOOP` detector — many tool calls with a near-zero write ratio (`PLANNING_LOOP_MIN_TOOL_CALLS`, `PLANNING_LOOP_WRITE_RATIO_THRESHOLD`) |
| **Heuristic: "hallucination" = consecutive identical actions → same observation** | `ACTION_LOOP` detector — repeated identical commands above `ACTION_LOOP_REPETITION_THRESHOLD` |
| **"Up to three reflections stored in working memory"** | `MAX_ATTEMPTS = 3` — at most three feedback injections per task before giving up |
| **Reset the environment to start a new trial** | Re-prompt the *same* session to continue (no env reset — agentic coding has no episodic reset) |

**Where it differs from textbook Reflexion:**

- **Trigger granularity.** Classic Reflexion evaluates at the end of an episode
  / on a failed trajectory. This plugin fires on the `session.idle` (OpenCode) or
  `Stop` (Claude Code) boundary — i.e. *every time the agent thinks it's done* —
  so its primary job is catching **premature stops**, not just failed runs.
- **Evaluator design.** Reflexion's evaluator is a task-specific heuristic (and
  sometimes an LLM). Here the evaluator is primarily an **LLM-as-judge** whose
  rubric is **mined from 227 real agent stops** (78% were premature), layered on
  top of the two Reflexion-style heuristics above.
- **Verbal, not numeric.** Like Reflexion (and unlike RLHF/CoH), the feedback is
  natural language fed straight back into context — no fine-tuning, no reward
  model, no gradient updates.

In short: **Reflexion = actor + evaluator + verbal self-reflection with a small
bounded memory of retries**, and that is exactly the shape of this plugin, with
the evaluator specialized toward detecting premature task abandonment.

### State Graph

```
session.idle fires
    |
    v
+---------------------------+
| GUARD CHECKS              |
| - Is judge/classifier?    |--yes--> SKIP
| - Is plan mode?           |--yes--> SKIP
| - Was ESC-aborted?        |--yes--> SKIP (10s cooldown)
| - Same user msg already   |--yes--> SKIP
|   reflected?              |
+----------+----------------+
           | no
           v
+---------------------------+
| A) BUILD TASK CONTEXT     |
| - Collect user messages   |
| - Infer task type         |
|   (coding/docs/research/  |
|    ops/other)             |
| - Detect repo signals     |
|   (package.json scripts,  |
|    test/ dir)             |
| - Extract tool commands   |
| - Determine workflow      |
|   requirements            |
+----------+----------------+
           v
+---------------------------+
| B) SELF-ASSESSMENT        |
| Request agent to produce  |
| JSON with evidence:       |
| - Did you complete task?  |
| - Did you run tests?      |
| - Did you create PR?      |
| - Did CI pass?            |
| - Are you stuck?          |
| (runs in ephemeral        |
|  session, not main)       |
+----------+----------------+
           v
+---------------------------+
| C) PARSE & EVALUATE      |
| Parse JSON --success--> evaluateSelfAssessment()
|            +--fail---> Judge LLM fallback
|                        |
| Workflow gate checks:  |
| 1. Tests ran? Passed?  |
|    Ran AFTER changes?  |
|    Not skipped/flaky?  |
| 2. Build ran? Passed?  |
| 3. PR created? URL?    |
|    Evidence (gh pr)?   |
| 4. CI checked? Passed? |
|    Evidence (gh pr     |
|    checks)?            |
| 5. No push to main?   |
| 6. Planning loop check |
+----------+----------------+
           v
+---------------------------+
| D) VERDICT                |
| Write .reflection/        |
|   verdict_<session>.json  |
|                           |
| Three outcomes:           |
| COMPLETE      --> Toast success, done
| NEEDS USER    --> Toast warning, done
| INCOMPLETE    --> Continue below
+----------+----------------+
           | incomplete
           v
+---------------------------+
| E) FEEDBACK + ROUTING     |
| - Classify task category  |
|   (backend/arch/frontend) |
| - Build escalating        |
|   feedback (attempt N/5)  |
| - Inject feedback into    |
|   session (optionally     |
|   with model routing)     |
| - Agent continues work    |
+---------------------------+
           |
           v
     (session.idle fires again --> loop back to top,
      up to MAX_ATTEMPTS=5)
```

### Features

- **OpenCode Sessions API**: Uses OpenCode's session management to create isolated judge sessions
- **Project-aware evaluation**: Reads `AGENTS.md` and skills to understand project-specific policies, testing requirements, and deployment rules
- **Rich context**: Task description, last 10 tool calls, agent response, and project guidelines
- Automatic trigger on session idle
- Non-blocking async evaluation with polling (supports slow models like Opus 4.5)
- Max 16 attempts per task to prevent loops
- Infinite loop prevention (skips judge sessions)
- Auto-reset counter when user provides new feedback

### Configuration

Constants in `reflection-3.ts`:
```typescript
const MAX_ATTEMPTS = 16          // Max reflection attempts per task (auto-resets on new user feedback)
const JUDGE_RESPONSE_TIMEOUT = 180_000  // 3 min timeout for judge
const POLL_INTERVAL = 2_000      // Poll every 2s
const STUCK_CHECK_DELAY = 30_000 // Check if agent stuck 30s after reflection feedback
const STUCK_NUDGE_DELAY = 15_000 // Nudge agent 15s after compression
```

### Judge Context

The judge session receives:
- **User's original task** - What was requested
- **AGENTS.md content** (first 1500 chars) - Project-specific policies, testing requirements, deployment checklist, and development workflows
- **Last 10 tool calls** - What actions the agent took
- **Agent's final response** (first 2000 chars) - What the agent reported

This allows the judge to verify compliance with project-specific rules defined in `AGENTS.md` and related skills, such as:
- Required testing procedures
- Build/deployment steps
- Code quality standards
- Security policies
- Documentation requirements

---

## TTS Plugin

Text-to-speech with Telegram integration for remote notifications and two-way communication.

### TTS Engines

| Engine | Quality | Speed | Setup |
|--------|---------|-------|-------|
| **Coqui TTS** | Excellent | Fast-Medium | Auto-installed, Python 3.9-3.11 |
| **Chatterbox** | Excellent | 2-5s | Auto-installed, Python 3.11 |
| **macOS say** | Good | Instant | None |

### Coqui TTS Models

| Model | Description | Multi-Speaker | Speed |
|-------|-------------|---------------|-------|
| `vctk_vits` | VCTK VITS (109 speakers, **recommended**) | Yes (p226 default) | Fast |
| `vits` | LJSpeech single speaker | No | Fast |
| `jenny` | Jenny voice | No | Medium |
| `xtts_v2` | XTTS v2 with voice cloning | Yes (via voiceRef) | Slower |
| `bark` | Multilingual neural TTS | No | Slower |
| `tortoise` | Very high quality | No | Very slow |

**Recommended**: `vctk_vits` with speaker `p226` (clear, professional British male voice)

### VCTK Speakers (vctk_vits model)

The VCTK corpus contains 109 speakers with various English accents. Speaker IDs are in format `pXXX`.

**Popular speaker choices:**

| Speaker | Gender | Accent | Description |
|---------|--------|--------|-------------|
| `p226` | Male | English | Clear, professional (recommended) |
| `p225` | Female | English | Clear, neutral |
| `p227` | Male | English | Deep voice |
| `p228` | Female | English | Warm tone |
| `p229` | Female | English | Higher pitch |
| `p230` | Female | English | Soft voice |
| `p231` | Male | English | Standard |
| `p232` | Male | English | Casual |
| `p233` | Female | Scottish | Scottish accent |
| `p234` | Female | Scottish | Scottish accent |
| `p236` | Female | English | Professional |
| `p237` | Male | Scottish | Scottish accent |
| `p238` | Female | N. Irish | Northern Irish |
| `p239` | Female | English | Young voice |
| `p240` | Female | English | Mature voice |
| `p241` | Male | Scottish | Scottish accent |
| `p243` | Male | English | Deep, authoritative |
| `p244` | Female | English | Bright voice |
| `p245` | Male | Irish | Irish accent |
| `p246` | Male | Scottish | Scottish accent |
| `p247` | Male | Scottish | Scottish accent |
| `p248` | Female | Indian | Indian English |
| `p249` | Female | Scottish | Scottish accent |
| `p250` | Female | English | Standard |
| `p251` | Male | Indian | Indian English |

<details>
<summary>All 109 VCTK speakers</summary>

```
p225, p226, p227, p228, p229, p230, p231, p232, p233, p234,
p236, p237, p238, p239, p240, p241, p243, p244, p245, p246,
p247, p248, p249, p250, p251, p252, p253, p254, p255, p256,
p257, p258, p259, p260, p261, p262, p263, p264, p265, p266,
p267, p268, p269, p270, p271, p272, p273, p274, p275, p276,
p277, p278, p279, p280, p281, p282, p283, p284, p285, p286,
p287, p288, p292, p293, p294, p295, p297, p298, p299, p300,
p301, p302, p303, p304, p305, p306, p307, p308, p310, p311,
p312, p313, p314, p316, p317, p318, p323, p326, p329, p330,
p333, p334, p335, p336, p339, p340, p341, p343, p345, p347,
p351, p360, p361, p362, p363, p364, p374, p376, ED
```

</details>

### Tortoise TTS Voices

Tortoise is a high-quality multi-speaker model. Specify the voice name in the `speaker` field.

**Available voices:**
`angie`, `applejack`, `daniel`, `deniro`, `emma`, `freeman`, `geralt`, `halle`, `jlaw`, `lj`, `mol`, `myself`, `pat`, `pat2`, `rainbow`, `snakes`, `tim_reynolds`, `tom`, `train_docks`, `weaver`, `william`

### Bark TTS Speakers

Bark is a multilingual model. Specify the speaker ID in the `speaker` field.

**English speakers:**
`v2/en_speaker_0` through `v2/en_speaker_9`

**Other languages:**
Replace `en` with language code (e.g., `v2/de_speaker_0`, `v2/fr_speaker_0`).
Supported: `en`, `de`, `es`, `fr`, `hi`, `it`, `ja`, `ko`, `pl`, `pt`, `ru`, `tr`, `zh`

### XTTS v2 Speakers

XTTS v2 is primarily a voice cloning model. Use the `voiceRef` option to clone any voice:

```json
{
  "coqui": {
    "model": "xtts_v2",
    "voiceRef": "/path/to/reference-voice.wav",
    "language": "en"
  }
}
```

Supported languages: `en`, `es`, `fr`, `de`, `it`, `pt`, `pl`, `tr`, `ru`, `nl`, `cs`, `ar`, `zh-cn`, `ja`, `hu`, `ko`

### Configuration

`~/.config/opencode/tts.json`:

```json
{
  "enabled": true,
  "engine": "coqui",
  "coqui": {
    "model": "vctk_vits",
    "device": "mps",
    "speaker": "p226",
    "serverMode": true
  },
  "os": {
    "voice": "Samantha",
    "rate": 200
  },
  "chatterbox": {
    "device": "mps",
    "useTurbo": true,
    "serverMode": true,
    "exaggeration": 0.5
  },
  "telegram": {
    "enabled": true,
    "uuid": "<your-uuid>",
    "sendText": true,
    "sendVoice": true,
    "receiveReplies": true
  }
}
```

### Configuration Options

#### Engine Selection

| Option | Description |
|--------|-------------|
| `engine` | `"coqui"` (default), `"chatterbox"`, or `"os"` |

#### Coqui Options (`coqui`)

| Option | Description | Default |
|--------|-------------|---------|
| `model` | TTS model (see table above) | `"vctk_vits"` |
| `device` | `"cuda"`, `"mps"`, or `"cpu"` | auto-detect |
| `speaker` | Speaker ID for multi-speaker models | `"p226"` |
| `serverMode` | Keep model loaded for fast requests | `true` |
| `voiceRef` | Path to voice clip for cloning (XTTS) | - |
| `language` | Language code for XTTS | `"en"` |

#### Chatterbox Options (`chatterbox`)

| Option | Description | Default |
|--------|-------------|---------|
| `device` | `"cuda"`, `"mps"`, or `"cpu"` | auto-detect |
| `useTurbo` | Use Turbo model (10x faster) | `true` |
| `serverMode` | Keep model loaded | `true` |
| `exaggeration` | Emotion level (0.0-1.0) | `0.5` |
| `voiceRef` | Path to voice clip for cloning | - |

#### OS TTS Options (`os`)

| Option | Description | Default |
|--------|-------------|---------|
| `voice` | macOS voice name (run `say -v ?` to list) | `"Samantha"` |
| `rate` | Words per minute | `200` |

### Toggle Commands

```
/tts        Toggle on/off
/tts on     Enable
/tts off    Disable
/tts status Check current state
```

---

## Telegram Integration

Two-way communication: receive notifications when tasks complete, reply via text or voice.

### Message Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         OUTBOUND (Task Complete)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  OpenCode ──► TTS Plugin ──► Supabase Edge ──► Telegram API ──► User        │
│     │              │         (send-notify)                                   │
│     │              │                                                         │
│     │         ┌────┴────┐                                                    │
│     │         │ Convert │  WAV → OGG (ffmpeg)                               │
│     │         │ audio   │                                                    │
│     │         └─────────┘                                                    │
│     │                                                                        │
│  Stores reply context (session_id, uuid) in telegram_reply_contexts table   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                         INBOUND (User Reply)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  TEXT REPLY:                                                                 │
│  User ──► Telegram ──► Webhook ──► telegram_replies table                   │
│                        (Edge Fn)           │                                 │
│                                            │ Supabase Realtime              │
│                                            ▼                                 │
│                                      TTS Plugin ──► OpenCode Session        │
│                                                     (promptAsync)            │
│                                                                              │
│  VOICE REPLY:                                                                │
│  User ──► Telegram ──► Webhook ──► Download audio ──► telegram_replies      │
│           (voice)     (Edge Fn)    (base64)                │                 │
│                                                            │ Realtime       │
│                                                            ▼                 │
│                                    TTS Plugin ──► Whisper STT ──► OpenCode  │
│                                    (local)        (transcribe)               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Setup

1. **Generate UUID:**
   ```bash
   uuidgen | tr '[:upper:]' '[:lower:]'
   ```

2. **Subscribe via Telegram:**
   - Open [@OpenCodeMgrBot](https://t.me/OpenCodeMgrBot)
   - Send: `/start <your-uuid>`

3. **Configure plugin** (`~/.config/opencode/tts.json`):
   ```json
   {
     "telegram": {
       "enabled": true,
       "uuid": "<your-uuid>",
       "receiveReplies": true
     }
   }
   ```

4. **Install ffmpeg** (for voice messages):
   ```bash
   brew install ffmpeg
   ```

### Bot Commands

| Command | Description |
|---------|-------------|
| `/start <uuid>` | Subscribe with your UUID |
| `/stop` | Unsubscribe |
| `/status` | Check subscription |

---

## Supabase Backend

All backend code is in `supabase/` - self-hostable.

### Database Schema

```sql
-- Maps UUID → Telegram chat_id
telegram_subscribers (
  uuid UUID PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  notifications_sent INTEGER DEFAULT 0
)

-- Stores reply context for two-way communication
telegram_reply_contexts (
  id UUID PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  uuid UUID REFERENCES telegram_subscribers(uuid),
  session_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
  is_active BOOLEAN DEFAULT TRUE
)

-- Incoming replies (text and voice)
telegram_replies (
  id UUID PRIMARY KEY,
  uuid UUID REFERENCES telegram_subscribers(uuid),
  session_id TEXT NOT NULL,
  reply_text TEXT,           -- NULL for voice before transcription
  is_voice BOOLEAN DEFAULT FALSE,
  audio_base64 TEXT,         -- Base64 audio for voice messages
  voice_file_type TEXT,      -- 'voice', 'video_note', 'video'
  voice_duration_seconds INTEGER,
  processed BOOLEAN DEFAULT FALSE
)
```

### Edge Functions

| Function | Purpose | Auth |
|----------|---------|------|
| `telegram-webhook` | Handles Telegram updates, stores replies | No JWT (Telegram calls it) |
| `send-notify` | Receives notifications from plugin | JWT optional |

### RLS Policies

```sql
-- Service role: full access (Edge Functions)
-- Anon role: SELECT for realtime, UPDATE via RPC

-- Secure function for marking replies processed
CREATE FUNCTION mark_reply_processed(p_reply_id UUID)
RETURNS BOOLEAN
SECURITY DEFINER  -- Bypasses RLS
```

### Realtime

Plugin subscribes to `telegram_replies` table changes:
```typescript
supabase.channel('telegram_replies')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public', 
    table: 'telegram_replies',
    filter: `uuid=eq.${uuid}`
  }, handler)
```

### Self-Hosting

```bash
# 1. Link to your Supabase project
supabase link --project-ref <your-project>

# 2. Push migrations
supabase db push

# 3. Deploy functions
supabase functions deploy telegram-webhook --no-verify-jwt
supabase functions deploy send-notify

# 4. Set secrets
supabase secrets set TELEGRAM_BOT_TOKEN=<token>

# 5. Configure webhook
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<project>.supabase.co/functions/v1/telegram-webhook"

# 6. Update tts.json with your serviceUrl
```

---

## Whisper STT

Local speech-to-text for voice message transcription.

### How It Works

1. Telegram voice message received by webhook
2. Audio downloaded and stored as base64 in `telegram_replies`
3. Plugin receives via Supabase Realtime
4. Local Whisper server transcribes audio
5. Transcribed text forwarded to OpenCode session

### Server

Auto-started on first voice message:
- Location: `~/.local/lib/whisper/`
- Port: 8787 (configurable)
- Model: `base` by default (configurable)

### Configuration

```json
{
  "whisper": {
    "enabled": true,
    "model": "base",
    "device": "auto",
    "port": 8787
  }
}
```

---

## File Locations

### OpenCode Config (`~/.config/opencode/`)

```
~/.config/opencode/
├── package.json              # Plugin dependencies (bun install)
├── opencode.json             # OpenCode config
├── tts.json                  # TTS + Telegram config
├── plugin/
│   ├── reflection-3.ts       # Reflection plugin (judge layer)
│   ├── tts.ts                # TTS plugin (speech + Telegram)
│   ├── lib/
│   │   └── telegram.ts       # Telegram helper module (used by tts.ts)
│   └── worktree-status.ts    # Git worktree status tool
└── node_modules/             # Dependencies (@supabase/supabase-js)
```

### Unified TTS & STT Storage (`~/.local/lib/`)

TTS and Whisper venvs are shared across multiple projects (opencode-plugins, opencode-manager, personal scripts) to save disk space (~4GB per duplicate venv avoided).

```
~/.local/lib/
├── tts/                      # ~1.8GB total
│   ├── coqui/
│   │   ├── venv/             # Shared Python venv with TTS package
│   │   ├── tts.py            # One-shot TTS script
│   │   ├── tts_server.py     # Persistent server script
│   │   ├── tts.sock          # Unix socket for IPC
│   │   └── server.pid        # Running server PID
│   └── chatterbox/
│       ├── venv/             # Chatterbox Python venv
│       ├── tts.py
│       ├── tts_server.py
│       ├── tts.sock
│       └── voices/           # Voice reference files
└── whisper/                  # ~316MB
    ├── venv/                 # Shared Python venv with faster-whisper
    ├── whisper_server.py     # STT server script
    └── server.pid
```

### Model Caches (NOT venvs)

Models are cached separately from venvs and managed by the respective libraries:

| Library | Cache Location | Size | Env Override |
|---------|---------------|------|--------------|
| **Coqui TTS** | `~/Library/Application Support/tts/` (macOS) | ~10GB | `TTS_HOME` |
| **Coqui TTS** | `~/.local/share/tts/` (Linux) | ~10GB | `TTS_HOME` or `XDG_DATA_HOME` |
| **Whisper** | `~/.cache/huggingface/hub/` | ~1-3GB | `HF_HOME` |

**Environment Variables:**
```bash
# Override TTS model location (applies to Coqui TTS)
export TTS_HOME=/custom/path/tts

# Override Whisper/HuggingFace cache
export HF_HOME=/custom/path/huggingface
```

---

## Development

```bash
# Clone
git clone https://github.com/dzianisv/opencode-plugins
cd opencode-plugins

# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Deploy to local OpenCode
npm run install:global
```

### Testing

```bash
# Unit tests
npm test

# E2E tests (requires OpenCode server)
OPENCODE_E2E=1 npm run test:e2e

# Manual TTS test
npm run test:tts:manual
```

---

## Requirements

- OpenCode v1.0+
- **TTS**: macOS (for `say`), Python 3.9-3.11 (Coqui), Python 3.11 (Chatterbox)
- **Telegram voice**: ffmpeg (`brew install ffmpeg`)
- **Dependencies**: `bun` (OpenCode installs deps from package.json)

## Why Use This?

| Without Reflection Plugin | With Reflection Plugin |
|--------------------------|------------------------|
| Agent says "done" but tests fail | Agent runs tests, sees failures, fixes them |
| You manually check every response | Automatic verification after each response |
| Context switching interrupts your flow | Get notified on Telegram, reply hands-free |
| Agent stops at first attempt | Up to 3 self-correction attempts |
| Hope it worked | Know it worked |

## Related Projects

- [OpenCode](https://github.com/sst/opencode) - Open-source AI coding agent (required)
- [Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code) - Anthropic's AI coding assistant
- [Cursor](https://cursor.sh/) - AI-powered code editor

## Keywords

`opencode` `ai-coding-assistant` `llm-agent` `task-verification` `self-reflection` `autonomous-coding` `telegram-bot` `text-to-speech` `whisper` `developer-tools` `productivity` `ai-automation`

## Contributing

Contributions welcome! Please read the [AGENTS.md](AGENTS.md) for development guidelines.

## License

MIT

---

<p align="center">
  <sub>Built for developers who want their AI to finish the job.</sub>
</p>
