# F-34: Multi-Model Review Workflow

> Design doc for cross-model verification: a primary model generates output, a review model critiques it, and the orchestrator mediates feedback loops.

**Status:** Proposed
**Feature:** F-34
**References:** agent--claude-smith architecture (Orchestrator, SelfCorrectionHooks)

---

## Problem

Single-model generation has a blind-spot problem: the same model that produces output is poorly positioned to catch its own systematic errors. A Claude model generating code will consistently miss the same classes of bugs. A model drafting architecture will not stress-test its own assumptions. Cross-model review introduces cognitive diversity -- a different model (or different model version) applies independent judgment to the same output.

## Design Overview

```
                    +------------------+
                    |   Orchestrator   |
                    +--------+---------+
                             |
              +--------------+--------------+
              |                             |
     +--------v--------+          +--------v--------+
     |  Primary Agent   |          |  Review Agent   |
     |  (generator)     |          |  (critic)       |
     | model: opus      |          | model: sonnet   |
     +--------+---------+          +--------+---------+
              |                             |
              v                             v
        Primary Output               Review Verdict
              |                         /       \
              |                    PASS          FAIL + feedback
              |                     |                |
              v                     v                v
         [complete]            [complete]     [route feedback
                                               back to primary]
```

The orchestrator:
1. Spawns the primary agent to generate output
2. Spawns a review agent with the primary's output + review criteria
3. If review passes, returns the primary output as the final result
4. If review fails, feeds the review feedback back to the primary agent for revision
5. After max rounds (default: 2), escalates to human review

## Use Cases

### 1. Code Review

The primary agent generates code (e.g., a new module). The review agent checks for:
- Correctness: does the code do what the prompt asked?
- Security: are there injection risks, unvalidated inputs, unsafe operations?
- Style: does it follow the repository's conventions?
- Completeness: are edge cases handled? Are error paths covered?

### 2. Design Review

One model proposes an architecture (interfaces, data flow, dependency decisions). The review model stress-tests it:
- Are there circular dependencies?
- Does it handle failure modes?
- Is the interface surface area minimal?
- Are there simpler alternatives?

### 3. Writing Review

One model drafts documentation or prose. The review model checks:
- Clarity: is the writing unambiguous?
- Accuracy: do claims match the codebase?
- Completeness: are all relevant topics covered?
- Consistency: does terminology match existing docs?

## Configuration

Review is configured per-spawn or globally in `OrchestratorConfig`:

```typescript
interface ReviewConfig {
  /** Whether review is enabled for this spawn */
  enabled: boolean;
  /** Model to use for review (should differ from primary for diversity) */
  reviewModel: string;
  /** Criteria the reviewer evaluates against */
  criteria: ReviewCriterion[];
  /** Maximum review-revision rounds before human escalation */
  maxRounds: number;
  /** Review agent timeout in ms */
  reviewTimeoutMs: number;
}

type ReviewCriterion =
  | 'correctness'
  | 'security'
  | 'style'
  | 'completeness'
  | 'clarity'
  | 'performance'
  | 'architecture';
```

Default configuration:

```typescript
const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  enabled: false,
  reviewModel: 'claude-sonnet-4-20250514',
  criteria: ['correctness', 'security', 'style'],
  maxRounds: 2,
  reviewTimeoutMs: 120000, // 2 minutes
};
```

### Spawn-Level Configuration

Review config is passed via `AgentSpawnRequest`:

```typescript
interface AgentSpawnRequest {
  // ... existing fields ...
  review?: ReviewConfig;
}
```

### Global Configuration

Review defaults are set in `OrchestratorConfig`:

```typescript
interface OrchestratorConfig {
  // ... existing fields ...
  defaultReviewConfig?: Partial<ReviewConfig>;
}
```

## Review Agent

The review agent is a special subagent with `role: "reviewer"` (see F-33). It receives a structured prompt containing:

1. **Original prompt** -- what the primary agent was asked to do
2. **Primary output** -- the full output from the primary agent
3. **Review criteria** -- which aspects to evaluate
4. **Codebase context** -- relevant files the reviewer should reference

### Review Agent Definition

```typescript
const REVIEW_AGENT: Partial<ExtendedAgentDefinition> = {
  id: 'system-reviewer',
  name: 'System Reviewer',
  description: 'Cross-model review agent for output verification',
  category: 'code-analysis',
  capabilities: ['read-files'],
  tools: [
    { name: 'Read', enabled: true },
    { name: 'Glob', enabled: true },
    { name: 'Grep', enabled: true },
  ],
  canSpawnSubagents: false,
  maxTurns: 10,
};
```

