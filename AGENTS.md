# OpenCode Plugins - Development Guidelines

## Available Plugins

1. **reflection.ts** - Judge layer that evaluates task completion and provides feedback
2. **tts.ts** - Text-to-speech that reads agent responses aloud (macOS)

## CRITICAL: Plugin Installation Location

**OpenCode loads plugins from `~/.config/opencode/plugin/`, NOT from npm global installs!**

When deploying changes:
1. Update source files in `/Users/engineer/workspace/opencode-reflection-plugin/`
2. **MUST COPY** to: `~/.config/opencode/plugin/`
3. Restart OpenCode for changes to take effect

```bash
# Deploy all plugin changes
cp /Users/engineer/workspace/opencode-reflection-plugin/reflection.ts ~/.config/opencode/plugin/
cp /Users/engineer/workspace/opencode-reflection-plugin/tts.ts ~/.config/opencode/plugin/
# Then restart opencode
```

The npm global install (`npm install -g`) is NOT used by OpenCode - it reads directly from the config directory.

## TTS Plugin (`tts.ts`)

### Overview
Reads the final agent response aloud when a session completes using macOS `say` command.

### Features
- Uses native macOS TTS (no dependencies)
- Cleans markdown/code from text before speaking
- Truncates long messages (1000 char limit)
- Skips judge/reflection sessions
- Tracks sessions to prevent duplicate speech

### Customization
Edit constants in `tts.ts`:
- `MAX_SPEECH_LENGTH`: Max characters to speak (default: 1000)
- `-r 200`: Speaking rate in words per minute
- Add `-v VoiceName` to use specific voice (run `say -v ?` to list)

### Testing
```bash
npm run test:tts        # Unit tests
npm run test:tts:manual # Actually speaks test phrases
```

## Plugin Architecture

### Message Flow
The plugin integrates seamlessly with OpenCode's UI:
- **Judge evaluation** happens in a separate session (invisible to user)
- **Reflection feedback** appears as user messages in the main chat via `client.session.prompt()` - **ONLY when task is incomplete**
- **Toast notifications** show status updates via `client.tui.publish()` (non-intrusive)

Feedback delivery methods:
1. **Chat messages** (`client.session.prompt()`):
   - ✅ Full feedback details with markdown formatting
   - ✅ Visible in message history
   - ✅ Triggers the agent to respond
   - ⚠️ **ONLY use for INCOMPLETE tasks** - using for complete tasks creates infinite loop
   
2. **Toast notifications** (`client.tui.publish()`):
   - ✅ Brief status updates (e.g., "Task complete ✓")
   - ✅ Non-intrusive, auto-dismiss
   - ✅ Color-coded by severity (success/warning/error)
   - ✅ Does NOT pollute terminal or chat
   - ✅ **Use for COMPLETE tasks** - no agent response triggered

### Feedback Design - CRITICAL
**Task Complete**: Toast notification ONLY - do NOT call `prompt()`
**Task Incomplete**: Send feedback via `prompt()` to trigger agent to continue

**WHY:** Calling `prompt()` on complete tasks creates an infinite loop:
1. Agent finishes task → session.idle fires
2. Plugin judges → "task complete" 
3. Plugin calls `prompt("Task Complete ✓")` → agent responds "Acknowledged"
4. session.idle fires again → goto step 2 (INFINITE LOOP!)

The fix: Complete tasks show a toast notification only. The user sees confirmation without triggering another agent response.

## Critical Learnings

### 1. SDK Timeout Issues - NEVER Use Blocking `prompt()` for Long Operations

**Problem:** The OpenCode SDK's `client.session.prompt()` is a blocking call with a ~90 second timeout. Slower models like Claude Opus 4.5 can exceed this timeout, causing silent failures.

**Solution:** Always use `promptAsync()` + polling for any LLM calls:

```typescript
// WRONG - will timeout with slow models
await client.session.prompt({ path: { id }, body: { parts: [...] } })

// CORRECT - non-blocking with polling
await client.session.promptAsync({ path: { id }, body: { parts: [...] } })
const response = await waitForResponse(id, TIMEOUT_MS) // poll for completion
```

