import { readFile, writeFile, readdir, unlink, mkdir, rename } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
  SessionState,
  SessionStatus,
  ConversationMessage,
  CheckpointData,
  SessionError,
  ToolCallRecord,
} from '../agents/types.js';
import { validateSessionId } from '../security/command-validator.js';
import { KeyedMutex } from '../utils/singleton.js';

// ============================================================================
// Session Store
// ============================================================================

interface SessionStoreConfig {
  /** Directory to store session files */
  storagePath: string;
  /** File extension for session files */
  fileExtension?: string;
  /** How long to keep completed sessions (ms) */
  completedSessionTtlMs?: number;
  /** Auto-save interval for running sessions (ms) */
  autoSaveIntervalMs?: number;
  /** Callback for auto-save errors (optional) */
  onAutoSaveError?: (sessionId: string, error: Error, consecutiveFailures: number) => void;
  /** Number of consecutive failures before stopping auto-save (default: 5) */
  maxConsecutiveAutoSaveFailures?: number;
}

/**
 * Result of a shutdown operation
 */
export interface ShutdownResult {
  /** Whether shutdown completed successfully */
  success: boolean;
  /** Number of sessions saved during shutdown */
  sessionsSaved: number;
  /** Errors encountered during shutdown */
  errors: Array<{ sessionId: string; error: Error }>;
}

/**
 * Persistent session storage for long-running agent sessions
 */
export class SessionStore {
  private readonly storagePath: string;
  private readonly fileExtension: string;
  private readonly completedSessionTtlMs: number;
  private readonly autoSaveIntervalMs: number;
  private readonly onAutoSaveError?: (sessionId: string, error: Error, consecutiveFailures: number) => void;
  private readonly maxConsecutiveAutoSaveFailures: number;

  // In-memory cache of active sessions
  private sessions: Map<string, SessionState> = new Map();
  private autoSaveTimers: Map<string, NodeJS.Timeout> = new Map();
  private initialized = false;

  // Mutex for protecting concurrent save operations per session
  private readonly saveMutex = new KeyedMutex();

  // Track consecutive auto-save failures per session
  private autoSaveFailures: Map<string, number> = new Map();

  constructor(config: SessionStoreConfig) {
    this.storagePath = config.storagePath;
    this.fileExtension = config.fileExtension ?? '.session.json';
    this.completedSessionTtlMs = config.completedSessionTtlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    this.autoSaveIntervalMs = config.autoSaveIntervalMs ?? 30000; // 30 seconds
    this.onAutoSaveError = config.onAutoSaveError;
    this.maxConsecutiveAutoSaveFailures = config.maxConsecutiveAutoSaveFailures ?? 5;
  }