The reviewer is read-only by design. It evaluates and reports but never modifies.

### Review Prompt Template

Stored at `templates/review-prompt.md`:

```
You are a code reviewer. Evaluate the following output against the specified criteria.

## Original Task
{{original_prompt}}

## Output to Review
{{primary_output}}

## Review Criteria
{{#each criteria}}
- **{{this}}**: Evaluate thoroughly for {{this}} issues.
{{/each}}

## Instructions
1. For each criterion, provide a PASS or FAIL verdict with specific reasoning.
2. If any criterion FAILs, provide actionable feedback the original author can use.
3. Be specific: cite line numbers, quote problematic code, suggest alternatives.
4. Do not rewrite the code yourself -- describe what needs to change.

## Output Format
Respond with a JSON block:
{
  "verdict": "pass" | "fail",
  "criteria": {
    "<criterion>": {
      "verdict": "pass" | "fail",
      "reasoning": "...",
      "feedback": "..." // only if fail
    }
  },
  "summary": "One-paragraph overall assessment"
}
```

## Review Output

The review agent produces a structured verdict:

```typescript
interface ReviewVerdict {
  /** Overall pass/fail */
  verdict: 'pass' | 'fail';
  /** Per-criterion results */
  criteria: Record<ReviewCriterion, {
    verdict: 'pass' | 'fail';
    reasoning: string;
    feedback?: string;
  }>;
  /** One-paragraph summary */
  summary: string;
}

const ReviewVerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  criteria: z.record(z.object({
    verdict: z.enum(['pass', 'fail']),
    reasoning: z.string(),
    feedback: z.string().optional(),
  })),
  summary: z.string(),
});
```

## Orchestrator Flow

The review workflow is implemented inside `Orchestrator.spawnAgent()`:

```typescript
async spawnAgent(request: AgentSpawnRequest): Promise<AgentResult> {
  // 1. Execute primary agent (existing flow)
  const primaryResult = await this.executePrimary(request);

  if (primaryResult.status !== 'success' || !request.review?.enabled) {
    return primaryResult;
  }

  // 2. Run review loop
  return this.runReviewLoop(request, primaryResult);
}

private async runReviewLoop(
  request: AgentSpawnRequest,
  primaryResult: AgentResult
): Promise<AgentResult> {
  const reviewConfig = {
    ...DEFAULT_REVIEW_CONFIG,
    ...this.config.defaultReviewConfig,
    ...request.review,
  };

  let currentOutput = primaryResult.result!;
  let round = 0;

  while (round < reviewConfig.maxRounds) {
    round++;

    // Spawn review agent
    const reviewResult = await this.spawnReviewAgent(
      request.prompt,
      currentOutput,
      reviewConfig
    );

    // Parse review verdict
    const verdict = this.parseReviewVerdict(reviewResult);

    if (verdict.verdict === 'pass') {
      return {
        ...primaryResult,
        metadata: {
          ...primaryResult.metadata,
          reviewPassed: true,
          reviewRound: round,
          reviewSummary: verdict.summary,
        },
      };
    }

    // Review failed -- feed back to primary
    if (round < reviewConfig.maxRounds) {
      const revisionResult = await this.spawnRevisionAgent(
        request,
        currentOutput,
        verdict
      );
      if (revisionResult.status === 'success') {
        currentOutput = revisionResult.result!;
      } else {
        break; // revision failed, escalate
      }
    }
  }

  // Max rounds exceeded -- return with escalation flag
  return {
    ...primaryResult,
    result: currentOutput,
    metadata: {
      ...primaryResult.metadata,
      reviewPassed: false,
      reviewRounds: round,
      escalationRequired: true,
    },
  };
}
```

## Integration with SelfCorrectionHooks

The review workflow integrates with the existing `SelfCorrectionHooks` system as a new hook type. This keeps the review mechanism consistent with the existing safety and correction infrastructure.

### Review as a Correction Hook

`SelfCorrectionHooks` currently handles:
- `preToolUse` -- validate before execution
- `postToolUse` -- audit after execution
- `postToolUseFailure` -- handle failures with retry logic

The review workflow adds a new phase:

- `postAgentExecution` -- review the agent's complete output before returning it to the caller

