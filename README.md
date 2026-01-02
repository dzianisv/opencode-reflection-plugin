# OpenCode Plugins

<img width="1250" height="1304" alt="image" src="https://github.com/user-attachments/assets/87485f92-2117-47bd-ace2-b6bf217be800" />
<img width="1276" height="1403" alt="image" src="https://github.com/user-attachments/assets/7a08c451-b7b3-46b8-b694-6b3f6f4071a5" />

A collection of plugins for [OpenCode](https://github.com/sst/opencode):

1. **reflection.ts** - A reflection/judge layer that verifies task completion and forces the agent to continue if work is incomplete
2. **tts.ts** - Text-to-speech plugin that reads agent responses aloud (macOS)

---

## TTS Plugin

Reads the final agent response aloud when a session completes using macOS native TTS.

### Features
- Uses native macOS `say` command (no dependencies)
- Cleans markdown, code blocks, URLs from text before speaking
- Truncates long messages (1000 char limit)
- Skips judge/reflection sessions
- Tracks sessions to prevent duplicate speech

### Installation

```bash
mkdir -p ~/.config/opencode/plugin && \
curl -fsSL -o ~/.config/opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/tts.ts
```

Then restart OpenCode.

### Customization

Edit constants in `tts.ts`:
- `MAX_SPEECH_LENGTH`: Max characters to speak (default: 1000)
- `-r 200`: Speaking rate in words per minute
- Add `-v VoiceName` to use specific voice (run `say -v ?` to list available voices)

---

## Reflection Plugin

## How It Works

### Flow Diagram

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User Task      │────▶│  Agent Works     │────▶│ Session Idle    │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
                                                  ┌─────────────────┐
                                                  │  Judge Session  │
                                                  │  (Hidden)       │
                                                  │                 │
                                                  │ Evaluates:      │
                                                  │ • Initial task  │
                                                  │ • AGENTS.md     │
                                                  │ • Tool calls    │
                                                  │ • Agent output  │
                                                  └────────┬────────┘
                                                          │
                                   ┌──────────────────────┴──────────────────────┐
                                   ▼                                             ▼
                          ┌──────────────────┐                         ┌──────────────────┐
                          │ Task Incomplete  │                         │  Task Complete   │
                          │                  │                         │                  │
                          │ Toast: ⚠️ (1/3) │                         │ Toast: ✓ Success │
                          │ Chat: Feedback   │                         │ Chat: Summary    │
                          └────────┬─────────┘                         └──────────────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │ Agent Continues  │
                          │ with guidance    │
                          └──────────────────┘
```

### OpenCode APIs Used

The plugin integrates seamlessly using OpenCode's official plugin APIs:

#### 1. **Plugin Hooks** (`@opencode-ai/plugin`)
```typescript
export const ReflectionPlugin: Plugin = async ({ client, directory }) => {
  // Returns hooks object with event handlers
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        // Trigger reflection when session idles
      }
    }
  }
}
```

#### 2. **Session Management** (`client.session.*`)
```typescript
// Create judge session
const { data: judgeSession } = await client.session.create({})

// Send prompt to judge
await client.session.prompt({
  path: { id: judgeSession.id },
  body: { parts: [{ type: "text", text: prompt }] }
})

// Get session messages for context
const { data: messages } = await client.session.messages({ 
  path: { id: sessionId } 
})