  /**
   * Initialize the session store
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure storage directory exists
    try {
      await mkdir(this.storagePath, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }

    // Load any existing sessions
    await this.loadExistingSessions();

    this.initialized = true;
  }

  /**
   * Create a new session.
   *
   * @param params - Session creation parameters
   * @returns The newly created session state
   * @throws {Error} If storage directory cannot be created or session cannot be saved
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

    const session: SessionState = {
      id: randomUUID(),
      agentId: params.agentId,
      status: 'running',
      prompt: params.prompt,
      workingDirectory: params.workingDirectory,
      env: params.env,
      parentSessionId: params.parentSessionId,
      childSessionIds: [],
      currentTurn: 0,
      maxTurns: params.maxTurns,
      conversationHistory: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // If this is a child session, update parent
    if (params.parentSessionId) {
      const parent = this.sessions.get(params.parentSessionId);
      if (parent) {
        parent.childSessionIds.push(session.id);
        await this.saveSession(parent);
      }
    }

    this.sessions.set(session.id, session);
    await this.saveSession(session);

    // Start auto-save timer
    this.startAutoSave(session.id);

    console.log(`[SessionStore] Created session ${session.id} for agent ${params.agentId}`);

    return session;
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    await this.ensureInitialized();

    // Check memory cache first
    const cachedSession = this.sessions.get(sessionId);
    if (cachedSession) {
      return cachedSession;
    }

    // Try to load from disk
    const loadedSession = await this.loadSessionFromDisk(sessionId);
    if (loadedSession) {
      this.sessions.set(sessionId, loadedSession);
      return loadedSession;
    }

    return null;
  }

  /**
   * Update session status.
   *
   * @param sessionId - The session ID to update
   * @param status - The new session status
   * @throws {Error} If the session is not found
   */
  async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.status = status;
    session.updatedAt = new Date().toISOString();

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      session.completedAt = new Date().toISOString();
      this.stopAutoSave(sessionId);
    }

    await this.saveSession(session);
  }

  /**
   * Update session turn.
   *
   * @param sessionId - The session ID to update
   * @param turn - The new turn number
   * @throws {Error} If the session is not found
   */
  async updateTurn(sessionId: string, turn: number): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.currentTurn = turn;
    session.updatedAt = new Date().toISOString();

    await this.saveSession(session);
  }

  /**
   * Add message to conversation history.
   *
   * @param sessionId - The session ID to update
   * @param message - The message to add (timestamp will be set automatically)
   * @throws {Error} If the session is not found
   */
  async addMessage(sessionId: string, message: Omit<ConversationMessage, 'timestamp'>): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.conversationHistory.push({
      ...message,
      timestamp: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();

    await this.saveSession(session);
  }

  /**
   * Save checkpoint data for resumption.
   *
   * @param sessionId - The session ID to update
   * @param checkpoint - Checkpoint data (timestamp will be set automatically)
   * @throws {Error} If the session is not found
   */
  async saveCheckpoint(
    sessionId: string,
    checkpoint: Omit<CheckpointData, 'timestamp'>
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.checkpoint = {
      ...checkpoint,
      timestamp: new Date().toISOString(),
    };
    session.updatedAt = new Date().toISOString();

    await this.saveSession(session);
    console.log(`[SessionStore] Checkpoint saved for session ${sessionId} at turn ${checkpoint.lastTurn}`);
  }

  /**
   * Record tool call in checkpoint.
   *
   * Note: This method does not immediately save to disk; it relies on auto-save.
   *
   * @param sessionId - The session ID to update
   * @param toolCall - The tool call record to add
   * @throws {Error} If the session is not found
   */
  async recordToolCall(sessionId: string, toolCall: ToolCallRecord): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!session.checkpoint) {
      session.checkpoint = {
        lastTurn: session.currentTurn,
        toolCallHistory: [],
        timestamp: new Date().toISOString(),
      };
    }

    session.checkpoint.toolCallHistory.push(toolCall);
    session.checkpoint.timestamp = new Date().toISOString();
    session.updatedAt = new Date().toISOString();

    // Don't save immediately for tool calls - rely on auto-save
    this.sessions.set(sessionId, session);
  }

  /**
   * Set session error.
   *
   * @param sessionId - The session ID to update
   * @param error - Error information (lastRetryAt will be set automatically)
   * @throws {Error} If the session is not found
   */
  async setError(sessionId: string, error: Omit<SessionError, 'lastRetryAt'>): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.error = {
      ...error,
      lastRetryAt: new Date().toISOString(),
    };
    session.updatedAt = new Date().toISOString();

    await this.saveSession(session);
  }

  /**
   * Set session result and mark as completed.
   *
   * This method also stops auto-save for the session.
   *
   * @param sessionId - The session ID to update
   * @param result - The result string
   * @throws {Error} If the session is not found
   */
  async setResult(sessionId: string, result: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.result = result;
    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    session.updatedAt = new Date().toISOString();

    this.stopAutoSave(sessionId);
    await this.saveSession(session);
  }

  /**
   * List sessions with optional filters
   */
  async listSessions(filters?: {
    status?: SessionStatus[];
    agentId?: string;
    parentSessionId?: string | null;
  }): Promise<SessionState[]> {
    await this.ensureInitialized();

    let sessions = Array.from(this.sessions.values());

    if (filters?.status) {
      sessions = sessions.filter(s => filters.status!.includes(s.status));
    }

    if (filters?.agentId) {
      sessions = sessions.filter(s => s.agentId === filters.agentId);
    }

    if (filters?.parentSessionId !== undefined) {
      if (filters.parentSessionId === null) {
        sessions = sessions.filter(s => !s.parentSessionId);
      } else {
        sessions = sessions.filter(s => s.parentSessionId === filters.parentSessionId);
      }
    }

    return sessions.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();

    this.stopAutoSave(sessionId);
    this.sessions.delete(sessionId);

    const filePath = this.getSessionFilePath(sessionId);
    try {
      await unlink(filePath);
      console.log(`[SessionStore] Deleted session ${sessionId}`);
    } catch {
      // File might not exist
    }
  }

  /**
   * Clean up old completed sessions
   */
  async cleanupOldSessions(): Promise<number> {
    await this.ensureInitialized();

    const now = Date.now();
    let deletedCount = 0;

    for (const session of this.sessions.values()) {
      if (
        (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') &&
        session.completedAt
      ) {
        const completedTime = new Date(session.completedAt).getTime();
        if (now - completedTime > this.completedSessionTtlMs) {
          await this.deleteSession(session.id);
          deletedCount++;
        }
      }
    }

    console.log(`[SessionStore] Cleaned up ${deletedCount} old sessions`);
    return deletedCount;
  }

  /**
   * Get session file path with path traversal prevention
   *
   * @throws Error if session ID is invalid or contains path traversal patterns
   */
  private getSessionFilePath(sessionId: string): string {
    // Validate session ID to prevent path traversal
    const validation = validateSessionId(sessionId);
    if (!validation.allowed) {
      throw new Error(validation.reason ?? 'Invalid session ID');
    }

    // Additional safety: ensure the final path is within storagePath
    const filePath = join(this.storagePath, `${sessionId}${this.fileExtension}`);
    const normalizedPath = filePath;
    const normalizedStoragePath = this.storagePath;

    // Verify the path doesn't escape the storage directory
    if (!normalizedPath.startsWith(normalizedStoragePath)) {
      throw new Error('Invalid session ID: path traversal detected');
    }

    return filePath;
  }

  /**
   * Save session to disk with mutex protection and atomic writes.
   *
   * Uses a write-to-temp-then-rename pattern to prevent corruption
   * if the process crashes during write.
   */
  private async saveSession(session: SessionState): Promise<void> {
    const filePath = this.getSessionFilePath(session.id);

    // Use mutex to prevent concurrent saves to the same session
    await this.saveMutex.withLock(session.id, async () => {
      const tempPath = `${filePath}.tmp.${Date.now()}`;
      const content = JSON.stringify(session, null, 2);

      try {
        // Write to temp file first
        await writeFile(tempPath, content, 'utf-8');
        // Atomically rename temp to target (atomic on POSIX)
        await rename(tempPath, filePath);
      } catch (error) {
        // Clean up temp file if rename failed
        try {
          await unlink(tempPath);
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    });
  }

  /**
   * Load session from disk
   */
  private async loadSessionFromDisk(sessionId: string): Promise<SessionState | null> {
    const filePath = this.getSessionFilePath(sessionId);

    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as SessionState;
    } catch {
      return null;
    }
  }

  /**
   * Load existing sessions from disk
   */
  private async loadExistingSessions(): Promise<void> {
    try {
      const files = await readdir(this.storagePath);
      const sessionFiles = files.filter(f => f.endsWith(this.fileExtension));

      for (const file of sessionFiles) {
        const sessionId = file.replace(this.fileExtension, '');
        const session = await this.loadSessionFromDisk(sessionId);

        if (session) {
          this.sessions.set(session.id, session);

          // Restart auto-save for running/paused sessions
          if (session.status === 'running' || session.status === 'paused') {
            this.startAutoSave(session.id);
          }
        }
      }

      console.log(`[SessionStore] Loaded ${this.sessions.size} existing sessions`);
    } catch {
      // Directory might be empty or not exist yet
    }
  }

  /**
   * Start auto-save timer for a session.
   *
   * Auto-save errors are tracked and reported via the onAutoSaveError callback.
   * After maxConsecutiveAutoSaveFailures consecutive failures, auto-save is stopped
   * for that session to prevent spinning on persistent errors.
   */
  private startAutoSave(sessionId: string): void {
    this.stopAutoSave(sessionId);
    this.autoSaveFailures.delete(sessionId);

    const timer = setInterval(async () => {
      const session = this.sessions.get(sessionId);
      if (!session || (session.status !== 'running' && session.status !== 'paused')) {
        this.stopAutoSave(sessionId);
        return;
      }

      try {
        await this.saveSession(session);
        // Reset failure counter on success
        this.autoSaveFailures.delete(sessionId);
      } catch (error) {
        const consecutiveFailures = (this.autoSaveFailures.get(sessionId) ?? 0) + 1;
        this.autoSaveFailures.set(sessionId, consecutiveFailures);

        const err = error instanceof Error ? error : new Error(String(error));
        console.error(
          `[SessionStore] Auto-save failed for session ${sessionId} ` +
          `(attempt ${consecutiveFailures}/${this.maxConsecutiveAutoSaveFailures}):`,
          err.message
        );

        // Notify via callback if configured
        if (this.onAutoSaveError) {
          try {
            this.onAutoSaveError(sessionId, err, consecutiveFailures);
          } catch (callbackError) {
            // Don't let callback errors propagate
            console.error('[SessionStore] onAutoSaveError callback threw:', callbackError);
          }
        }

        // Stop auto-save after too many consecutive failures
        if (consecutiveFailures >= this.maxConsecutiveAutoSaveFailures) {
          console.error(
            `[SessionStore] Stopping auto-save for session ${sessionId} ` +
            `after ${consecutiveFailures} consecutive failures`
          );
          this.stopAutoSave(sessionId);
        }
      }
    }, this.autoSaveIntervalMs);

    this.autoSaveTimers.set(sessionId, timer);
  }

  /**
   * Stop auto-save timer for a session
   */
  private stopAutoSave(sessionId: string): void {
    const timer = this.autoSaveTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.autoSaveTimers.delete(sessionId);
    }
  }

  /**
   * Ensure store is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Shutdown - save all sessions and stop timers.
   *
   * This method continues saving all sessions even if some fail,
   * aggregating errors for later inspection.
   *
   * @returns ShutdownResult with success status and any errors encountered
   */
  async shutdown(): Promise<ShutdownResult> {
    const errors: Array<{ sessionId: string; error: Error }> = [];
    let sessionsSaved = 0;

    // Stop all auto-save timers first
    for (const sessionId of this.autoSaveTimers.keys()) {
      this.stopAutoSave(sessionId);
    }

    // Save all active sessions, collecting errors
    const savePromises = Array.from(this.sessions.values())
      .filter(session => session.status === 'running')
      .map(async (session) => {
        try {
          session.status = 'paused';
          session.updatedAt = new Date().toISOString();
          await this.saveSession(session);
          sessionsSaved++;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          errors.push({ sessionId: session.id, error: err });
          console.error(`[SessionStore] Failed to save session ${session.id} during shutdown:`, err.message);
        }
      });

    // Wait for all saves to complete (success or failure)
    await Promise.all(savePromises);

    // Clear failure tracking
    this.autoSaveFailures.clear();

    const success = errors.length === 0;
    console.log(
      `[SessionStore] Shutdown complete: ${sessionsSaved} sessions saved` +
      (errors.length > 0 ? `, ${errors.length} errors` : '')
    );

    return { success, sessionsSaved, errors };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

let defaultStore: SessionStore | null = null;

export function getSessionStore(config?: SessionStoreConfig): SessionStore {
  if (!defaultStore) {
    if (!config) {
      config = {
        storagePath: './.sessions',
      };
    }
    defaultStore = new SessionStore(config);
  }
  return defaultStore;
}

export function resetSessionStore(): void {
  if (defaultStore) {
    defaultStore.shutdown().catch(console.error);
  }
  defaultStore = null;
}
