# agent--claude-smith

[![CI](https://github.com/organvm-iv-taxis/agent--claude-smith/actions/workflows/ci.yml/badge.svg)](https://github.com/organvm-iv-taxis/agent--claude-smith/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-pending-lightgrey)](https://github.com/organvm-iv-taxis/agent--claude-smith)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/organvm-iv-taxis/agent--claude-smith/blob/main/LICENSE)
[![Organ IV](https://img.shields.io/badge/Organ-IV%20Taxis-10B981)](https://github.com/organvm-iv-taxis)
[![Status](https://img.shields.io/badge/status-active-brightgreen)](https://github.com/organvm-iv-taxis/agent--claude-smith)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-informational)](https://github.com/organvm-iv-taxis/agent--claude-smith)


[![ORGAN-IV: Taxis](https://img.shields.io/badge/ORGAN--IV-Taxis-e65100?style=flat-square)](https://github.com/organvm-iv-taxis)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Claude SDK](https://img.shields.io/badge/Claude_SDK-0.39-7C3AED?style=flat-square)](https://github.com/anthropics/anthropic-sdk-typescript)

**Multi-agent orchestration system built on the Claude Agent SDK.** Spawns, coordinates, and supervises specialized AI agents with session persistence, self-correction hooks, 1Password secrets management, and chezmoi-driven configuration templates. Part of [ORGAN-IV (Taxis)](https://github.com/organvm-iv-taxis) — the orchestration and governance layer of the eight-organ creative-institutional system.

---

## Table of Contents

- [Product Overview](#product-overview)
- [Why Claude Smith](#why-claude-smith)
- [Architecture](#architecture)
  - [Core Flow](#core-flow)
  - [Component Map](#component-map)
  - [Agent Registry and Spawn Model](#agent-registry-and-spawn-model)
  - [Session Lifecycle](#session-lifecycle)
  - [Security Layer](#security-layer)
  - [Self-Correction Hooks](#self-correction-hooks)
  - [Secrets Management](#secrets-management)
  - [chezmoi Configuration Templates](#chezmoi-configuration-templates)
- [Built-in Agents](#built-in-agents)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [CLI Usage](#cli-usage)
  - [Library Usage](#library-usage)
- [Configuration](#configuration)
- [Cross-Organ Position](#cross-organ-position)
- [Relationship to agentic-titan](#relationship-to-agentic-titan)
- [Testing](#testing)
- [Related Work](#related-work)
- [Contributing](#contributing)
- [License](#license)

---

## Product Overview

Software systems that rely on a single monolithic AI agent hit a ceiling: the agent accumulates context until it degrades, it cannot parallelize distinct concerns, and a failure in one subtask can poison the entire session. **agent--claude-smith** solves this by decomposing AI-assisted work into a _multi-agent orchestration_ pattern where a central `Orchestrator` spawns purpose-built subagents, each with its own session, tool permissions, retry budget, and security constraints.

The system ships four built-in agents — a code reviewer, a task executor, a security auditor, and an AI bridge for external service integration — but the real power lies in the extensible registry and the chezmoi-based configuration templating that lets operators define new agents as TOML templates rendered per-machine. Agents are spawned, supervised, paused, resumed, cancelled, and garbage-collected through a unified session management layer backed by atomic file persistence.

The name references a deliberate inversion: rather than one "Agent Smith" replicating endlessly without governance, Claude Smith is an _orchestrated_ agent system where every spawn is registered, permission-checked, cycle-validated, and audit-logged. The orchestrator enforces acyclic spawn graphs, bounded concurrency, per-agent tool whitelists, and comprehensive command validation before any shell operation executes. This is governance-first AI orchestration.

## Why Claude Smith

Most multi-agent frameworks treat agents as interchangeable wrappers around a prompt. Claude Smith treats them as _governed processes_ with lifecycle management:

1. **Session persistence.** Every agent execution creates a session backed by atomic JSON writes. Sessions can be paused, resumed, or recovered after crashes. Conversation history, tool call records, and checkpoint data survive process restarts.

2. **Security-by-default.** A comprehensive command validator blocks 14 categories of dangerous shell patterns — destructive file operations, privilege escalation, fork bombs, reverse shells, encoded command execution, container escapes, and more. File write paths are validated against a deny-list covering `/etc`, `.ssh/authorized_keys`, shell init files, and credential stores. This is not a regex afterthought; it is a normalized pattern-matching engine that handles obfuscation via quotes, variable expansion, and pipeline splitting.

3. **Cycle-free spawn graphs.** The agent registry uses DFS to detect and prevent circular dependencies before any subagent is spawned. If agent A can spawn agent B, and agent B could spawn agent A, the system blocks the spawn and returns a structured error explaining the circular dependency.

4. **Self-correction.** Pre-tool-use hooks validate every operation against the agent's tool configuration and global security rules. Post-tool-use failure hooks implement exponential backoff with configurable retry budgets. The failure tracker uses an `ExpiringMap` (5-minute TTL, 1000-entry cap) to prevent unbounded memory growth, and the audit log uses a `CircularBuffer` (O(1) insertion, fixed capacity) for bounded observability.

5. **Secrets without .env files.** 1Password SDK integration resolves `op://` references at agent startup. Required secrets fail fast; optional secrets fall back to environment variables. Secrets are redacted from any output that might contain them.

6. **Machine-specific configuration.** chezmoi templates let you define agent configurations as `.toml.tmpl` files that render differently per machine — different tools, different paths, different secret vaults depending on whether you are on macOS, Linux, WSL, Docker, or CI.

---

## Architecture

### Core Flow

When `spawnAgent()` is called on the `Orchestrator`, the following sequence executes:

```
1. Look up agent definition in AgentRegistry (Zod-validated)
2. Resolve secrets via SecretResolver (1Password SDK or env fallback)
3. Create or resume SessionState via SessionManager
4. Set up AbortController for timeout enforcement
5. Execute via Anthropic Messages API with agent's system prompt
6. Track via SelfCorrectionHooks for safety and audit logging
7. Persist result and complete/fail session
```

For parallel execution, `spawnParallel()` maintains result ordering matching the input request array regardless of completion order, using pre-allocated result slots with index tracking and configurable concurrency limits.

### Component Map

```
src/
├── index.ts                     # Entry point, CLI, factory (createOrchestrator)
├── core/
│   ├── orchestrator.ts          # Central coordinator: spawn, parallel, resume, cancel
│   ├── agent-registry.ts        # Agent definitions, cycle detection (DFS), spawn validation
│   └── session-manager.ts       # Session lifecycle: create/pause/resume/complete/fail
├── agents/
│   ├── types.ts                 # Zod schemas: ExtendedAgentDefinition, AgentSpawnRequest, SessionState
│   ├── code-reviewer.ts         # Built-in: read-only code analysis
│   ├── task-executor.ts         # Built-in: read/write/execute with subagent spawning
│   ├── security-auditor.ts      # Built-in: security-focused analysis with restricted Bash
│   └── ai-bridge.ts             # Built-in: external AI service integration
├── config/
│   ├── chezmoi-manager.ts       # chezmoi template rendering, environment detection
│   ├── environment.ts           # Runtime environment configuration
│   └── types.ts                 # Config types: RawAgentConfig, ChezmoiData, EnvironmentInfo
├── hooks/
│   ├── self-correction.ts       # Pre/post tool-use hooks, audit log (CircularBuffer)
│   └── retry-handler.ts         # Exponential backoff with configurable retry budgets
├── persistence/
│   └── session-store.ts         # Atomic file I/O with KeyedMutex for concurrent safety
├── secrets/
│   ├── one-password.ts          # 1Password SDK client wrapper
│   └── secret-resolver.ts       # Secret resolution: 1Password → env fallback → error
├── security/
│   └── command-validator.ts     # 14-category command validation + path deny-list
├── utils/
│   ├── circular-buffer.ts       # O(1) bounded buffer + ExpiringMap
│   ├── safe-json.ts             # Schema-validated JSON parsing
│   └── singleton.ts             # Factory/reset pattern for testability
└── templates/
    └── agent-configs/
        ├── code-reviewer.toml.tmpl   # chezmoi template for code reviewer
        └── task-executor.toml.tmpl   # chezmoi template for task executor
```

### Agent Registry and Spawn Model

Every agent is a fully typed `ExtendedAgentDefinition` validated at registration time by a Zod schema. Definitions include:

| Field | Purpose |
|-------|---------|
| `id` | Lowercase alphanumeric + hyphens (e.g., `code-reviewer`) |
| `category` | One of: `code-analysis`, `task-execution`, `security`, `integration`, `orchestration` |
| `capabilities` | Subset of: `read-files`, `write-files`, `execute-commands`, `network-access`, `spawn-subagents`, `external-api` |
| `systemPrompt` | Agent's identity and instruction set |
| `tools` | Per-tool enable/disable with optional path and command restrictions |
| `retryConfig` | Max attempts, backoff multiplier, retryable error types |
| `secretRefs` | Named 1Password references with required/optional flags |
| `canSpawnSubagents` | Whether this agent may create child agents |
| `allowedSubagents` | Explicit whitelist of spawnable agent IDs |
| `maxTurns` | Hard limit on conversation turns |
| `maxExecutionTimeMs` | Timeout enforced via `AbortController` |

The registry provides `validateSpawn(parentId, childId)` which checks three conditions: (1) the parent agent exists and has `canSpawnSubagents: true`, (2) the child agent is in the parent's `allowedSubagents` list (or all agents are allowed if the list is empty), and (3) spawning would not create a cycle detected via DFS graph traversal through the `allowedSubagents` edges.

### Session Lifecycle

Sessions follow a state machine:

```
                 ┌──────────────────┐
                 │                  │
    ┌────────────▼──────────┐      │
    │       running         │      │
    └──┬──────┬──────┬──────┘      │
       │      │      │             │
       ▼      ▼      ▼             │
  completed  failed  paused ───────┘
                      │
                      ▼
                   cancelled
```

Each session persists as a JSON file in `.sessions/` with:
- Full conversation history (messages with turn numbers)
- Checkpoint data for mid-execution resumption
- Tool call records with timing and error information
- Error state with recovery classification (`recoverable: boolean`)
- Parent/child session relationships for subagent tracking

The `SessionStore` uses a `KeyedMutex` for per-session locking and atomic writes (write to temp file, then `rename`) to prevent corruption from concurrent access or process crashes.

### Security Layer

The command validator in `src/security/command-validator.ts` normalizes input (collapsing whitespace, removing quotes, expanding common variable patterns like `$SUDO`, `$HOME`) and then checks against 14 categories of dangerous patterns:

| Category | Examples Blocked |
|----------|-----------------|
| Destructive files | `rm -rf /`, `shred`, `wipe` |
| Privilege escalation | `sudo`, `doas`, `pkexec`, setuid `chmod` |
| Filesystem damage | `mkfs`, `dd of=/dev/`, `fdisk` |
| Resource exhaustion | Fork bombs, `while true; do` |
| Remote code execution | `curl \| sh`, `eval $()`, `source <()` |
| Reverse shells | `nc -e /bin/sh`, `bash -i /dev/tcp/` |
| Scheduled execution | `crontab`, `at`, `batch` |
| System modification | Writes to `/etc/`, `/boot/`, `/sys/`, `systemctl enable` |
| SSH manipulation | Writes to `authorized_keys`, `id_rsa` |
| Shell init modification | Writes to `.bashrc`, `.zshrc`, `.profile` |
| History manipulation | `history -c`, `unset HISTFILE`, `export HISTSIZE=0` |
| Encoded execution | `base64 -d \| sh`, hex escape sequences piped to shell |
| Container escape | `docker run --privileged`, `nsenter` |
| Dangerous network | SSH reverse tunnels, `socat exec:`, `nmap` |

File write validation covers the filesystem deny-list (`/etc`, `/boot`, `/sys`, `/proc`, `/dev`, `/root`, `~/.ssh`, shell init files, credential files) plus per-agent path whitelists.

Session IDs are UUID-validated to prevent path traversal attacks against the session store.

### Self-Correction Hooks

The `SelfCorrectionHooks` class implements three hook points:

- **`preToolUse`** — Called before every tool invocation. Checks that the tool is enabled for the agent, validates Bash commands against the security layer, validates Write/Edit paths against both the global deny-list and the agent's `allowedPaths`. Returns `{ allow, blockReason }`.

- **`postToolUse`** — Called after successful tool invocations. Logs the operation to the circular audit buffer and resets the failure counter for that tool.

- **`postToolUseFailure`** — Called after tool failures. Increments the failure counter in the `ExpiringMap`, suggests alternative actions based on error type (`ENOENT` suggests using `Glob` first; `EACCES` suggests checking allowed directories; `429` rate-limits suggest waiting), and calculates exponential backoff delay for retries.

The audit log is a `CircularBuffer<AuditLogEntry>` with a default capacity of 1,000 entries and O(1) insertion that overwrites the oldest entries when full. The failure tracker is an `ExpiringMap<string, number>` with a 5-minute TTL and 1,000-entry maximum to prevent memory leaks across long-running sessions.

### Secrets Management

The `SecretResolver` follows a resolution chain:

1. If 1Password is configured (`OP_SERVICE_ACCOUNT_TOKEN` is set), resolve `op://vault/item/field` references via the `@1password/sdk`.
2. For required secrets that fail 1Password resolution: throw immediately.
3. For optional secrets that fail 1Password resolution: fall back to environment variables with the same name.
4. If 1Password is not configured at all: resolve everything from environment variables, throwing for missing required secrets.

The resolver also provides `containsSecrets(text, secrets)` and `redactSecrets(text, secrets)` utilities for sanitizing output before logging or display.

### chezmoi Configuration Templates

Agent configurations can be defined as TOML templates in a `templates/agent-configs/` directory. The `ChezmoiManager` renders these templates using `chezmoi execute-template` (piped via stdin), incorporating machine-specific data (OS, architecture, hostname, username, home directory) so that the same agent definition can resolve to different tool permissions, path restrictions, or secret vaults depending on the deployment environment.

When chezmoi is not available (e.g., in CI), the manager falls back to basic template rendering that strips Go template directives.

Environment detection identifies: `macos`, `linux`, `windows`, `docker`, `wsl`, and `CI` (GitHub Actions, GitLab CI).

---

## Built-in Agents

| Agent ID | Category | Capabilities | Spawns Subagents | Max Turns | Timeout |
|----------|----------|-------------|------------------|-----------|---------|
| `code-reviewer` | `code-analysis` | `read-files` | No | 20 | 5 min |
| `task-executor` | `task-execution` | `read-files`, `write-files`, `execute-commands` | Yes (`code-reviewer`, `security-auditor`) | 50 | 10 min |
| `security-auditor` | `security` | `read-files`, `execute-commands` | No | 30 | 10 min |
| `ai-bridge` | `integration` | `network-access`, `external-api` | No | 20 | 5 min |

**Code Reviewer** — Read-only agent that analyzes code for bugs, security vulnerabilities, design issues, and style violations. Prioritizes findings by severity (critical/high/medium/low) with line references and fix suggestions. Tools: `Read`, `Glob`, `Grep`.

**Task Executor** — Full-capability development agent with read/write/execute permissions. Can spawn `code-reviewer` and `security-auditor` as subagents for validation. Bash commands are filtered through the security validator with additional per-agent blocklist. This is the only built-in agent with subagent spawning enabled.

**Security Auditor** — OWASP-focused security analysis agent. Has restricted Bash access (blocked: `rm`, `mv`, `cp`, `chmod`, `chown`, `sudo`, `curl`, `wget`, `nc`, `ssh`) to prevent the security auditor itself from becoming an attack vector. Outputs CVSS-scored findings with remediation steps. Optionally integrates with Snyk via `SNYK_TOKEN`.

**AI Bridge** — External API integration agent with `WebFetch` access. Designed for multi-model workflows: embeddings generation, image generation APIs, speech processing, and specialized model inference. Aggressive retry config (5 attempts, 2s initial delay, handles `429`, `503`, `502`). Optionally integrates with OpenAI and HuggingFace.

---

## Installation

### Prerequisites

- **Node.js** >= 20.0.0
- **npm** (ships with Node.js)
- An **Anthropic API key** ([console.anthropic.com](https://console.anthropic.com/))
- _(Optional)_ 1Password CLI + service account for secrets management
- _(Optional)_ chezmoi for machine-specific agent configuration templates

### Setup

```bash
# Clone the repository
git clone https://github.com/organvm-iv-taxis/agent--claude-smith.git
cd agent--claude-smith

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Type-check to verify setup
npm run typecheck

# Run tests to verify everything works
npm test
```

### Build

```bash
npm run build          # Compile TypeScript to dist/
npm run clean          # Remove dist/
```

---

## Quick Start

### CLI Usage

```bash
# Run a code review on a directory
npx tsx src/index.ts --agent code-reviewer --prompt "Review src/security/ for vulnerabilities"

# Run a task executor
npx tsx src/index.ts -a task-executor -p "Add input validation to the user registration handler"

# Run multiple agents in parallel
npx tsx src/index.ts --parallel code-reviewer,security-auditor -p "Analyze the authentication module"

# List all registered agents
npx tsx src/index.ts --list

# Resume a paused session
npx tsx src/index.ts --resume <session-id>

# Clean up old completed sessions
npx tsx src/index.ts --cleanup
```

### Library Usage

```typescript
import { createOrchestrator } from 'agent--claude-smith';
import type { ExtendedAgentDefinition } from 'agent--claude-smith';

// Create an orchestrator with defaults
const orchestrator = await createOrchestrator({
  registerBuiltins: true,
  templatesPath: './templates/agent-configs',
});

// Spawn a single agent
const result = await orchestrator.spawnAgent({
  agentId: 'code-reviewer',
  prompt: 'Review src/auth/ for security issues',
  workingDirectory: '/path/to/project',
});

console.log(result.status);        // 'success' | 'error' | 'timeout'
console.log(result.result);        // Agent's response text
console.log(result.turnsTaken);    // Number of conversation turns
console.log(result.executionTimeMs); // Wall-clock execution time

// Spawn agents in parallel with bounded concurrency
const results = await orchestrator.spawnParallel([
  { agentId: 'code-reviewer', prompt: 'Review code quality' },
  { agentId: 'security-auditor', prompt: 'Check for vulnerabilities' },
], { maxConcurrent: 3 });

// Results array matches input order regardless of completion order
results.forEach((r, i) => {
  console.log(`Agent ${r.agentId}: ${r.status}`);
});

// Register a custom agent
orchestrator.getRegistry().register({
  id: 'documentation-writer',
  name: 'Documentation Writer',
  description: 'Generates technical documentation',
  category: 'task-execution',
  capabilities: ['read-files', 'write-files'],
  systemPrompt: 'You are a technical writer...',
  tools: [
    { name: 'Read', enabled: true },
    { name: 'Write', enabled: true },
    { name: 'Glob', enabled: true },
  ],
  retryConfig: {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    retryableErrors: ['RATE_LIMIT', 'TIMEOUT'],
  },
  secretRefs: [{
    name: 'ANTHROPIC_API_KEY',
    ref: 'op://Development/anthropic/api-key',
    required: true,
  }],
  maxExecutionTimeMs: 300000,
  maxTurns: 20,
  canSpawnSubagents: false,
});

// Inspect audit log
const auditEntries = orchestrator.getAuditLog();
console.log(`Audit log: ${auditEntries.length} entries`);

// Graceful shutdown
const shutdownResult = await orchestrator.shutdown();
console.log(
  `Shutdown: ${shutdownResult.agentsCancelled} agents cancelled, ` +
  `${shutdownResult.sessionResult.sessionsSaved} sessions saved`
);
```

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `OP_SERVICE_ACCOUNT_TOKEN` | No | 1Password service account token for secret resolution |
| `CLAUDE_AGENT_TEMPLATES` | No | Path to chezmoi agent config templates directory |
| `OPENAI_API_KEY` | No | For AI Bridge agent (OpenAI integration) |
| `HUGGINGFACE_TOKEN` | No | For AI Bridge agent (HuggingFace integration) |
| `SNYK_TOKEN` | No | For Security Auditor agent (dependency scanning) |

### Orchestrator Config

```typescript
const orchestrator = await createOrchestrator({
  config: {
    maxConcurrentAgents: 5,           // Max parallel agent executions
    defaultWorkingDirectory: '.',      // Default cwd for agents
    sessionStoragePath: './.sessions', // Session persistence directory
    defaultModel: 'claude-sonnet-4-20250514', // Default Claude model
    enableSelfCorrection: true,        // Enable pre/post tool-use hooks
    enableAuditLogging: true,          // Enable audit log
  },
  registerBuiltins: true,             // Register 4 built-in agents
  templatesPath: './templates',        // chezmoi templates directory
  onAuditEntry: (entry) => {          // Custom audit log handler
    console.log(`[AUDIT] ${entry.event}: ${entry.toolName}`);
  },
});
```

### Agent Configuration via TOML Templates

Create agent definitions as `.toml.tmpl` files in the templates directory:

```toml
# templates/agent-configs/my-agent.toml.tmpl
id = "my-custom-agent"
name = "My Custom Agent"
description = "Does specialized work"
category = "task-execution"
capabilities = ["read-files", "write-files"]
systemPrompt = "You are a specialized agent..."
maxExecutionTimeMs = 300000
maxTurns = 25
canSpawnSubagents = false

[[tools]]
name = "Read"
enabled = true

[[tools]]
name = "Write"
enabled = true
```

---

## Cross-Organ Position

Within the eight-organ system, `agent--claude-smith` occupies a specific position in the ORGAN-IV (Taxis) governance layer:

| Organ | Relationship |
|-------|-------------|
| **ORGAN-I (Theoria)** | Consumes theoretical frameworks on recursion and self-reference. The self-correction hooks, cycle detection, and bounded-memory patterns embody ORGAN-I epistemological principles about systems that observe and correct themselves. |
| **ORGAN-II (Poiesis)** | No direct dependency. ORGAN-IV enforces the one-way flow: I -> II -> III. |
| **ORGAN-III (Ergon)** | Orchestrates work _for_ ORGAN-III product repositories. The task executor agent can review, modify, and validate code across ORGAN-III SaaS/B2B/B2C repos. |
| **ORGAN-IV (Taxis)** | Sibling to [agentic-titan](https://github.com/organvm-iv-taxis/agentic-titan) and other orchestration tools. Claude Smith handles multi-agent coordination; agentic-titan handles cross-organ governance routing. |
| **ORGAN-V (Logos)** | The AI-conductor model documented in ORGAN-V public-process essays describes the pattern this tool implements: human directs, AI generates, human refines. |
| **ORGAN-VII (Kerygma)** | No direct dependency. Marketing outputs consume orchestration metadata. |

The dependency flow respects the system invariant: **no back-edges**. ORGAN-IV orchestrates downstream organs (III) but never depends on them. Configuration and theory flow from ORGAN-I into the patterns used here, but there is no runtime coupling.

## Relationship to agentic-titan

[agentic-titan](https://github.com/organvm-iv-taxis/agentic-titan) is the **flagship** ORGAN-IV repository — the high-level governance and routing layer that coordinates work across all eight organs. `agent--claude-smith` is a **sibling** that operates one layer down: where agentic-titan decides _what_ work needs to happen and _which organ_ handles it, Claude Smith decides _how_ that work gets decomposed into agents, executed with safety constraints, and supervised to completion.

In practice:
- **agentic-titan** = inter-organ routing and governance policy
- **agent--claude-smith** = intra-task agent spawning and execution safety

They are complementary. An agentic-titan workflow might delegate a code-quality task to Claude Smith, which then spawns a `code-reviewer` and a `security-auditor` in parallel, aggregates their results, and returns a structured report to agentic-titan for cross-organ routing.

---

## Testing

```bash
# Run all tests
npm test

# Watch mode (re-run on file changes)
npm run test:watch

# Coverage report
npm run test:coverage

# Security tests only
npm run test:security

# Run specific test directory
npx vitest run tests/unit/core

# Run tests matching a pattern
npx vitest run -t "spawnAgent"
```

The test suite covers:

- **Core orchestrator** — Agent spawning, parallel execution with order preservation, session resumption, shutdown error collection
- **Session persistence** — Atomic writes, concurrent access via KeyedMutex, session lifecycle transitions, cleanup
- **Security** — Command injection detection across all 14 categories, path traversal prevention, session ID validation
- **Self-correction** — Pre/post hooks, failure tracking, audit log bounds (CircularBuffer), ExpiringMap TTL behavior
- **Secrets** — 1Password resolution, env fallback, required vs. optional handling, redaction
- **Utilities** — CircularBuffer capacity, singleton pattern reset, safe JSON parsing

All core services use factory functions with explicit `reset*()` functions. Tests call these in `beforeEach` to ensure isolation.

---

## Related Work

- [Claude Agent SDK](https://github.com/anthropics/anthropic-sdk-typescript) — The underlying Anthropic SDK this project builds on
- [1Password SDK](https://developer.1password.com/docs/sdks/) — Secrets management integration
- [chezmoi](https://www.chezmoi.io/) — Cross-machine dotfile/config management used for agent templates
- [Zod](https://zod.dev/) — Runtime type validation for all agent definitions and requests
- [Vitest](https://vitest.dev/) — Test framework

---

## Contributing

This repository is part of the [organvm-iv-taxis](https://github.com/organvm-iv-taxis) organization. Contributions should follow the repository standards defined in the meta-organvm governance documentation.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Run type checks (`npm run typecheck`) and tests (`npm test`) before committing
4. Write tests for new functionality
5. Submit a pull request with a clear description of changes

### Development Workflow

```bash
npm run dev              # Watch mode with tsx (auto-restart on changes)
npm run typecheck        # Type-check without emitting (run before commits)
npm test                 # Full test suite
npm run test:security    # Security-focused tests (run after modifying command-validator)
```

---

## License

[MIT](./LICENSE)

---

## Author

**[@4444j99](https://github.com/4444J99)** — ORGAN-IV maintainer

Part of the [organvm](https://github.com/meta-organvm) eight-organ creative-institutional system.

<!-- SYSTEM-NAV-START -->

---

<sub>[Portfolio](https://4444j99.github.io/portfolio/) · [System Directory](https://4444j99.github.io/portfolio/directory/) · [ORGAN IV · Taxis](https://organvm-iv-taxis.github.io/) · Part of the <a href="https://4444j99.github.io/portfolio/directory/">ORGANVM eight-organ system</a></sub>

<!-- SYSTEM-NAV-END -->
