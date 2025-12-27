# OpenCode Reflection Plugin
<img width="1250" height="1304" alt="image" src="https://github.com/user-attachments/assets/87485f92-2117-47bd-ace2-b6bf217be800" />


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

- Automatic trigger on session idle
- Collects context: last user task, AGENTS.md, last 10 tool calls, last assistant response
- Creates separate judge session for unbiased evaluation
- Auto-continues agent with feedback if task incomplete
- Max 3 attempts to prevent infinite loops

## Configuration

```typescript
const MAX_REFLECTION_ATTEMPTS = 3  // Edit in reflection.ts
```

## Requirements

- OpenCode v1.0+
- Uses currently selected model for judge

## License

MIT