**Key constants:**
- `JUDGE_RESPONSE_TIMEOUT = 180_000` (3 minutes for Opus 4.5)
- `POLL_INTERVAL = 2_000` (2 seconds between polls)

### 2. Tests Must Fail, Never Skip

**Rule:** Tests must fail on LLM errors, not silently skip. Silent skips hide real bugs.

```typescript
// WRONG - hides failures
if (!result.success && result.error?.includes("LLM")) {
    console.log(`[Test] SKIPPED: ${result.error}`)
    return // BUG: Test appears to pass!
}

// CORRECT - fails loudly
assert.ok(result.success, `Session did not complete: ${result.error}`)
```

**Action items when modifying LLM-related code:**
1. Run E2E tests with `OPENCODE_E2E=1 npm run test:e2e`
2. Tests MUST fail if LLM times out or errors
3. Test manually with the actual model (Opus 4.5) before committing
4. Ensure test timeout (120s) accommodates model response time + polling

### 3. Preserve Async Polling Patterns

**History:** Commit 67016b8 added polling (60s). Commit 6d57db0 accidentally removed it during refactoring, assuming `prompt()` returns synchronously. This broke Opus 4.5 support.

**Rule:** When refactoring, preserve these async patterns:
- `waitForJudgeResponse()` - polls for judge completion
- `waitForSessionIdle()` - polls for session completion
- `shouldSkipSession()` - checks session state before reflection

### 4. Infinite Loop Prevention Layers

The plugin has 5 defense layers against infinite reflection loops. Do not remove any:

1. `judgeSessions.has()` - fast path for known judge sessions
2. `reflectingSessions.has()` - blocks concurrent reflection on same session
3. `shouldSkipSession("empty")` - catches newly created sessions
4. `shouldSkipSession("judge")` - catches judge sessions by content analysis
5. `extractInitialTask()` null check - final defense before reflection runs

### 5. Judge Session Lifecycle

```
1. Create judge session → immediately add to judgeSessions set
2. Send prompt with promptAsync → non-blocking
3. Poll for response → waitForJudgeResponse()
4. Process verdict
5. Cleanup in finally block → remove from judgeSessions set
```

## Testing Checklist

**CRITICAL: ALWAYS run E2E tests after ANY code changes to reflection.ts. No exceptions.**

Before committing changes to reflection logic:

- [ ] `npm run typecheck` passes
- [ ] Unit tests pass: `npm test`
- [ ] **E2E tests MUST ALWAYS run: `OPENCODE_E2E=1 npm run test:e2e`**
- [ ] **E2E tests MUST pass - if they fail, you MUST fix the code immediately**
- [ ] **NEVER skip E2E tests - they are CRITICAL to verify the plugin works**
- [ ] Check E2E logs for "SKIPPED" (hidden failures)
- [ ] Verify no "Already reflecting" spam in logs
- [ ] Verify judge sessions are properly skipped

**E2E Test Requirements:**
- E2E tests use the model specified in `~/.config/opencode/opencode.json`
- Ensure the configured model has a valid API key before running E2E tests
- `opencode serve` does NOT support `--model` flag - it reads from config file
- If E2E test shows `messages: 0` and timeouts, check:
  1. Is the configured model valid? (`cat ~/.config/opencode/opencode.json`)
  2. Do you have the API key for that provider?
  3. Can you run `opencode run "test"` successfully with the same model?
- If E2E tests fail due to missing API keys, temporarily update the config to use an available model
- If E2E tests fail for reasons OTHER than API/model config, the plugin is BROKEN

**Why E2E tests are CRITICAL:**
- Unit tests only validate isolated logic, NOT the full plugin integration
- The plugin interacts with OpenCode SDK APIs that can break silently
- E2E tests catch breaking changes that unit tests miss
- If E2E tests fail, the plugin is BROKEN in production
- E2E test failures mean you broke something - FIX IT

## Architecture

```
┌─────────────────┐
│  User Session   │
│  (session.idle) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ shouldSkipSession│ ─── skip if judge/empty
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  runReflection  │
│  (async + poll) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Judge Session  │ ─── tracked in judgeSessions set
│  (promptAsync)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ waitForJudge    │ ─── polls up to 3 minutes
│ Response        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Parse Verdict  │
│  PASS or FAIL   │
└─────────────────┘
```