```typescript
interface PostAgentExecutionHookInput {
  context: HookContext;
  agentDef: ExtendedAgentDefinition;
  result: AgentResult;
  reviewConfig: ReviewConfig;
}

interface PostAgentExecutionHookResult {
  /** Accept the result as-is */
  accept: boolean;
  /** Structured feedback if not accepted */
  feedback?: ReviewVerdict;
  /** Whether to retry with feedback */
  shouldRevise: boolean;
}
```

This hook is called by the `Orchestrator` after `executeAgent()` completes successfully, and only when `reviewConfig.enabled` is true.

### Audit Logging

All review activity is logged through the existing audit system:

```typescript
// Review initiated
{
  event: 'post_tool',  // reusing existing event type
  toolName: 'review',
  decision: 'Review round 1 initiated with model claude-sonnet-4-20250514',
}

// Review verdict
{
  event: 'post_tool',
  toolName: 'review',
  decision: 'Review round 1: FAIL (security: missing input validation)',
}

// Revision spawned
{
  event: 'retry',
  toolName: 'review',
  decision: 'Spawning revision round 2 with feedback',
}

// Human escalation
{
  event: 'block',
  toolName: 'review',
  decision: 'Max review rounds (2) exceeded, escalation required',
}
```

## Model Diversity Strategy

For effective cross-model review, the review model should differ from the primary model:

| Primary Model | Recommended Review Model | Rationale |
|---|---|---|
| `claude-opus-4-20250514` | `claude-sonnet-4-20250514` | Faster, different training emphasis |
| `claude-sonnet-4-20250514` | `claude-opus-4-20250514` | Deeper reasoning for complex reviews |
| Any Claude model | GPT-4o (via adapter) | Maximum cognitive diversity |

When using non-Claude models for review, the review agent must be routed through the appropriate LLM adapter (see agentic-titan's adapter layer for the pattern). The review prompt template remains the same; only the API call changes.

## Failure Modes

| Failure | Handling |
|---|---|
| Review agent times out | Accept primary output, log warning, flag for human review |
| Review output is unparseable | Treat as FAIL, escalate to human |
| Primary fails to address feedback after revision | Escalate after max rounds |
| Both models agree on incorrect output | Not detectable by this system; mitigated by review criteria specificity and human spot-checks |
| Review model is unavailable (API error) | Fall back to primary output with `reviewSkipped: true` metadata |

## Implementation Plan

### Phase 1: Types and Config
- Add `ReviewConfig`, `ReviewVerdict` types to `src/agents/types.ts`
- Add `review` field to `AgentSpawnRequest`
- Add `defaultReviewConfig` to `OrchestratorConfig`
- Add Zod schemas for all new types

### Phase 2: Review Agent
- Create `system-reviewer` agent definition
- Create `templates/review-prompt.md` template
- Add review prompt builder (template interpolation with criteria)

### Phase 3: Orchestrator Integration
- Add `postAgentExecution` hook to `SelfCorrectionHooks`
- Implement `runReviewLoop()` in `Orchestrator`
- Implement `spawnReviewAgent()` and `spawnRevisionAgent()` methods
- Wire review config resolution (spawn-level overrides global defaults)

### Phase 4: Audit and Observability
- Add review-specific audit log entries
- Add review metadata to `AgentResult`
- Add `escalationRequired` flag for human-in-the-loop integration

### Phase 5: Tests
- Unit tests for `ReviewVerdict` parsing (valid, malformed, edge cases)
- Unit tests for review loop (pass on first round, fail-then-pass, max rounds exceeded)
- Integration test: full spawn with review enabled
- Test: review agent timeout handling
- Test: review with role-based prompting (F-33 interaction)

## Open Questions

1. **Cost control:** Review doubles (or triples) token usage. Should there be a budget gate that disables review when token spend exceeds a threshold? Proposed: yes, add `maxReviewTokens` to `ReviewConfig`.

2. **Selective review:** Not all outputs need review. Should the orchestrator auto-detect which outputs are "high-risk" (e.g., security-related code, public API changes) and enable review only for those? Proposed: yes, as a follow-up feature using the agent's `category` and the review criteria to decide.

3. **Review caching:** If the same prompt+output has been reviewed before, skip the review. Useful during retry loops. Proposed: use a content hash to detect duplicates, store in `ExpiringMap` with short TTL.

4. **Multi-reviewer:** Should multiple review models run in parallel for higher confidence? Proposed: defer to a future iteration. The current design supports one reviewer per round; parallel review would require a consensus mechanism.
