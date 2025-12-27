# Testing the Reflection Plugin

## Plugin Locations

OpenCode loads plugins from:
- **Global:** `~/.config/opencode/plugin/` (affects all projects)
- **Project:** `<project>/.opencode/plugin/` (project-specific)

## E2E Test Directories

The E2E tests use two temp directories:
- `/tmp/opencode-e2e-python` (port 3200)
- `/tmp/opencode-e2e-nodejs` (port 3201)

## File Tree Before Agent Runs

After `setupProject()` but before sending tasks:

```
/tmp/opencode-e2e-python/
└── .opencode/
    └── plugin/
        └── reflection.ts   # Copied from project root

/tmp/opencode-e2e-nodejs/
└── .opencode/
    └── plugin/
        └── reflection.ts   # Copied from project root
```

## File Tree After Agent Runs

After agent completes tasks:

```
/tmp/opencode-e2e-python/
├── .opencode/
│   └── plugin/
│       └── reflection.ts
├── hello.py
└── test_hello.py

/tmp/opencode-e2e-nodejs/
├── .opencode/
│   └── plugin/
│       └── reflection.ts
├── hello.js
└── hello.test.js
```

## How to Install

```bash
# Install globally (affects all projects)
npm run install:global

# Or install to a specific project
mkdir -p /path/to/project/.opencode/plugin
cp reflection.ts /path/to/project/.opencode/plugin/
```

## How to Run Tests

```bash
npm install
npm run test:e2e
```

## E2E Test Flow

1. Deletes `/tmp/opencode-e2e-*` directories
2. Creates fresh directories with plugin copied to `.opencode/plugin/`
3. Starts `opencode serve` on ports 3200 and 3201
4. Creates sessions via SDK and sends coding tasks
5. Plugin triggers on `session.idle` events
6. Judge session evaluates task completion
7. Sends feedback if incomplete (max 3 attempts)