// Send feedback to user session
await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{
      type: "text",
      text: "## Reflection: Task Incomplete\n\n..."
    }]
  }
})
```

#### 3. **Toast Notifications** (`client.tui.publish`)
```typescript
// Show non-intrusive status updates in OpenCode UI
await client.tui.publish({
  query: { directory },
  body: {
    type: "tui.toast.show",
    properties: {
      title: "Reflection",
      message: "Task complete ✓",
      variant: "success",  // "info" | "success" | "warning" | "error"
      duration: 5000
    }
  }
})
```

### Key Design Decisions

1. **Separate Judge Session**: Creates a hidden session for unbiased evaluation, preventing context pollution
2. **Dual Feedback Channel**:
   - **Toast notifications**: Quick, color-coded status (doesn't pollute chat)
   - **Chat messages**: Detailed feedback that triggers agent to respond
3. **Context Collection**: Gathers last user message, AGENTS.md, recent tool calls, and agent output
4. **Infinite Loop Prevention**: Tracks judge sessions and limits to 3 attempts per task
5. **Always Provides Feedback**: Both successful and failed tasks receive confirmation/guidance

## Installation

### Initial Setup

**Global installation** (applies to all projects):
```bash
mkdir -p ~/.config/opencode/plugin && \
curl -fsSL -o ~/.config/opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts
```

**Project-specific installation** (only for current project):
```bash
mkdir -p .opencode/plugin && \
curl -fsSL -o .opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts
```

### Activating the Plugin

After installation, you must restart OpenCode to load the plugin:

**If you have running tasks:**
- Wait for tasks to complete
- Then restart OpenCode

**To restart OpenCode:**

1. **Terminal/TUI mode:**
   ```bash
   # Stop current session (Ctrl+C)
   # Then restart
   opencode
   ```

2. **Background/Server mode:**
   ```bash
   # Find and stop OpenCode processes
   pkill opencode
   
   # Or restart specific server
   opencode serve --restart
   ```

3. **Force restart all OpenCode processes:**
   ```bash
   pkill -9 opencode && sleep 2 && opencode
   ```

### Updating the Plugin

To update to the latest version:

```bash
# Global update
curl -fsSL -o ~/.config/opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts

# Project-specific update  
curl -fsSL -o .opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts

# Then restart OpenCode (see above)
```

### Verifying Installation

Check if the plugin is loaded:
```bash
# Check plugin file exists
ls -lh ~/.config/opencode/plugin/reflection.ts

# After starting OpenCode, you should see reflection toasts when tasks complete
```

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

## Technical Implementation

### Plugin Architecture

```typescript
// 1. Listen for session idle events
event: async ({ event }) => {
  if (event.type === "session.idle") {
    await judge(event.properties.sessionID)
  }
}

// 2. Extract context from session
const extracted = extractFromMessages(messages)
// Returns: { task, result, tools }

// 3. Create judge session and evaluate
const judgePrompt = `TASK VERIFICATION
## Original Task
${extracted.task}

## Agent's Response  
${extracted.result}

Evaluate if this task is COMPLETE. Reply with JSON:
{
  "complete": true/false,
  "feedback": "..."
}`

// 4. Parse verdict and take action
if (!verdict.complete) {
  // Show warning toast
  await showToast("Task incomplete (1/3)", "warning")
  
  // Send feedback to session
  await client.session.prompt({
    path: { id: sessionId },
    body: { parts: [{ type: "text", text: feedback }] }
  })
} else {
  // Show success toast
  await showToast("Task complete ✓", "success")
}
```

### API Integration Points

| API | Purpose | Type |
|-----|---------|------|
| `client.session.create()` | Create judge session | Session Management |
| `client.session.prompt()` | Send prompts and feedback | Session Management |
| `client.session.messages()` | Get conversation context | Session Management |
| `client.tui.publish()` | Show toast notifications | UI Feedback |
| `event.type === "session.idle"` | Trigger reflection | Event Hook |

## Known Limitations

⚠️ **Timeout with slow models**: The current implementation uses the blocking `client.session.prompt()` API, which has a ~90 second timeout. This may cause failures with slower models like Claude Opus 4.5. See [AGENTS.md](AGENTS.md) for the recommended `promptAsync()` + polling solution.

## Configuration

```typescript
const MAX_REFLECTION_ATTEMPTS = 3  // Edit in reflection.ts
```

## Requirements

- OpenCode v1.0+
- Uses currently selected model for judge

## License

MIT
