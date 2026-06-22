# Discovery: agent--claude-smith

**Date:** 2026-06-22
**Verdict:** VALUE FOUND — promote to ranked tier.
**Build state at discovery:** green (`tsc --noEmit` clean, 320 tests passing across 11 files).

## Value Thesis

`agent--claude-smith` is not a skeleton — it is a working, 6,281-LOC, 320-test multi-agent
orchestration system on the Claude Agent SDK, with real exports (`createOrchestrator`,
`Orchestrator`, `AgentRegistry`, `SessionManager`, `SecretResolver`) and four built-in agents.
Its highest *latent* value is not the orchestrator (which overlaps the sibling `agentic-titan`)
but the **self-contained, bypass-resistant security layer** in `src/security/command-validator.ts`:
`validateCommand()` (14 categories of dangerous-shell-pattern detection — destructive deletes,
privilege escalation, fork bombs, `curl|sh` RCE, container escapes, history-tampering — using
normalized pattern matching that survives quote/variable/pipeline obfuscation), plus
`validateWritePath()` (deny-list for `/etc`, `~/.ssh/authorized_keys`, shell rc files, credential
stores) and `validateSessionId()` (path-traversal prevention). It is dependency-free, covered by a
dedicated 31-case command-injection test suite, and solves a problem every agentic repo in the
estate faces independently: how to let an LLM run shell commands without letting it run *those*
shell commands. With ~89 active repos, ~107 CI workflows, and multiple agent-spawning siblings
(`agentic-titan`, `universal-node-network`, `reverse-engine-recursive-run`), a hardened, tested,
reusable command-guardrail is the single most leverageable asset here — a horizontal safety
primitive the rest of ORGAN-IV can consume rather than re-implement as ad-hoc regex. That is the
discovered value: this repo is the estate's natural home for **agent execution guardrails**.

## Highest-Value Asset (concrete)

- **`src/security/command-validator.ts`** — reusable guardrail library (validateCommand /
  validateWritePath / validateSessionId), zero runtime deps, 31 dedicated security tests.
- Supporting capability: the orchestrator's session persistence, cycle-free spawn graphs, and
  self-correction/retry hooks make it a usable reference implementation for governed agent spawning.

## Single Best Concrete First Task

**Extract the security layer into a standalone, importable guardrail package/export**
(e.g. an `@organvm/agent-guardrails` entrypoint or a published sub-export exposing
`validateCommand`, `validateWritePath`, `validateSessionId` + the 31-case test suite) so sibling
agentic repos can `import { validateCommand }` instead of re-implementing shell-safety regexes.
This converts an internal module into an estate-wide reusable asset with one focused, low-risk PR.

## Why not archival

Archival was considered and rejected: the code builds green, has 320 passing tests, exposes a real
public API, and contains a differentiated, broadly-reusable safety primitive. Leaving it dark would
mean every other agent-spawning repo keeps re-solving command validation worse.
