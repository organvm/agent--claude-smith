# Claude Smith (agent--claude-smith)

## Project Overview

This is a multi-agent orchestration system built with the Claude Agent SDK. It provides:

- **Subagent spawning** - Agents can spawn other agents to handle subtasks
- **Parallel execution** - Run multiple agents concurrently
- **Session persistence** - Save and resume long-running sessions
- **Self-correction** - Automatic retry and error recovery
- **1Password integration** - Secure secrets management
- **chezmoi integration** - Machine-specific configuration templates

## Architecture

```
src/
├── index.ts              # Main entry point (CLI + library)
├── core/
│   ├── orchestrator.ts   # Main orchestrator (spawning, parallel exec)
│   ├── agent-registry.ts # Agent definition registry
│   └── session-manager.ts # Session persistence
├── agents/
│   ├── types.ts          # Core type definitions
│   ├── code-reviewer.ts  # Code review specialist
│   ├── task-executor.ts  # General task execution
│   ├── security-auditor.ts # Security analysis
│   └── ai-bridge.ts      # External AI integration
├── secrets/
│   ├── one-password.ts   # 1Password SDK integration
│   └── secret-resolver.ts # Secret resolution
├── config/
│   ├── chezmoi-manager.ts # chezmoi template integration
│   └── types.ts          # Config types
├── hooks/
│   ├── self-correction.ts # Safety hooks & audit logging
│   └── retry-handler.ts  # Retry with exponential backoff
└── persistence/
    └── session-store.ts  # Session file storage
```

## Key Files

- `src/agents/types.ts` - All TypeScript interfaces and Zod schemas
- `src/core/orchestrator.ts` - Main orchestrator class
- `src/hooks/self-correction.ts` - Safety checks and audit logging

## Development Commands

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Build
npm run build

# Run in development
npm run dev

# Run directly
npm start
```

## Usage

### Programmatic

```typescript
import { createOrchestrator } from 'agent--claude-smith';

const orchestrator = await createOrchestrator({
  registerBuiltins: true,
});

const result = await orchestrator.spawnAgent({
  agentId: 'code-reviewer',
  prompt: 'Review the authentication module for security issues',
});
```

### CLI

```bash
# Run a code review
claude-smith -a code-reviewer -p "Review src/auth/"

# Run agents in parallel
claude-smith --parallel code-reviewer,security-auditor -p "Analyze the codebase"

# List available agents
claude-smith --list

# Resume a session
claude-smith --resume <session-id>
```

## Configuration

### Environment Variables

- `ANTHROPIC_API_KEY` - Claude API key
- `OP_SERVICE_ACCOUNT_TOKEN` - 1Password service account token
- `CLAUDE_AGENT_TEMPLATES` - Path to chezmoi agent config templates

### 1Password References

Secrets are referenced using the format `op://<vault>/<item>/<field>`:

```typescript
secretRefs: [
  { name: 'ANTHROPIC_API_KEY', ref: 'op://Development/anthropic/api-key', required: true }
]
```

### chezmoi Templates

Agent configs can be templated with chezmoi:

```toml
# templates/agent-configs/code-reviewer.toml.tmpl
id = "code-reviewer"
{{- if eq .chezmoi.os "darwin" }}
maxConcurrency = 4
{{- else }}
maxConcurrency = 2
{{- end }}
```

## Code Style

- TypeScript with strict mode enabled
- ES modules (`"type": "module"`)
- Zod for runtime validation
- Factory functions for singleton instances

## Security Considerations

- Dangerous operations are blocked by default (rm -rf, sudo, etc.)
- All tool calls are audited
- Secrets are never logged
- File operations are restricted to allowed paths
