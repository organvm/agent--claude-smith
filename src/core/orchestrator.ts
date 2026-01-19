import Anthropic from '@anthropic-ai/sdk';
import type {
  ExtendedAgentDefinition,
  AgentSpawnRequest,
  AgentResult,
  OrchestratorConfig,
  HookContext,
} from '../agents/types.js';
import { DEFAULT_ORCHESTRATOR_CONFIG } from '../agents/types.js';
import { AgentRegistry, getAgentRegistry } from './agent-registry.js';
import { SessionManager, getSessionManager, type OrchestratorShutdownResult } from './session-manager.js';
import { SecretResolver, getSecretResolver } from '../secrets/secret-resolver.js';
import { SelfCorrectionHooks, getSelfCorrectionHooks, AuditLogEntry } from '../hooks/self-correction.js';
import type { ChezmoiManager } from '../config/chezmoi-manager.js';

// ============================================================================
// Orchestrator
// ============================================================================

interface OrchestratorOptions {
  config?: Partial<OrchestratorConfig>;
  registry?: AgentRegistry;
  sessionManager?: SessionManager;
  secretResolver?: SecretResolver;
  hooks?: SelfCorrectionHooks;
  chezmoiManager?: ChezmoiManager;
  onAuditEntry?: (entry: AuditLogEntry) => void;
}

/**
 * Main orchestrator for managing agent execution
 */
export class Orchestrator {
  private readonly config: OrchestratorConfig;
  private readonly registry: AgentRegistry;
  private readonly sessionManager: SessionManager;
  private readonly secretResolver: SecretResolver;
  private readonly hooks: SelfCorrectionHooks;
  private readonly chezmoiManager: ChezmoiManager | null;

  private activeAgents: Map<string, AbortController> = new Map();
  private initialized = false;

