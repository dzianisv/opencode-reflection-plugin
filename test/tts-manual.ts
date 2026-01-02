/**
 * Manual TTS Test - Actually speaks text to verify TTS works
 * 
 * Run with: npm run test:tts:manual
 */

import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

const MAX_SPEECH_LENGTH = 1000

function cleanTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "code block omitted")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#]+/g, "")
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/\/[\w./-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

async function speak(text: string): Promise<void> {
  const cleaned = cleanTextForSpeech(text)
  if (!cleaned) return

  const toSpeak = cleaned.length > MAX_SPEECH_LENGTH
    ? cleaned.slice(0, MAX_SPEECH_LENGTH) + "... message truncated."
    : cleaned

  const escaped = toSpeak.replace(/'/g, "'\\''")

  try {
    console.log(`[TTS] Speaking: "${toSpeak.slice(0, 100)}..."`)
    await execAsync(`say -r 200 '${escaped}'`)
    console.log("[TTS] Done speaking")
  } catch (error) {
    console.error("[TTS] Failed to speak:", error)
  }
}

// Test cases
const testCases = [
  {
    name: "Simple text",
    input: "Hello! The TTS plugin is working correctly."
  },
  {
    name: "With code block",
    input: `I've created a function for you:
\`\`\`typescript
function greet(name: string) {
  return "Hello " + name;
}
\`\`\`
The function takes a name and returns a greeting.`
  },
  {
    name: "With markdown",
    input: "Here's the **important** information: the task is *complete* and all tests pass."
  },
  {
    name: "With URL and path",
    input: "Check the file /Users/test/project/src/index.ts and visit https://github.com/sst/opencode for docs."
  }
]

async function main() {
  console.log("=== TTS Manual Test ===\n")
  
  // Check if say command exists
  try {
    await execAsync("which say")
  } catch {
    console.error("ERROR: 'say' command not found. This test requires macOS.")
    process.exit(1)
  }

  for (const test of testCases) {
    console.log(`\n--- Test: ${test.name} ---`)
    console.log(`Input: ${test.input.slice(0, 80)}...`)
    console.log(`Cleaned: ${cleanTextForSpeech(test.input).slice(0, 80)}...`)
    await speak(test.input)
    
    // Small pause between tests
    await new Promise(r => setTimeout(r, 500))
  }

  console.log("\n=== All tests complete ===")
}

main()
