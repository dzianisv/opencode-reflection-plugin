# OpenCode Reflection Plugin
<img width="1250" height="1304" alt="image" src="https://github.com/user-attachments/assets/87485f92-2117-47bd-ace2-b6bf217be800" />
<img width="1276" height="1403" alt="image" src="https://github.com/user-attachments/assets/7a08c451-b7b3-46b8-b694-6b3f6f4071a5" />


A plugin for [OpenCode](https://github.com/sst/opencode) that implements a **reflection/judge layer** to verify task completion and force the agent to continue if work is incomplete.

## How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User Task      │────▶│  Agent Works     │────▶│ Session Idle    │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Agent Continues │◀────│  FAIL + Feedback │◀────│  Judge Reviews  │
│ (if FAIL)       │     └──────────────────┘     │  - Initial task │
└─────────────────┘                              │  - AGENTS.md    │
        │                                        │  - Tool calls   │
        │              ┌──────────────────┐      │  - Thoughts     │
        └─────────────▶│  PASS = Done!    │◀─────│  - Final result │
                       └──────────────────┘      └─────────────────┘
```

## Installation

**Global:**
```bash
mkdir -p ~/.config/opencode/plugin && curl -fsSL -o ~/.config/opencode/plugin/reflection.ts https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts
```

**Project-specific:**
```bash
mkdir -p .opencode/plugin && curl -fsSL -o .opencode/plugin/reflection.ts https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts
```

Restart opencode after installation.

## Features

- **Automatic trigger** on session idle
- **Rich context collection**: last user task, AGENTS.md (1500 chars), last 10 tool calls, last assistant response (2000 chars)
- **Separate judge session** for unbiased evaluation
- **Chat-integrated feedback**: Reflection messages appear naturally in the OpenCode chat UI
- **Toast notifications**: Non-intrusive status updates (success/warning/error) in the OpenCode interface
- **Auto-continuation**: Agent automatically continues with feedback if task incomplete
- **Max 3 attempts** to prevent infinite loops
- **Infinite loop prevention**: Automatically skips judge sessions to prevent recursion
- **Always provides feedback**: Both complete and incomplete tasks receive confirmation/guidance

## Known Limitations

⚠️ **Timeout with slow models**: The current implementation uses the blocking `client.session.prompt()` API, which has a ~90 second timeout. This may cause failures with slower models like Claude Opus 4.5. See AGENTS.md for the recommended `promptAsync()` + polling solution.

## Configuration

```typescript
const MAX_REFLECTION_ATTEMPTS = 3  // Edit in reflection.ts
```

## Requirements

- OpenCode v1.0+
- Uses currently selected model for judge

## License

MIT
