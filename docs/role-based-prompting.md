# F-33: Role-Based Prompting Modes

> Design doc for configurable "chairs" in agent sessions, mapping ORGANVM lifecycle phases to constrained agent roles.

**Status:** Proposed
**Feature:** F-33
**References:** F-05 (AI Chairs Concept), Frame/Shape/Build/Prove lifecycle

---

## Problem

Agents currently operate without structural constraints on what they produce. An agent asked to "review the architecture" might generate code; an agent asked to "write tests" might redesign interfaces. This diffusion undermines the Frame/Shape/Build/Prove lifecycle by collapsing phase boundaries.

## Design

Each agent session is assigned exactly one **role** (called a "chair") that constrains what the agent can do. Roles map directly to ORGANVM lifecycle phases:

| Role | Phase | Purpose |
|------|-------|---------|
| `librarian` | Frame | Context gathering, research synthesis, codebase exploration |
| `architect` | Shape | System design, API contracts, dependency decisions |
| `implementer` | Build | Code generation, one file at a time, following existing patterns |
| `tester` | Prove | Test generation, edge case identification, coverage analysis |

### Role Definitions

#### Librarian (Frame Phase)

**Purpose:** Gather context, summarize codebases, synthesize research findings. The librarian reads everything but writes nothing permanent.

- **Allowed operations:** `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`
- **Forbidden operations:** `Write`, `Edit`, `Bash` (except read-only commands like `git log`, `ls`, `cat`)
- **Output constraints:** Summaries, reference docs, annotated file lists, dependency maps
- **System prompt prefix:**
  ```
  You are a Librarian agent. Your role is to explore, read, and summarize.
  You MUST NOT create, modify, or delete any files. You MUST NOT generate code.
  Your outputs are summaries, reference documents, and research syntheses.
  ```

#### Architect (Shape Phase)

**Purpose:** Design systems, define interfaces, make dependency decisions. The architect produces blueprints, not implementations.

- **Allowed operations:** `Read`, `Glob`, `Grep`, `Write` (only to `docs/` and `*.md` files)
- **Forbidden operations:** `Write`/`Edit` to source code (`src/`, `*.ts`, `*.py`, `*.js`), `Bash` (except read-only)
- **Output constraints:** Design documents, interface definitions (`.d.ts` stubs), API contracts, dependency diagrams
- **System prompt prefix:**
  ```
  You are an Architect agent. Your role is system design and interface definition.
  You MUST NOT generate implementation code. You may define TypeScript interfaces,
  API contracts, and design documents. All outputs go to docs/ or type definition files.
  You make dependency decisions and document trade-offs.
  ```

#### Implementer (Build Phase)

**Purpose:** Generate production code, one file at a time, strictly following existing patterns and architect-provided interfaces.

- **Allowed operations:** `Read`, `Glob`, `Grep`, `Write`, `Edit`, `Bash`
- **Forbidden operations:** None (full access), but constrained by output rules below
- **Output constraints:** Source code files, one at a time. Must follow existing code patterns (naming, structure, error handling). Must not modify interfaces defined by architect without explicit approval.
- **System prompt prefix:**
  ```
  You are an Implementer agent. Your role is to write production code.
  You work on ONE file at a time. You MUST follow existing code patterns in the
  repository. You MUST NOT change interfaces, API contracts, or type definitions
  that were defined during the Shape phase. Your outputs are source code files.
  ```

#### Tester (Prove Phase)

**Purpose:** Generate tests, identify edge cases, analyze coverage gaps. The tester validates but does not fix.

- **Allowed operations:** `Read`, `Glob`, `Grep`, `Write` (only to `tests/`), `Bash` (test runners, coverage tools)
- **Forbidden operations:** `Write`/`Edit` to source code (`src/`)
- **Output constraints:** Test files, coverage reports, edge case documentation. When bugs are found, the tester documents them as structured findings rather than fixing them.
- **System prompt prefix:**
  ```
  You are a Tester agent. Your role is to write tests and verify correctness.
  You MUST NOT modify source code in src/. You may only create or modify files
  in tests/. You document bugs as structured findings with reproduction steps.
  Your outputs are test files, coverage reports, and defect reports.
  ```

## Session Configuration

Role is set via the session config when spawning an agent:

```typescript
interface RoleConfig {
  role: 'architect' | 'implementer' | 'tester' | 'librarian';
}
```

This extends `AgentSpawnRequest`:

```typescript
interface AgentSpawnRequest {
  agentId: string;
  prompt: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  sessionId?: string;
  parentSessionId?: string;
  timeoutMs?: number;
  role?: RoleConfig['role'];  // new field
}
```

### Immutability Within Sessions

A role is set once when the session is created and **cannot change for the lifetime of that session**. To switch roles, the orchestrator must:

1. Complete or pause the current session
2. Create a new session with the new role
3. Pass relevant context from the previous session as part of the new prompt

This enforces clean phase boundaries. A session that started as `architect` cannot silently become an `implementer`.

### Session State Extension

`SessionState` gains a `role` field:

```typescript
interface SessionState {
  // ... existing fields ...
  role: RoleConfig['role'];
}
```

## Enforcement