  constructor(options: OrchestratorOptions = {}) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...options.config };

    this.registry = options.registry ?? getAgentRegistry({
      defaultModel: this.config.defaultModel,
    });

    this.sessionManager = options.sessionManager ?? getSessionManager({
      storagePath: this.config.sessionStoragePath,
    });

    this.secretResolver = options.secretResolver ?? getSecretResolver({
      baseEnv: this.config.globalEnv,
    });

    this.hooks = options.hooks ?? getSelfCorrectionHooks({
      onAuditEntry: options.onAuditEntry,
    });

    this.chezmoiManager = options.chezmoiManager ?? null;
  }

  /**
   * Initialize the orchestrator
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.sessionManager.initialize();

    // Load chezmoi configs if manager is available
    if (this.chezmoiManager) {
      const { agents, errors } = await this.chezmoiManager.loadAllConfigs();

      if (errors.length > 0) {
        console.warn('[Orchestrator] Some config files failed to load:', errors);
      }

      this.registry.registerFromConfigs(agents);
    }

    this.initialized = true;
    console.log('[Orchestrator] Initialized');
  }

  /**
   * Spawn a single agent
   */
  async spawnAgent(request: AgentSpawnRequest): Promise<AgentResult> {
    await this.ensureInitialized();

    const agentDef = this.registry.get(request.agentId);
    if (!agentDef) {
      return this.createErrorResult(request, `Agent not found: ${request.agentId}`);
    }

    // Resolve secrets for the agent
    let resolvedEnv: Record<string, string>;
    try {
      const { env } = await this.secretResolver.resolveForAgent(agentDef);
      resolvedEnv = { ...this.config.globalEnv, ...env, ...request.env };
    } catch (error) {
      return this.createErrorResult(
        request,
        `Failed to resolve secrets: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Create or resume session
    let session;
    if (request.sessionId) {
      session = await this.sessionManager.resumeSession(request.sessionId);
      if (!session) {
        return this.createErrorResult(request, `Session not found or cannot be resumed: ${request.sessionId}`);
      }
    } else {
      session = await this.sessionManager.createSession({
        agentId: request.agentId,
        prompt: request.prompt,
        workingDirectory: request.workingDirectory ?? this.config.defaultWorkingDirectory,
        env: resolvedEnv,
        maxTurns: agentDef.maxTurns,
        parentSessionId: request.parentSessionId,
      });
    }

    // Setup abort controller for cancellation
    const abortController = new AbortController();
    this.activeAgents.set(session.id, abortController);

    // Setup timeout
    const timeoutMs = request.timeoutMs ?? agentDef.maxExecutionTimeMs;
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    const startTime = Date.now();

    try {
      const result = await this.executeAgent(
        agentDef,
        session.id,
        request.prompt,
        resolvedEnv,
        request.workingDirectory ?? this.config.defaultWorkingDirectory
      );

      clearTimeout(timeoutId);
      this.activeAgents.delete(session.id);

      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      this.activeAgents.delete(session.id);

      const executionTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it was aborted due to timeout
      if (abortController.signal.aborted) {
        await this.sessionManager.failSession(session.id, {
          code: 'TIMEOUT',
          message: `Agent execution timed out after ${timeoutMs}ms`,
          recoverable: true,
        });

        return {
          sessionId: session.id,
          agentId: request.agentId,
          status: 'timeout',
          error: `Agent execution timed out after ${timeoutMs}ms`,
          turnsTaken: session.currentTurn,
          executionTimeMs,
        };
      }

      await this.sessionManager.failSession(session.id, {
        code: 'EXECUTION_ERROR',
        message: errorMessage,
        recoverable: false,
      });

      return {
        sessionId: session.id,
        agentId: request.agentId,
        status: 'error',
        error: errorMessage,
        turnsTaken: session.currentTurn,
        executionTimeMs,
      };
    }
  }

  /**
   * Spawn multiple agents in parallel.
   *
   * Results are returned in the same order as the input requests,
   * regardless of completion order.
   *
   * @param requests - Array of agent spawn requests
   * @param options - Parallel execution options
   * @returns Array of results in the same order as input requests
   */
  async spawnParallel(
    requests: AgentSpawnRequest[],
    options: { maxConcurrent?: number } = {}
  ): Promise<AgentResult[]> {
    await this.ensureInitialized();

    const maxConcurrent = options.maxConcurrent ?? this.config.maxConcurrentAgents;
    // Pre-allocate result array to maintain request order
    const results: (AgentResult | undefined)[] = new Array(requests.length);
    const pending: Promise<void>[] = [];
    let nextRequestIndex = 0;

    const executeNext = async (): Promise<void> => {
      // Capture index before incrementing (for ordering)
      const currentIndex = nextRequestIndex++;
      if (currentIndex >= requests.length) return;

      const request = requests[currentIndex];
      const result = await this.spawnAgent(request);
      // Store result at its original index to maintain order
      results[currentIndex] = result;

      // Continue with next request if available
      await executeNext();
    };

    // Start up to maxConcurrent executions
    const initialCount = Math.min(maxConcurrent, requests.length);
    for (let i = 0; i < initialCount; i++) {
      pending.push(executeNext());
    }

    await Promise.all(pending);

    // Filter out any undefined entries (shouldn't happen, but type-safe)
    return results.filter((r): r is AgentResult => r !== undefined);
  }

  /**
   * Resume a session
   */
  async resumeSession(sessionId: string): Promise<AgentResult | null> {
    await this.ensureInitialized();

    const context = await this.sessionManager.getResumptionContext(sessionId);
    if (!context) {
      console.error(`[Orchestrator] Session not found: ${sessionId}`);
      return null;
    }

    const { session } = context;

    // Build the prompt with resumption context
    let prompt = session.prompt;
    if (context.checkpoint?.partialResult) {
      prompt = `Continue from previous work:\n\nOriginal task: ${session.prompt}\n\nPartial progress:\n${context.checkpoint.partialResult}\n\nPlease continue where you left off.`;
    }

    return this.spawnAgent({
      agentId: session.agentId,
      prompt,
      workingDirectory: session.workingDirectory,
      env: session.env,
      sessionId,
    });
  }

  /**
   * Cancel a running agent
   */
  async cancelAgent(sessionId: string): Promise<boolean> {
    const controller = this.activeAgents.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeAgents.delete(sessionId);
      await this.sessionManager.cancelSession(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Get the agent registry
   */
  getRegistry(): AgentRegistry {
    return this.registry;
  }

  /**
   * Get the session manager
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get audit log
   */
  getAuditLog(): readonly AuditLogEntry[] {
    return this.hooks.getAuditLog();
  }

  /**
   * Shutdown the orchestrator.
   *
   * Cancels all active agents and saves all sessions. Errors are collected
   * rather than aborting on first failure.
   *
   * @returns OrchestratorShutdownResult with success status and any errors encountered
   */
  async shutdown(): Promise<OrchestratorShutdownResult> {
    const cancellationErrors: Array<{ sessionId: string; error: Error }> = [];
    let agentsCancelled = 0;

    // Cancel all active agents, collecting errors
    for (const [sessionId, controller] of this.activeAgents) {
      try {
        controller.abort();
        await this.sessionManager.pauseSession(sessionId);
        agentsCancelled++;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        cancellationErrors.push({ sessionId, error: err });
        console.error(`[Orchestrator] Failed to pause session ${sessionId}:`, err.message);
      }
    }
    this.activeAgents.clear();

    // Shutdown session manager (continues on errors)
    const sessionResult = await this.sessionManager.shutdown();

    const success = cancellationErrors.length === 0 && sessionResult.success;
    console.log(
      `[Orchestrator] Shutdown complete: ${agentsCancelled} agents cancelled, ` +
      `${sessionResult.sessionsSaved} sessions saved` +
      (cancellationErrors.length > 0 ? `, ${cancellationErrors.length} cancellation errors` : '') +
      (sessionResult.errors.length > 0 ? `, ${sessionResult.errors.length} save errors` : '')
    );

    return { success, agentsCancelled, sessionResult, cancellationErrors };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Execute an agent using the Claude API
   */
  private async executeAgent(
    agentDef: ExtendedAgentDefinition,
    sessionId: string,
    prompt: string,
    env: Record<string, string>,
    workingDirectory: string
  ): Promise<AgentResult> {
    const startTime = Date.now();
    let turnsTaken = 0;

    // Create the Anthropic client
    const client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY, // allow-secret
    });

    // Build hook context
    const hookContext: HookContext = {
      sessionId,
      agentId: agentDef.id,
      turnNumber: 0,
      workingDirectory,
      env,
    };

    try {
      // Use the Claude API to run the agent
      const result = await client.messages.create({
        model: agentDef.model ?? this.config.defaultModel,
        max_tokens: 8192,
        system: agentDef.systemPrompt,
        messages: [
          { role: 'user', content: prompt }
        ],
      });

      turnsTaken++;
      await this.sessionManager.updateTurn(sessionId, turnsTaken);

      // Extract the response text
      const responseText = result.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      // Add messages to session history
      await this.sessionManager.addMessage(sessionId, 'user', prompt, turnsTaken);
      await this.sessionManager.addMessage(sessionId, 'assistant', responseText, turnsTaken);

      // Complete the session
      await this.sessionManager.completeSession(sessionId, responseText);

      const executionTimeMs = Date.now() - startTime;

      return {
        sessionId,
        agentId: agentDef.id,
        status: 'success',
        result: responseText,
        turnsTaken,
        executionTimeMs,
        metadata: {
          model: agentDef.model ?? this.config.defaultModel,
          stopReason: result.stop_reason,
        },
      };
    } catch (error) {
      // Use hooks for error handling
      this.hooks.postToolUseFailure(
        {
          context: hookContext,
          toolName: 'agent_execution',
          toolInput: { prompt },
          error: error instanceof Error ? error : new Error(String(error)),
          attemptNumber: 1,
        },
        agentDef.retryConfig
      );

      throw error;
    }
  }

  /**
   * Create an error result without creating a session
   */
  private createErrorResult(
    request: AgentSpawnRequest,
    error: string
  ): AgentResult {
    return {
      sessionId: request.sessionId ?? 'no-session',
      agentId: request.agentId,
      status: 'error',
      error,
      turnsTaken: 0,
      executionTimeMs: 0,
    };
  }

  /**
   * Ensure orchestrator is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

let defaultOrchestrator: Orchestrator | null = null;

export function getOrchestrator(options?: OrchestratorOptions): Orchestrator {
  if (!defaultOrchestrator) {
    defaultOrchestrator = new Orchestrator(options);
  }
  return defaultOrchestrator;
}

export function resetOrchestrator(): void {
  if (defaultOrchestrator) {
    defaultOrchestrator.shutdown().catch(console.error);
  }
  defaultOrchestrator = null;
}
