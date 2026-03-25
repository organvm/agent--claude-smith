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

**Organ:** ORGAN-IV (Orchestration) | **Tier:** standard | **Status:** GRADUATED
**Org:** `organvm-iv-taxis` | **Repo:** `agent--claude-smith`

### Edges
- **Produces** → `organvm-iv-taxis/a-i--skills`: governance-policy
- **Consumes** ← `META-ORGANVM`: registry

### Siblings in Orchestration
`orchestration-start-here`, `petasum-super-petasum`, `universal-node-network`, `.github`, `agentic-titan`, `a-i--skills`, `tool-interaction-design`, `system-governance-framework`, `reverse-engine-recursive-run`, `collective-persona-operations`, `contrib--adenhq-hive`, `contrib--ipqwery-ipapi-py`, `contrib--primeinc-github-stars`, `contrib--temporal-sdk-python`, `contrib--dbt-mcp` ... and 2 more

### Governance
- *Standard ORGANVM governance applies*

*Last synced: 2026-03-25T22:27:13Z*

## Session Review Protocol

At the end of each session that produces or modifies files:
1. Run `organvm session review --latest` to get a session summary
2. Check for unimplemented plans: `organvm session plans --project .`
3. Export significant sessions: `organvm session export <id> --slug <slug>`
4. Run `organvm prompts distill --dry-run` to detect uncovered operational patterns

Transcripts are on-demand (never committed):
- `organvm session transcript <id>` — conversation summary
- `organvm session transcript <id> --unabridged` — full audit trail
- `organvm session prompts <id>` — human prompts only


## Active Directives

| Scope | Phase | Name | Description |
|-------|-------|------|-------------|
| system | any | prompting-standards | Prompting Standards |
| system | any | research-standards-bibliography | APPENDIX: Research Standards Bibliography |
| system | any | phase-closing-and-forward-plan | METADOC: Phase-Closing Commemoration & Forward Attack Plan |
| system | any | research-standards | METADOC: Architectural Typology & Research Standards |
| system | any | sop-ecosystem | METADOC: SOP Ecosystem — Taxonomy, Inventory & Coverage |
| system | any | autonomous-content-syndication | SOP: Autonomous Content Syndication (The Broadcast Protocol) |
| system | any | autopoietic-systems-diagnostics | SOP: Autopoietic Systems Diagnostics (The Mirror of Eternity) |
| system | any | background-task-resilience | background-task-resilience |
| system | any | cicd-resilience-and-recovery | SOP: CI/CD Pipeline Resilience & Recovery |
| system | any | community-event-facilitation | SOP: Community Event Facilitation (The Dialectic Crucible) |
| system | any | context-window-conservation | context-window-conservation |
| system | any | conversation-to-content-pipeline | SOP — Conversation-to-Content Pipeline |
| system | any | cross-agent-handoff | SOP: Cross-Agent Session Handoff |
| system | any | cross-channel-publishing-metrics | SOP: Cross-Channel Publishing Metrics (The Echo Protocol) |
| system | any | data-migration-and-backup | SOP: Data Migration and Backup Protocol (The Memory Vault) |
| system | any | document-audit-feature-extraction | SOP: Document Audit & Feature Extraction |
| system | any | dynamic-lens-assembly | SOP: Dynamic Lens Assembly |
| system | any | essay-publishing-and-distribution | SOP: Essay Publishing & Distribution |
| system | any | formal-methods-applied-protocols | SOP: Formal Methods Applied Protocols |
| system | any | formal-methods-master-taxonomy | SOP: Formal Methods Master Taxonomy (The Blueprint of Proof) |
| system | any | formal-methods-tla-pluscal | SOP: Formal Methods — TLA+ and PlusCal Verification (The Blueprint Verifier) |
| system | any | generative-art-deployment | SOP: Generative Art Deployment (The Gallery Protocol) |
| system | any | market-gap-analysis | SOP: Full-Breath Market-Gap Analysis & Defensive Parrying |
| system | any | mcp-server-fleet-management | SOP: MCP Server Fleet Management (The Server Protocol) |
| system | any | multi-agent-swarm-orchestration | SOP: Multi-Agent Swarm Orchestration (The Polymorphic Swarm) |
| system | any | network-testament-protocol | SOP: Network Testament Protocol (The Mirror Protocol) |
| system | any | open-source-licensing-and-ip | SOP: Open Source Licensing and IP (The Commons Protocol) |
| system | any | performance-interface-design | SOP: Performance Interface Design (The Stage Protocol) |
| system | any | pitch-deck-rollout | SOP: Pitch Deck Generation & Rollout |
| system | any | polymorphic-agent-testing | SOP: Polymorphic Agent Testing (The Adversarial Protocol) |
| system | any | promotion-and-state-transitions | SOP: Promotion & State Transitions |
| system | any | recursive-study-feedback | SOP: Recursive Study & Feedback Loop (The Ouroboros) |
| system | any | repo-onboarding-and-habitat-creation | SOP: Repo Onboarding & Habitat Creation |
| system | any | research-to-implementation-pipeline | SOP: Research-to-Implementation Pipeline (The Gold Path) |
| system | any | security-and-accessibility-audit | SOP: Security & Accessibility Audit |
| system | any | session-self-critique | session-self-critique |
| system | any | smart-contract-audit-and-legal-wrap | SOP: Smart Contract Audit and Legal Wrap (The Ledger Protocol) |
| system | any | source-evaluation-and-bibliography | SOP: Source Evaluation & Annotated Bibliography (The Refinery) |
| system | any | stranger-test-protocol | SOP: Stranger Test Protocol |
| system | any | strategic-foresight-and-futures | SOP: Strategic Foresight & Futures (The Telescope) |
| system | any | styx-pipeline-traversal | SOP: Styx Pipeline Traversal (The 7-Organ Transmutation) |
| system | any | system-dashboard-telemetry | SOP: System Dashboard Telemetry (The Panopticon Protocol) |
| system | any | the-descent-protocol | the-descent-protocol |
| system | any | the-membrane-protocol | the-membrane-protocol |
| system | any | theoretical-concept-versioning | SOP: Theoretical Concept Versioning (The Epistemic Protocol) |
| system | any | theory-to-concrete-gate | theory-to-concrete-gate |
| system | any | typological-hermeneutic-analysis | SOP: Typological & Hermeneutic Analysis (The Archaeology) |

