# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-agent orchestration system built with the Claude Agent SDK. Provides subagent spawning, parallel execution, session persistence, self-correction with automatic retry, 1Password secrets management, and chezmoi configuration templates.

## Development Commands

```bash
# Type check (run before committing)
npm run typecheck

# Build
npm run build

# Run tests
npm test                           # Run all tests
npm run test:watch                 # Watch mode
npm run test:coverage              # With coverage report
npm run test:security              # Security tests only
npx vitest run tests/unit/core     # Run tests in specific directory
npx vitest run -t "spawnAgent"     # Run tests matching pattern

# Development
npm run dev                        # Watch mode with tsx
npm start                          # Run directly
```

## Architecture

### Core Flow

`Orchestrator` is the main entry point. It coordinates:
- `AgentRegistry` - stores agent definitions by ID
- `SessionManager` / `SessionStore` - persists session state to disk
- `SecretResolver` - resolves `op://` references via 1Password
- `SelfCorrectionHooks` - validates tool calls, blocks dangerous operations, tracks failures

When `spawnAgent()` is called:
1. Look up agent definition in registry
2. Resolve secrets via SecretResolver
3. Create/resume session via SessionManager
4. Execute via Anthropic API
5. Track via hooks for safety and audit logging

### Singleton Pattern

All core services use a factory pattern with explicit reset functions for testing:

```typescript
// Factory with default singleton
export function getOrchestrator(options?: Options): Orchestrator {
  if (!defaultOrchestrator) {
    defaultOrchestrator = new Orchestrator(options);
  }
  return defaultOrchestrator;
}

// Reset for testing
export function resetOrchestrator(): void {
  defaultOrchestrator = null;
}
```

This pattern appears in: `orchestrator.ts`, `agent-registry.ts`, `session-manager.ts`, `secret-resolver.ts`, `self-correction.ts`, `session-store.ts`.

**Important for tests**: Call all `reset*()` functions in `beforeEach` to ensure test isolation.

### Security Layer

`src/security/command-validator.ts` provides:
- `validateCommand(cmd)` - blocks dangerous shell commands (rm -rf, sudo, fork bombs, reverse shells, etc.)
- `validateWritePath(path)` - blocks writes to sensitive paths (/etc, ~/.ssh, shell rc files)
- `validateSessionId(id)` - prevents path traversal in session IDs

The `SelfCorrectionHooks` class uses these validators in `preToolUse()` hooks.

### Session State

Sessions are stored as JSON files in `.sessions/` directory. The `SessionStore` handles:
- File I/O with `KeyedMutex` for concurrent access safety
- Atomic writes (write to temp, then rename)
- Path traversal prevention via session ID validation

### Type System

All types are defined in `src/agents/types.ts` with Zod schemas for runtime validation:
- `ExtendedAgentDefinition` / `ExtendedAgentDefinitionSchema`
- `AgentSpawnRequest` / `AgentSpawnRequestSchema`
- `SessionState`, `RetryConfig`, `HookContext`, etc.

## Key Implementation Details

### Parallel Execution

`spawnParallel()` maintains result order matching input request order, regardless of completion order. Uses pre-allocated result array with index tracking.

### Bounded Memory

- `CircularBuffer` for audit log (O(1) insertion, fixed size)
- `ExpiringMap` for failure tracking (entries expire after 5 min TTL)

### 1Password References

Secrets use format `op://<vault>/<item>/<field>`:
```typescript
secretRefs: [
  { name: 'ANTHROPIC_API_KEY', ref: 'op://Development/anthropic/api-key', required: true }
]
```

## Environment Variables

- `ANTHROPIC_API_KEY` - Claude API key
- `OP_SERVICE_ACCOUNT_TOKEN` - 1Password service account token
- `CLAUDE_AGENT_TEMPLATES` - Path to chezmoi agent config templates

## Test Structure

```
tests/
├── setup.ts                    # Global test setup
├── helpers/mock-anthropic.ts   # Mock Anthropic SDK
├── unit/                       # Unit tests mirror src/ structure
└── security/                   # Security-focused tests
```

Vitest globals are enabled (`describe`, `it`, `expect`, `vi` available without imports).

<!-- ORGANVM:AUTO:START -->
## System Context (auto-generated — do not edit)

**Organ:** ORGAN-IV (Orchestration) | **Tier:** standard | **Status:** CANDIDATE
**Org:** `organvm-iv-taxis` | **Repo:** `agent--claude-smith`

### Edges
- **Produces** → `organvm-iv-taxis/a-i--skills`: governance-policy
- **Consumes** ← `META-ORGANVM`: registry

### Siblings in Orchestration
`orchestration-start-here`, `petasum-super-petasum`, `universal-node-network`, `.github`, `agentic-titan`, `a-i--skills`

### Governance
- *Standard ORGANVM governance applies*

*Last synced: 2026-02-24T12:41:28Z*
<!-- ORGANVM:AUTO:END -->


## ⚡ Conductor OS Integration
This repository is a managed component of the ORGANVM meta-workspace.
- **Orchestration:** Use `conductor patch` for system status and work queue.
- **Lifecycle:** Follow the `FRAME -> SHAPE -> BUILD -> PROVE` workflow.
- **Governance:** Promotions are managed via `conductor wip promote`.
- **Intelligence:** Conductor MCP tools are available for routing and mission synthesis.
