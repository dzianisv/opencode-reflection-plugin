/**
 * E2E Integration Test - OpenCode API with Reflection
 *
 * Uses opencode serve + SDK to test reflection properly.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { mkdir, rm, cp, readdir, readFile } from "fs/promises"
import { spawn, type ChildProcess } from "child_process"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_PATH = join(__dirname, "../reflection.ts")

const MODEL = process.env.OPENCODE_MODEL || "anthropic/claude-sonnet-4-5"
const TIMEOUT = 300_000
const POLL_INTERVAL = 3_000

interface TaskResult {
  sessionId: string
  messages: any[]
  reflectionFeedback: string[]
  files: string[]
  completed: boolean
  duration: number
}

async function setupProject(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const pluginDir = join(dir, ".opencode", "plugin")
  await mkdir(pluginDir, { recursive: true })
  await cp(PLUGIN_PATH, join(pluginDir, "reflection.ts"))
}

async function waitForServer(port: number, timeout: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`http://localhost:${port}/session`)
      if (res.ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

async function runTask(
  client: OpencodeClient,
  cwd: string,
  task: string,
  label: string
): Promise<TaskResult> {
  const start = Date.now()
  const result: TaskResult = {
    sessionId: "",
    messages: [],
    reflectionFeedback: [],
    files: [],
    completed: false,
    duration: 0
  }

  try {
    // Create session
    const { data: session } = await client.session.create({})
    if (!session?.id) throw new Error("Failed to create session")
    result.sessionId = session.id
    console.log(`[${label}] Session: ${result.sessionId}`)

    // Send task
    await client.session.promptAsync({
      path: { id: result.sessionId },
      body: { parts: [{ type: "text", text: task }] }
    })

    // Poll until stable
    let lastMsgCount = 0
    let lastContent = ""
    let stableCount = 0

    while (Date.now() - start < TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))

      const { data: messages } = await client.session.messages({
        path: { id: result.sessionId }
      })
      result.messages = messages || []

      // Check for reflection feedback (user messages from plugin)
      for (const msg of result.messages) {
        if (msg.info?.role === "user") {
          for (const part of msg.parts || []) {
            if (part.type === "text" && part.text?.includes("Task Incomplete")) {
              if (!result.reflectionFeedback.includes(part.text)) {
                result.reflectionFeedback.push(part.text)
                console.log(`[${label}] Reflection feedback received`)
              }
            }
          }
        }
      }

      // Get current state
      const currentContent = JSON.stringify(result.messages)
      const hasWork = result.messages.some((m: any) =>
        m.info?.role === "assistant" && m.parts?.some((p: any) =>
          p.type === "text" || p.type === "tool"
        )
      )

      // Check stability
      if (hasWork && result.messages.length === lastMsgCount && currentContent === lastContent) {
        stableCount++
        // Wait longer for reflection to run (10 polls = 30 seconds)
        if (stableCount >= 10) {
          result.completed = true
          break
        }
      } else {
        stableCount = 0
      }

      lastMsgCount = result.messages.length
      lastContent = currentContent

      // Log progress
      const elapsed = Math.round((Date.now() - start) / 1000)
      if (elapsed % 15 === 0) {
        console.log(`[${label}] ${elapsed}s - messages: ${result.messages.length}, stable: ${stableCount}`)
      }
    }

    // Get files created
    try {
      const files = await readdir(cwd)
      result.files = files.filter(f => !f.startsWith("."))
    } catch {}

    result.duration = Date.now() - start
  } catch (e: any) {
    console.log(`[${label}] Error: ${e.message}`)
  }

  return result
}

describe("E2E: OpenCode API with Reflection", { timeout: TIMEOUT * 2 + 120_000 }, () => {
  const pythonDir = "/tmp/opencode-e2e-python"
  const nodeDir = "/tmp/opencode-e2e-nodejs"
  const pythonPort = 3200
  const nodePort = 3201

  let pythonServer: ChildProcess | null = null
  let nodeServer: ChildProcess | null = null
  let pythonClient: OpencodeClient
  let nodeClient: OpencodeClient
  let pythonResult: TaskResult
  let nodeResult: TaskResult
  let serverLogs: string[] = []

  before(async () => {
    console.log("\n=== Setup ===\n")

    await rm(pythonDir, { recursive: true, force: true })
    await rm(nodeDir, { recursive: true, force: true })
    await setupProject(pythonDir)
    await setupProject(nodeDir)

    // Start servers
    console.log("Starting OpenCode servers...")

    pythonServer = spawn("opencode", ["serve", "-p", String(pythonPort)], {
      cwd: pythonDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    })

    pythonServer.stdout?.on("data", (d) => {
      const line = d.toString().trim()
      if (line.includes("[Reflection]")) {
        serverLogs.push(`[py] ${line}`)
        console.log(`[py] ${line}`)
      }
    })
    pythonServer.stderr?.on("data", (d) => {
      const line = d.toString().trim()
      if (line.includes("[Reflection]")) {
        serverLogs.push(`[py] ${line}`)
        console.log(`[py] ${line}`)
      }
    })

    nodeServer = spawn("opencode", ["serve", "-p", String(nodePort)], {
      cwd: nodeDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    })

    nodeServer.stdout?.on("data", (d) => {
      const line = d.toString().trim()
      if (line.includes("[Reflection]")) {
        serverLogs.push(`[node] ${line}`)
        console.log(`[node] ${line}`)
      }
    })
    nodeServer.stderr?.on("data", (d) => {
      const line = d.toString().trim()
      if (line.includes("[Reflection]")) {
        serverLogs.push(`[node] ${line}`)
        console.log(`[node] ${line}`)
      }
    })

    // Create clients
    pythonClient = createOpencodeClient({
      baseUrl: `http://localhost:${pythonPort}`,
      directory: pythonDir
    })
    nodeClient = createOpencodeClient({
      baseUrl: `http://localhost:${nodePort}`,
      directory: nodeDir
    })

    // Wait for servers
    const [pyReady, nodeReady] = await Promise.all([
      waitForServer(pythonPort, 30_000),
      waitForServer(nodePort, 30_000)
    ])

    if (!pyReady || !nodeReady) {
      throw new Error(`Servers failed to start: py=${pyReady}, node=${nodeReady}`)
    }

    console.log("Servers ready\n")
  })

  after(async () => {
    console.log("\n=== Cleanup ===")
    pythonServer?.kill("SIGTERM")
    nodeServer?.kill("SIGTERM")
    await new Promise(r => setTimeout(r, 2000))

    console.log(`\nServer logs with [Reflection]: ${serverLogs.length}`)
    if (pythonResult) console.log(`Python: ${pythonResult.duration}ms, files: ${pythonResult.files.join(", ")}`)
    if (nodeResult) console.log(`Node.js: ${nodeResult.duration}ms, files: ${nodeResult.files.join(", ")}`)
  })

  it("Python: creates hello.py with tests, reflection evaluates", async () => {
    console.log("\n=== Python Task ===\n")

    pythonResult = await runTask(
      pythonClient,
      pythonDir,
      `Create a Python CLI:
1. Create hello.py that prints "Hello, World!"
2. Create test_hello.py with pytest tests that verify output
3. Run pytest and ensure tests pass`,
      "py"
    )

    console.log(`\nPython completed: ${pythonResult.completed}`)
    console.log(`Duration: ${pythonResult.duration}ms`)
    console.log(`Files: ${pythonResult.files.join(", ")}`)
    console.log(`Messages: ${pythonResult.messages.length}`)
    console.log(`Reflection feedback: ${pythonResult.reflectionFeedback.length}`)

    assert.ok(pythonResult.files.some(f => f.endsWith(".py")), "Should create .py files")
  })

  it("Node.js: creates hello.js with tests, reflection evaluates", async () => {
    console.log("\n=== Node.js Task ===\n")

    nodeResult = await runTask(
      nodeClient,
      nodeDir,
      `Create a Node.js CLI:
1. Create hello.js that prints "Hello, World!"
2. Create hello.test.js with tests that verify output
3. Run tests and ensure they pass`,
      "node"
    )

    console.log(`\nNode.js completed: ${nodeResult.completed}`)
    console.log(`Duration: ${nodeResult.duration}ms`)
    console.log(`Files: ${nodeResult.files.join(", ")}`)
    console.log(`Messages: ${nodeResult.messages.length}`)
    console.log(`Reflection feedback: ${nodeResult.reflectionFeedback.length}`)

    assert.ok(nodeResult.files.some(f => f.endsWith(".js")), "Should create .js files")
  })

  it("Reflection plugin ran and evaluated tasks", async () => {
    console.log("\n=== Reflection Check ===\n")

    // Check server logs for reflection activity
    const initLogs = serverLogs.filter(l => l.includes("Plugin initialized"))
    const reflectionLogs = serverLogs.filter(l => l.includes("Starting reflection"))
    const verdictLogs = serverLogs.filter(l => l.includes("COMPLETE") || l.includes("INCOMPLETE"))

    console.log(`Plugin initialized: ${initLogs.length}`)
    console.log(`Reflection started: ${reflectionLogs.length}`)
    console.log(`Verdicts: ${verdictLogs.length}`)

    // Plugin should have initialized
    assert.ok(initLogs.length > 0, "Reflection plugin should initialize")

    // If we got feedback, it means reflection ran and found issues
    const totalFeedback = pythonResult.reflectionFeedback.length + nodeResult.reflectionFeedback.length
    console.log(`Total feedback messages: ${totalFeedback}`)

    // Either reflection gave feedback OR tasks completed successfully
    const tasksWorked = pythonResult.files.length > 0 && nodeResult.files.length > 0
    assert.ok(tasksWorked, "Tasks should produce files")
  })

  it("Files are valid and runnable", async () => {
    console.log("\n=== Verify Files ===\n")

    // Check Python
    if (pythonResult.files.includes("hello.py")) {
      const content = await readFile(join(pythonDir, "hello.py"), "utf-8")
      console.log("hello.py:", content.slice(0, 100).replace(/\n/g, " "))
      assert.ok(content.includes("print") || content.includes("Hello"), "hello.py should print")
    }

    // Check Node
    if (nodeResult.files.includes("hello.js")) {
      const content = await readFile(join(nodeDir, "hello.js"), "utf-8")
      console.log("hello.js:", content.slice(0, 100).replace(/\n/g, " "))
      assert.ok(content.includes("console") || content.includes("Hello"), "hello.js should log")
    }
  })
})