Linked skills: cicd-resilience-and-recovery, continuous-learning-agent, evaluation-to-growth, genesis-dna, multi-agent-workforce-planner, promotion-and-state-transitions, quality-gate-baseline-calibration, repo-onboarding-and-habitat-creation, structural-integrity-audit


**Prompting (Anthropic)**: context 200K tokens, format: XML tags, thinking: extended thinking (budget_tokens)


## Ecosystem Status

- **delivery**: 0/2 live, 1 planned
- **content**: 0/1 live, 0 planned

Run: `organvm ecosystem show agent--claude-smith` | `organvm ecosystem validate --organ IV`


## External Mirrors (Network Testament)

- **technical** (2): microsoft/TypeScript, vitest-dev/vitest

Convergences: 20 | Run: `organvm network map --repo agent--claude-smith` | `organvm network suggest`


## Entity Identity (Ontologia)

**UID:** `ent_repo_01KKKX3RVP93PDEQN01RWK6MBW` | **Matched by:** primary_name

Resolve: `organvm ontologia resolve agent--claude-smith` | History: `organvm ontologia history ent_repo_01KKKX3RVP93PDEQN01RWK6MBW`


## Live System Variables (Ontologia)

| Variable | Value | Scope | Updated |
|----------|-------|-------|---------|
| `active_repos` | 64 | global | 2026-03-25 |
| `archived_repos` | 54 | global | 2026-03-25 |
| `ci_workflows` | 106 | global | 2026-03-25 |
| `code_files` | 0 | global | 2026-03-25 |
| `dependency_edges` | 60 | global | 2026-03-25 |
| `operational_organs` | 8 | global | 2026-03-25 |
| `published_essays` | 29 | global | 2026-03-25 |
| `repos_with_tests` | 0 | global | 2026-03-25 |
| `sprints_completed` | 33 | global | 2026-03-25 |
| `test_files` | 0 | global | 2026-03-25 |
| `total_organs` | 8 | global | 2026-03-25 |
| `total_repos` | 127 | global | 2026-03-25 |
| `total_words_formatted` | 0 | global | 2026-03-25 |
| `total_words_numeric` | 0 | global | 2026-03-25 |
| `total_words_short` | 0K+ | global | 2026-03-25 |

Metrics: 9 registered | Observations: 15536 recorded
Resolve: `organvm ontologia status` | Refresh: `organvm refresh`


## System Density (auto-generated)

AMMOI: 56% | Edges: 41 | Tensions: 33 | Clusters: 5 | Adv: 7 | Events(24h): 23754
Structure: 8 organs / 127 repos / 1654 components (depth 17) | Inference: 98% | Organs: META-ORGANVM:64%, ORGAN-I:55%, ORGAN-II:47%, ORGAN-III:55% +4 more
Last pulse: 2026-03-25T22:27:04 | Δ24h: +3.5% | Δ7d: n/a


## Dialect Identity (Trivium)

**Dialect:** GOVERNANCE_LOGIC | **Classical Parallel:** Rhetoric | **Translation Role:** The Meta-Logic — governance rules ARE propositions

Strongest translations: I (formal), V (structural), META (structural)

Scan: `organvm trivium scan IV <OTHER>` | Matrix: `organvm trivium matrix` | Synthesize: `organvm trivium synthesize`

<!-- ORGANVM:AUTO:END -->


## ⚡ Conductor OS Integration
This repository is a managed component of the ORGANVM meta-workspace.
- **Orchestration:** Use `conductor patch` for system status and work queue.
- **Lifecycle:** Follow the `FRAME -> SHAPE -> BUILD -> PROVE` workflow.
- **Governance:** Promotions are managed via `conductor wip promote`.
- **Intelligence:** Conductor MCP tools are available for routing and mission synthesis.
