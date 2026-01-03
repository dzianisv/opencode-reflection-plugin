# OpenCode Plugins

<img width="1250" height="1304" alt="image" src="https://github.com/user-attachments/assets/87485f92-2117-47bd-ace2-b6bf217be800" />
<img width="1276" height="1403" alt="image" src="https://github.com/user-attachments/assets/7a08c451-b7b3-46b8-b694-6b3f6f4071a5" />

A collection of plugins for [OpenCode](https://github.com/sst/opencode):

| Plugin | Description | Platform |
|--------|-------------|----------|
| **reflection.ts** | Judge layer that verifies task completion and forces agent to continue if incomplete | All |
| **tts.ts** | Text-to-speech that reads agent responses aloud | macOS |

## Quick Install

### Install All Plugins

```bash
mkdir -p ~/.config/opencode/plugin && \
curl -fsSL -o ~/.config/opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts && \
curl -fsSL -o ~/.config/opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/tts.ts
```

Then restart OpenCode.

### Install Individual Plugins

**Reflection only:**
```bash
mkdir -p ~/.config/opencode/plugin && \
curl -fsSL -o ~/.config/opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts
```

**TTS only (macOS):**
```bash
mkdir -p ~/.config/opencode/plugin && \
curl -fsSL -o ~/.config/opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/tts.ts
```

### Project-Specific Installation

To install plugins for a specific project only:

```bash
mkdir -p .opencode/plugin && \
curl -fsSL -o .opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts && \
curl -fsSL -o .opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/tts.ts
```

---

## TTS Plugin

Reads the final agent response aloud when a session completes. Supports multiple TTS engines with automatic fallback.

### TTS Engines

| Engine | Quality | Speed | Requirements |
|--------|---------|-------|--------------|
| **Chatterbox** | Excellent - natural, expressive | ~2-5s | Python 3.11, **NVIDIA GPU required** |
| **OS** (default fallback) | Good | Instant | macOS only |

**Chatterbox** is [Resemble AI's open-source TTS](https://github.com/resemble-ai/chatterbox) - widely regarded as one of the best open-source TTS models, outperforming ElevenLabs in blind tests 63-75% of the time.

> **Note**: Chatterbox requires an NVIDIA GPU with CUDA support. On machines without a GPU, the plugin automatically falls back to OS TTS. Chatterbox on CPU is impractically slow (~3+ minutes per sentence).

### Features
- **Automatic setup**: Chatterbox is auto-installed in a virtualenv on first use
- **GPU auto-detection**: Falls back to OS TTS if no CUDA GPU detected
- **Chatterbox engine**: High-quality neural TTS with emotion control
- **OS engine**: Native macOS `say` command (zero dependencies)
- Cleans markdown, code blocks, URLs from text before speaking
- Truncates long messages (1000 char limit)
- Skips judge/reflection sessions

### Requirements

- **Python 3.11** must be installed for Chatterbox (install with `brew install python@3.11`)
- **NVIDIA GPU** with CUDA for Chatterbox (otherwise falls back to OS TTS)
- **macOS** for OS TTS fallback

### Configuration

Create/edit `~/.config/opencode/tts.json`:

```json
{
  "enabled": true,
  "engine": "chatterbox",
  "chatterbox": {
    "device": "cuda",
    "useTurbo": true,
    "exaggeration": 0.5,
    "voiceRef": "/path/to/voice-sample.wav"
  }
}
```

**Configuration options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable TTS |
| `engine` | string | `"chatterbox"` | TTS engine: `"chatterbox"` or `"os"` |
| `chatterbox.device` | string | `"cuda"` | Device: `"cuda"` (GPU) or `"cpu"` |
| `chatterbox.useTurbo` | boolean | `false` | Use Turbo model (faster, supports paralinguistic tags) |
| `chatterbox.exaggeration` | number | `0.5` | Emotion intensity (0.0-1.0) |
| `chatterbox.voiceRef` | string | - | Path to reference audio for voice cloning (5-10s WAV) |

**Environment variables** (override config):
- `TTS_DISABLED=1` - Disable TTS entirely
- `TTS_ENGINE=os` - Force OS TTS engine

### Quick Toggle

```
/tts        Toggle TTS on/off
/tts on     Enable TTS
/tts off    Disable TTS
```

### OS TTS Customization (macOS)

If using OS TTS, you can customize voice settings in `tts.ts`:
- `-r 200`: Speaking rate in words per minute
- Add `-v VoiceName` to use specific voice (run `say -v ?` to list voices)

---

## Reflection Plugin

A judge layer that evaluates task completion and provides feedback to continue if work is incomplete.

### How It Works

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
                          │ Toast: warning   │                         │ Toast: success   │
                          │ Chat: Feedback   │                         │                  │
                          └────────┬─────────┘                         └──────────────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │ Agent Continues  │
                          │ with guidance    │
                          └──────────────────┘
```

### Features

- **Automatic trigger** on session idle
- **Rich context collection**: last user task, AGENTS.md (1500 chars), last 10 tool calls, last assistant response (2000 chars)
- **Separate judge session** for unbiased evaluation
- **Chat-integrated feedback**: Reflection messages appear naturally in the OpenCode chat UI
- **Toast notifications**: Non-intrusive status updates (success/warning/error)
- **Auto-continuation**: Agent automatically continues with feedback if task incomplete
- **Max 3 attempts** to prevent infinite loops
- **Infinite loop prevention**: Automatically skips judge sessions to prevent recursion

### Configuration

Edit `~/.config/opencode/plugin/reflection.ts`:
```typescript
const MAX_ATTEMPTS = 3  // Maximum reflection attempts per task
```

---

## Activating Plugins

After installation, restart OpenCode to load the plugins:

**Terminal/TUI mode:**
```bash
# Stop current session (Ctrl+C), then restart
opencode
```

**Background/Server mode:**
```bash
pkill opencode
opencode serve
```

**Force restart:**
```bash
pkill -9 opencode && sleep 2 && opencode
```

## Updating Plugins

```bash
# Update all plugins
curl -fsSL -o ~/.config/opencode/plugin/reflection.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/reflection.ts && \
curl -fsSL -o ~/.config/opencode/plugin/tts.ts \
  https://raw.githubusercontent.com/dzianisv/opencode-reflection-plugin/main/tts.ts

# Then restart OpenCode
```

## Verifying Installation

```bash
# Check plugin files exist
ls -lh ~/.config/opencode/plugin/

# Expected output:
# reflection.ts
# tts.ts
```

---

## Technical Details

### OpenCode Plugin APIs Used

| API | Purpose | Plugin |
|-----|---------|--------|
| `client.session.create()` | Create judge session | Reflection |
| `client.session.promptAsync()` | Send prompts (non-blocking) | Reflection |
| `client.session.messages()` | Get conversation context | Both |
| `client.tui.publish()` | Show toast notifications | Reflection |
| `event.type === "session.idle"` | Trigger on completion | Both |

### Known Limitations

- **Reflection**: May timeout with very slow models (>3 min response time)
- **TTS Chatterbox**: Requires Python 3.11+ and ~2GB VRAM for GPU mode
- **TTS OS**: macOS only (uses `say` command)

## Requirements

- OpenCode v1.0+
- **TTS with Chatterbox**: Python 3.11+, `chatterbox-tts` package, GPU recommended
- **TTS with OS engine**: macOS

## License

MIT
