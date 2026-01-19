import type {
  SessionState,
  ConversationMessage,
  CheckpointData,
  ToolCallRecord,
} from '../agents/types.js';
import { SessionStore, getSessionStore, type ShutdownResult } from '../persistence/session-store.js';

// ============================================================================
// Session Manager
// ============================================================================

// Re-export ShutdownResult for consumers
export type { ShutdownResult };

/**
 * Orchestrator shutdown result with additional context
 */
export interface OrchestratorShutdownResult {
  /** Whether shutdown completed successfully */
  success: boolean;
  /** Number of active agents cancelled */
  agentsCancelled: number;
  /** Session store shutdown result */
  sessionResult: ShutdownResult;
  /** Errors from agent cancellation */
  cancellationErrors: Array<{ sessionId: string; error: Error }>;
}

interface SessionManagerConfig {
  /** Session storage path */
  storagePath: string;
  /** TTL for completed sessions */
  completedSessionTtlMs?: number;
  /** Auto-save interval */
  autoSaveIntervalMs?: number;
}

/**
 * High-level session management for the orchestrator
 */
export class SessionManager {
  private readonly store: SessionStore;
  private initialized = false;

  constructor(config: SessionManagerConfig) {
    this.store = getSessionStore({
      storagePath: config.storagePath,
      completedSessionTtlMs: config.completedSessionTtlMs,
      autoSaveIntervalMs: config.autoSaveIntervalMs,
    });
  }

  /**
   * Initialize the session manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.initialize();
    this.initialized = true;
  }

  /**
   * Create a new session
   */
  async createSession(params: {
    agentId: string;
    prompt: string;
    workingDirectory: string;
    env: Record<string, string>;
    maxTurns: number;
    parentSessionId?: string;
  }): Promise<SessionState> {
    await this.ensureInitialized();
    return this.store.createSession(params);
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    await this.ensureInitialized();
    return this.store.getSession(sessionId);
  }

  /**
   * Resume a paused or running session
   */
  async resumeSession(sessionId: string): Promise<SessionState | null> {
    await this.ensureInitialized();

    const session = await this.store.getSession(sessionId);
    if (!session) {
      return null;
    }

    // Can only resume paused or running sessions
    if (session.status !== 'paused' && session.status !== 'running') {
      console.warn(`[SessionManager] Cannot resume session ${sessionId} with status ${session.status}`);
      return null;
    }

    // Set back to running
    await this.store.updateStatus(sessionId, 'running');
    return this.store.getSession(sessionId);
  }

  /**
   * Pause a running session
   */
  async pauseSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    await this.store.updateStatus(sessionId, 'paused');
  }

  /**
   * Mark session as completed with result
   */
  async completeSession(sessionId: string, result: string): Promise<void> {
    await this.ensureInitialized();
    await this.store.setResult(sessionId, result);
  }

  /**
   * Mark session as failed with error
   */
  async failSession(
    sessionId: string,
    error: { code: string; message: string; recoverable: boolean }
  ): Promise<void> {
    await this.ensureInitialized();
    await this.store.setError(sessionId, {
      ...error,
      retryCount: 0,
    });
    await this.store.updateStatus(sessionId, 'failed');
  }

  /**
   * Cancel a session
   */
  async cancelSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    await this.store.updateStatus(sessionId, 'cancelled');
  }

  /**
   * Update session turn
   */
  async updateTurn(sessionId: string, turn: number): Promise<void> {
    await this.ensureInitialized();
    await this.store.updateTurn(sessionId, turn);
  }

  /**
   * Add message to conversation
   */
  async addMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    turnNumber: number
  ): Promise<void> {
    await this.ensureInitialized();
    await this.store.addMessage(sessionId, { role, content, turnNumber });
  }

  /**
   * Save checkpoint for resumption
   */
  async saveCheckpoint(
    sessionId: string,
    checkpoint: {
      lastTurn: number;
      partialResult?: string;
      toolCallHistory: ToolCallRecord[];
    }
  ): Promise<void> {
    await this.ensureInitialized();
    await this.store.saveCheckpoint(sessionId, checkpoint);
  }

  /**
   * Record a tool call
   */
  async recordToolCall(sessionId: string, toolCall: ToolCallRecord): Promise<void> {
    await this.ensureInitialized();
    await this.store.recordToolCall(sessionId, toolCall);
  }

  /**
   * List active sessions
   */
  async listActiveSessions(): Promise<SessionState[]> {
    await this.ensureInitialized();
    return this.store.listSessions({ status: ['running', 'paused'] });
  }

  /**
   * List sessions by agent
   */
  async listSessionsByAgent(agentId: string): Promise<SessionState[]> {
    await this.ensureInitialized();
    return this.store.listSessions({ agentId });
  }

  /**
   * List child sessions of a parent
   */
  async listChildSessions(parentSessionId: string): Promise<SessionState[]> {
    await this.ensureInitialized();
    return this.store.listSessions({ parentSessionId });
  }

  /**
   * List root sessions (no parent)
   */
  async listRootSessions(): Promise<SessionState[]> {
    await this.ensureInitialized();
    return this.store.listSessions({ parentSessionId: null });
  }

  /**
   * Get session with children
   */
  async getSessionTree(sessionId: string): Promise<{
    session: SessionState;
    children: SessionState[];
  } | null> {
    await this.ensureInitialized();

    const session = await this.store.getSession(sessionId);
    if (!session) {
      return null;
    }

    const children = await this.listChildSessions(sessionId);

    return { session, children };
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();

    // Delete child sessions first
    const children = await this.listChildSessions(sessionId);
    for (const child of children) {
      await this.deleteSession(child.id);
    }

    await this.store.deleteSession(sessionId);
  }

  /**
   * Cleanup old sessions
   */
  async cleanup(): Promise<number> {
    await this.ensureInitialized();
    return this.store.cleanupOldSessions();
  }

  /**
   * Shutdown the session manager.
   *
   * @returns ShutdownResult with success status and any errors encountered
   */
  async shutdown(): Promise<ShutdownResult> {
    return this.store.shutdown();
  }

  /**
   * Get resumption context for a session
   */
  async getResumptionContext(sessionId: string): Promise<{
    session: SessionState;
    checkpoint: CheckpointData | undefined;
    lastMessages: ConversationMessage[];
  } | null> {
    await this.ensureInitialized();

    const session = await this.store.getSession(sessionId);
    if (!session) {
      return null;
    }

    // Get last few messages for context
    const messageCount = Math.min(10, session.conversationHistory.length);
    const lastMessages = session.conversationHistory.slice(-messageCount);

    return {
      session,
      checkpoint: session.checkpoint,
      lastMessages,
    };
  }

  /**
   * Ensure manager is initialized
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

let defaultManager: SessionManager | null = null;

export function getSessionManager(config?: SessionManagerConfig): SessionManager {
  if (!defaultManager) {
    if (!config) {
      config = {
        storagePath: './.sessions',
      };
    }
    defaultManager = new SessionManager(config);
  }
  return defaultManager;
}

export function resetSessionManager(): void {
  if (defaultManager) {
    defaultManager.shutdown().catch(console.error);
  }
  defaultManager = null;
}