### AgentRegistry Validation

When `spawnAgent()` is called with a role, the `AgentRegistry` validates that the agent definition is compatible:

```typescript
// In AgentRegistry
validateRole(agentDef: ExtendedAgentDefinition, role: RoleConfig['role']): {
  allowed: boolean;
  reason?: string;
}
```

Validation checks:
1. The agent's `tools` list is filtered to only include tools allowed by the role
2. If the agent requires tools that the role forbids, the spawn is rejected
3. The agent's `systemPrompt` is prefixed with the role-specific prompt

### SelfCorrectionHooks Integration

The existing `preToolUse()` hook in `SelfCorrectionHooks` is extended to enforce role constraints:

```typescript
// In SelfCorrectionHooks.preToolUse()
preToolUse(
  input: PreToolUseHookInput,
  agentDef: ExtendedAgentDefinition,
  role?: RoleConfig['role']  // new parameter
): PreToolUseHookResult
```

The hook checks:
1. Is the requested tool in the role's allowed set?
2. For `Write`/`Edit`: does the target path match the role's output constraints?
   - `architect`: only `docs/`, `*.md`, `*.d.ts`
   - `tester`: only `tests/`
   - `librarian`: blocked entirely
   - `implementer`: unrestricted
3. For `Bash`: does the command match the role's execution constraints?
   - `librarian`/`architect`: only read-only commands (`git log`, `ls`, `cat`, `grep`, `find`)
   - `tester`: test runners and coverage tools only (`npm test`, `vitest`, `pytest`, `coverage`)
   - `implementer`: unrestricted (within existing security rules)

### Audit Trail

All role enforcement decisions are logged to the existing audit log via `SelfCorrectionHooks`:

```typescript
{
  event: 'block',
  decision: 'Role "architect" forbids Write to src/core/orchestrator.ts'
}
```

## Role Templates

Role-specific prompt templates are stored in `templates/roles/`:

```
templates/
  roles/
    architect.md
    implementer.md
    tester.md
    librarian.md
```

Each template contains:
1. **System prompt prefix** -- injected before the agent's base system prompt
2. **Allowed operations list** -- human-readable summary for the LLM
3. **Output format instructions** -- what shape the agent's output should take
4. **Phase-specific guidance** -- contextual instructions for the lifecycle phase

Templates are loaded by the `Orchestrator` during `spawnAgent()` and prepended to the agent definition's `systemPrompt`.

## Configuration Example

```typescript
// Spawn a librarian to explore the codebase
await orchestrator.spawnAgent({
  agentId: 'code-reviewer',
  prompt: 'Summarize the session management architecture and identify all public APIs.',
  role: 'librarian',
  workingDirectory: '/path/to/agent--claude-smith',
});

// Spawn an architect to design a new feature
await orchestrator.spawnAgent({
  agentId: 'task-executor',
  prompt: 'Design the role-based prompting system. Define interfaces and data flow.',
  role: 'architect',
  workingDirectory: '/path/to/agent--claude-smith',
});

// Spawn an implementer to build it
await orchestrator.spawnAgent({
  agentId: 'task-executor',
  prompt: 'Implement RoleConfig and role enforcement in SelfCorrectionHooks.',
  role: 'implementer',
  workingDirectory: '/path/to/agent--claude-smith',
});

// Spawn a tester to verify
await orchestrator.spawnAgent({
  agentId: 'task-executor',
  prompt: 'Write tests for role enforcement. Cover all four roles and edge cases.',
  role: 'tester',
  workingDirectory: '/path/to/agent--claude-smith',
});
```

## Implementation Plan

### Phase 1: Type Definitions
- Add `RoleConfig` type to `src/agents/types.ts`
- Add `role` field to `AgentSpawnRequest` and `SessionState`
- Add Zod schemas for validation
- Define `ROLE_CONSTRAINTS` constant mapping roles to allowed/forbidden operations

### Phase 2: Role Templates
- Create `templates/roles/` directory
- Write prompt templates for all four roles
- Add template loading to `Orchestrator`

### Phase 3: Enforcement
- Extend `SelfCorrectionHooks.preToolUse()` with role-aware path/tool validation
- Add `AgentRegistry.validateRole()` method
- Integrate role validation into `Orchestrator.spawnAgent()`

### Phase 4: Tests
- Unit tests for each role's allowed/forbidden operations
- Integration tests for role immutability within sessions
- Edge case tests: role + security validator interactions, role with subagent spawning

## Open Questions

1. **Subagent role inheritance:** When an `implementer` spawns a subagent, does the subagent inherit the role? Proposed: no -- the parent must explicitly set the subagent's role, and the `AgentRegistry` validates the role transition is sensible (e.g., an `architect` should not spawn an `implementer`).

2. **Hybrid roles:** Should there be a `full-access` role for trusted orchestration agents that need all capabilities? Proposed: yes, but only for agents with `category: 'orchestration'` and explicit opt-in via config.

3. **Role-to-role handoff protocol:** When transitioning from `architect` to `implementer`, what context is passed? Proposed: the orchestrator extracts the architect's final output (design doc) and injects it as context into the implementer's prompt, along with a structured summary of decisions made.
