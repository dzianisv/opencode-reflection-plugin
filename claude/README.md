# reflection-cc

Re-prompts Claude Code when it stops prematurely due to failure modes like summary-drift-stop or tool-available-punt. This plugin intercepts the Stop hook, analyzes the session transcript using Claude Haiku, classifies the failure reason, and decides whether to re-prompt with recovery instructions or accept the stop.

## Install

**Recommended (works today, CC v2.x):** add the Stop hook directly to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/opencode-plugins/claude/bin/reflect.mjs",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

The plugin manifest under `.claude-plugin/` is included for future marketplace publication, but in CC v2.1.150 `--plugin-dir` and the `enabledPlugins` config path do NOT activate `Stop` hooks for headless `-p` sessions. The settings-based install above is the authoritative path until that gap closes.

**One-session try:** `claude --settings '<json above>'` ... or write the JSON to a file and pass `--settings ./reflect-settings.json`.

## Failure Categories

The classifier maps each Stop into one of these categories (only the first three trigger an inject):

| Category | Inject? | Description |
|----------|---------|-------------|
| `summary_drift_stop` | **yes** | Agent wrote a plan with a "next step" then stopped before doing it |
| `tool_available_punt` | **yes** | Agent asked the user about something an available tool could resolve |
| `genuinely_stuck` | **yes** | Agent halted mid-thought, no question, no plan |
| `complete` | no | Task finished |
| `working` | no | Mid-action narration (rare at Stop) |
| `waiting_for_user_legitimate` | no | Agent legitimately needs user input |

## How it works

1. **Stop Hook**: Claude Code invokes the Stop hook when the agent terminates
2. **Transcript Analysis**: Haiku classifies the session transcript into failure categories
3. **Verdict**: Judge decides to re-prompt with recovery instructions or accept the stop
4. **Session Guards**: Loop prevention via attempt counter (max 3 cycles per session)

## Testing

`node claude/test/e2e-cc.mjs` runs 4 real E2E scenarios:

- `explicit_wait_negative` — user asked "wait" → plugin must not inject.
- `complete_negative` — trivial Q&A → plugin must not inject.
- `attempt_cap_respected` — multi-file task → cap honored.
- `direct_pipe_summary_drift` — synthetic drift transcript piped to `reflect.mjs` → verifies the inject pathway end-to-end including schema-correct stdout.

Real `claude -p` headless sessions + real Anthropic API. No stubs. Costs roughly $0.05–0.20 per scenario via Haiku 4.5 over your Max-subscription OAuth. Out of CI (auth + cost). Run before any change to the hook payload format.

## Configuration

Environment variables:
- `REFLECTION_CC_DEBUG=1` — Enable debug output
- `REFLECTION_CC_MODEL` — Model for classification (default: `haiku-4-5`)
- `REFLECTION_CC_MAX_ATTEMPTS=3` — Max re-prompt cycles per session

## Disk Artifacts

Plugin stores local transcripts and verdicts:
- `.reflection/verdict_<sid>.json` — Haiku verdict + recovery instructions
- `.reflection/<sid>_<ts>.json` — Full transcript snapshot
- `.reflection/<sid>_attempts.json` — Attempt counter for session

**Privacy**: Transcripts stored locally only; never sent externally except to Haiku during classification.

## Status

Experimental. Baseline accuracy numbers pending PR evaluation.
