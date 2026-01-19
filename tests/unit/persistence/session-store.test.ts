/**
 * SessionStore Unit Tests
 *
 * Tests for persistent session storage with auto-save, caching, and atomic writes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionState, SessionStatus } from '../../../src/agents/types.js';

// Use vi.hoisted to create the mock state before hoisting
const { cryptoMocks, mockRandomUUID } = vi.hoisted(() => {
  const state = {
    currentUUID: '12345678-1234-4234-a234-123456789abc',
  };
  return {
    cryptoMocks: state,
    mockRandomUUID: vi.fn(() => state.currentUUID),
  };
});

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
}));

// Mock crypto randomUUID function
vi.mock('crypto', () => ({
  randomUUID: mockRandomUUID,
}));

// Import mocks after setting up
import { readFile, writeFile, readdir, unlink, mkdir, rename } from 'fs/promises';

// Import session-store after mocking
import {
  SessionStore,
  getSessionStore,
  resetSessionStore,
  type ShutdownResult,
} from '../../../src/persistence/session-store.js';

// Suppress console output in tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('SessionStore', () => {
  const defaultConfig = {
    storagePath: '/tmp/test-sessions',
    autoSaveIntervalMs: 100,
    completedSessionTtlMs: 1000,
  };

  const mockReadFile = readFile as ReturnType<typeof vi.fn>;
  const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
  const mockReaddir = readdir as ReturnType<typeof vi.fn>;
  const mockUnlink = unlink as ReturnType<typeof vi.fn>;
  const mockMkdir = mkdir as ReturnType<typeof vi.fn>;
  const mockRename = rename as ReturnType<typeof vi.fn>;

  // Helper to set the next UUID that will be generated
  function setNextUUID(uuid: string): void {
    cryptoMocks.currentUUID = uuid;
    mockRandomUUID.mockImplementation(() => cryptoMocks.currentUUID);
  }

  let store: SessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Default mock implementations
    mockMkdir.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);

    // Reset default UUID and re-establish mock implementation after clearAllMocks
    cryptoMocks.currentUUID = '12345678-1234-4234-a234-123456789abc';
    mockRandomUUID.mockImplementation(() => cryptoMocks.currentUUID);

    store = new SessionStore(defaultConfig);
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetSessionStore();
  });

  describe('initialize', () => {
    it('should create storage directory', async () => {
      await store.initialize();

      expect(mockMkdir).toHaveBeenCalledWith('/tmp/test-sessions', { recursive: true });
    });

    it('should load existing sessions from disk', async () => {
      const existingSession: SessionState = {
        id: '33333333-3333-4333-a333-333333333333',
        agentId: 'agent-1',
        status: 'paused',
        prompt: 'test',
        workingDirectory: '/tmp',
        env: {},
        childSessionIds: [],
        currentTurn: 5,
        maxTurns: 20,
        conversationHistory: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockReaddir.mockResolvedValue(['33333333-3333-4333-a333-333333333333.session.json']);
      mockReadFile.mockResolvedValue(JSON.stringify(existingSession));

      await store.initialize();

      const session = await store.getSession('33333333-3333-4333-a333-333333333333');
      expect(session).not.toBeNull();
      expect(session?.id).toBe('33333333-3333-4333-a333-333333333333');
    });

    it('should only initialize once', async () => {
      await store.initialize();
      await store.initialize();

      expect(mockMkdir).toHaveBeenCalledTimes(1);
    });

    it('should handle mkdir errors gracefully', async () => {
      mockMkdir.mockRejectedValue(new Error('Permission denied'));

      // Should not throw
      await expect(store.initialize()).resolves.not.toThrow();
    });
  });

  describe('createSession', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should create a new session with generated ID', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test prompt',
        workingDirectory: '/tmp/work',
        env: { KEY: 'value' },
        maxTurns: 10,
      });

      expect(session.id).toBe('12345678-1234-4234-a234-123456789abc');
      expect(session.agentId).toBe('test-agent');
      expect(session.prompt).toBe('Test prompt');
      expect(session.status).toBe('running');
      expect(session.currentTurn).toBe(0);
    });

    it('should save session to disk', async () => {
      await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test prompt',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockRename).toHaveBeenCalled();
    });

    it('should link child to parent session', async () => {
      // Create parent first
      setNextUUID('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
      const parent = await store.createSession({
        agentId: 'parent-agent',
        prompt: 'Parent prompt',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      // Create child
      setNextUUID('bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb');
      const child = await store.createSession({
        agentId: 'child-agent',
        prompt: 'Child prompt',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 5,
        parentSessionId: parent.id,
      });

      expect(child.parentSessionId).toBe('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');

      // Parent should have child in list
      const updatedParent = await store.getSession('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
      expect(updatedParent?.childSessionIds).toContain('bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb');
    });

    it('should start auto-save timer', async () => {
      await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      // Clear initial save calls
      mockWriteFile.mockClear();
      mockRename.mockClear();

      // Advance past auto-save interval
      await vi.advanceTimersByTimeAsync(150);

      // Should have auto-saved
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('getSession', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should return cached session', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      mockReadFile.mockClear();

      const retrieved = await store.getSession(session.id);
      expect(retrieved).toBe(session); // Same object reference
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('should load from disk if not in cache', async () => {
      const onDiskSession: SessionState = {
        id: '44444444-4444-4444-a444-444444444444',
        agentId: 'agent',
        status: 'paused',
        prompt: 'test',
        workingDirectory: '/tmp',
        env: {},
        childSessionIds: [],
        currentTurn: 0,
        maxTurns: 10,
        conversationHistory: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockReadFile.mockResolvedValue(JSON.stringify(onDiskSession));

      const session = await store.getSession('44444444-4444-4444-a444-444444444444');

      expect(session).not.toBeNull();
      expect(session?.id).toBe('44444444-4444-4444-a444-444444444444');
    });

    it('should return null for non-existent session', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const session = await store.getSession('88888888-8888-4888-a888-888888888888');
      expect(session).toBeNull();
    });
  });

  describe('updateStatus', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should update session status', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.updateStatus(session.id, 'paused');

      const updated = await store.getSession(session.id);
      expect(updated?.status).toBe('paused');
    });

    it('should set completedAt for terminal statuses', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.updateStatus(session.id, 'completed');

      const updated = await store.getSession(session.id);
      expect(updated?.completedAt).toBeDefined();
    });

    it('should stop auto-save on completion', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.updateStatus(session.id, 'completed');

      mockWriteFile.mockClear();
      mockRename.mockClear();

      // Advance time
      await vi.advanceTimersByTimeAsync(200);

      // No auto-save should occur
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should throw for non-existent session', async () => {
      await expect(store.updateStatus('99999999-9999-4999-a999-999999999999', 'completed')).rejects.toThrow('Session not found');
    });
  });

  describe('updateTurn', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should update turn number', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.updateTurn(session.id, 5);

      const updated = await store.getSession(session.id);
      expect(updated?.currentTurn).toBe(5);
    });

    it('should throw for non-existent session', async () => {
      await expect(store.updateTurn('99999999-9999-4999-a999-999999999999', 1)).rejects.toThrow('Session not found');
    });
  });

  describe('addMessage', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should add message with timestamp', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.addMessage(session.id, {
        role: 'user',
        content: 'Hello',
      });

      const updated = await store.getSession(session.id);
      expect(updated?.conversationHistory).toHaveLength(1);
      expect(updated?.conversationHistory[0].content).toBe('Hello');
      expect(updated?.conversationHistory[0].timestamp).toBeDefined();
    });

    it('should throw for non-existent session', async () => {
      await expect(
        store.addMessage('99999999-9999-4999-a999-999999999999', { role: 'user', content: 'test' })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('saveCheckpoint', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should save checkpoint with timestamp', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.saveCheckpoint(session.id, {
        lastTurn: 3,
        toolCallHistory: [],
      });

      const updated = await store.getSession(session.id);
      expect(updated?.checkpoint).toBeDefined();
      expect(updated?.checkpoint?.lastTurn).toBe(3);
      expect(updated?.checkpoint?.timestamp).toBeDefined();
    });

    it('should throw for non-existent session', async () => {
      await expect(
        store.saveCheckpoint('99999999-9999-4999-a999-999999999999', { lastTurn: 1, toolCallHistory: [] })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('recordToolCall', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should record tool call in checkpoint', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.recordToolCall(session.id, {
        tool: 'Bash',
        input: 'ls -la',
        output: 'file1 file2',
        timestamp: new Date().toISOString(),
      });

      const updated = await store.getSession(session.id);
      expect(updated?.checkpoint?.toolCallHistory).toHaveLength(1);
      expect(updated?.checkpoint?.toolCallHistory[0].tool).toBe('Bash');
    });

    it('should create checkpoint if not exists', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      expect(session.checkpoint).toBeUndefined();

      await store.recordToolCall(session.id, {
        tool: 'Read',
        input: '/tmp/file',
        output: 'content',
        timestamp: new Date().toISOString(),
      });

      const updated = await store.getSession(session.id);
      expect(updated?.checkpoint).toBeDefined();
    });
  });

  describe('setError', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should set error with retry timestamp', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.setError(session.id, {
        message: 'Something went wrong',
        code: 'TEST_ERROR',
        retryCount: 1,
      });

      const updated = await store.getSession(session.id);
      expect(updated?.error?.message).toBe('Something went wrong');
      expect(updated?.error?.lastRetryAt).toBeDefined();
    });

    it('should throw for non-existent session', async () => {
      await expect(
        store.setError('99999999-9999-4999-a999-999999999999', { message: 'error', code: 'ERR', retryCount: 0 })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('setResult', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should set result and mark as completed', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.setResult(session.id, 'Task completed successfully');

      const updated = await store.getSession(session.id);
      expect(updated?.result).toBe('Task completed successfully');
      expect(updated?.status).toBe('completed');
      expect(updated?.completedAt).toBeDefined();
    });

    it('should stop auto-save', async () => {
      const session = await store.createSession({
        agentId: 'test-agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.setResult(session.id, 'Done');

      mockWriteFile.mockClear();
      mockRename.mockClear();

      await vi.advanceTimersByTimeAsync(200);

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should throw for non-existent session', async () => {
      await expect(store.setResult('99999999-9999-4999-a999-999999999999', 'result')).rejects.toThrow('Session not found');
    });
  });

  describe('listSessions', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should list all sessions', async () => {
      setNextUUID('11111111-1111-4111-a111-111111111111');
      await store.createSession({
        agentId: 'agent-1',
        prompt: 'Test 1',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      setNextUUID('22222222-2222-4222-a222-222222222222');
      await store.createSession({
        agentId: 'agent-2',
        prompt: 'Test 2',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it('should filter by status', async () => {
      setNextUUID('cccccccc-cccc-4ccc-accc-cccccccccccc');
      await store.createSession({
        agentId: 'agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      setNextUUID('dddddddd-dddd-4ddd-addd-dddddddddddd');
      const completed = await store.createSession({
        agentId: 'agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });
      await store.setResult(completed.id, 'Done');

      const running = await store.listSessions({ status: ['running'] });
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe('cccccccc-cccc-4ccc-accc-cccccccccccc');
    });

    it('should filter by agentId', async () => {
      setNextUUID('11111111-1111-4111-a111-111111111111');
      await store.createSession({
        agentId: 'agent-a',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      setNextUUID('22222222-2222-4222-a222-222222222222');
      await store.createSession({
        agentId: 'agent-b',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      const sessions = await store.listSessions({ agentId: 'agent-a' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].agentId).toBe('agent-a');
    });

    it('should filter by parentSessionId null', async () => {
      setNextUUID('eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee');
      const parent = await store.createSession({
        agentId: 'agent',
        prompt: 'Parent',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      setNextUUID('ffffffff-ffff-4fff-afff-ffffffffffff');
      await store.createSession({
        agentId: 'agent',
        prompt: 'Child',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 5,
        parentSessionId: parent.id,
      });

      const topLevel = await store.listSessions({ parentSessionId: null });
      expect(topLevel).toHaveLength(1);
      expect(topLevel[0].id).toBe('eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee');
    });

    it('should filter by specific parentSessionId', async () => {
      setNextUUID('eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee');
      const parent = await store.createSession({
        agentId: 'agent',
        prompt: 'Parent',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      setNextUUID('ffffffff-ffff-4fff-afff-ffffffffffff');
      await store.createSession({
        agentId: 'agent',
        prompt: 'Child',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 5,
        parentSessionId: parent.id,
      });

      const children = await store.listSessions({ parentSessionId: 'eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee' });
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe('ffffffff-ffff-4fff-afff-ffffffffffff');
    });

    it('should sort by updatedAt descending', async () => {
      setNextUUID('00000000-0000-4000-a000-000000000001');
      await store.createSession({
        agentId: 'agent',
        prompt: 'Older',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      // Advance time
      vi.advanceTimersByTime(100);

      setNextUUID('00000000-0000-4000-a000-000000000002');
      await store.createSession({
        agentId: 'agent',
        prompt: 'Newer',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      const sessions = await store.listSessions();
      expect(sessions[0].id).toBe('00000000-0000-4000-a000-000000000002');
      expect(sessions[1].id).toBe('00000000-0000-4000-a000-000000000001');
    });
  });

  describe('deleteSession', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should delete session from memory and disk', async () => {
      const session = await store.createSession({
        agentId: 'agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.deleteSession(session.id);

      const retrieved = await store.getSession(session.id);
      expect(retrieved).toBeNull();
      expect(mockUnlink).toHaveBeenCalled();
    });

    it('should stop auto-save', async () => {
      const session = await store.createSession({
        agentId: 'agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.deleteSession(session.id);

      mockWriteFile.mockClear();
      await vi.advanceTimersByTimeAsync(200);

      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('should handle file not found gracefully', async () => {
      mockUnlink.mockRejectedValue(new Error('ENOENT'));

      const session = await store.createSession({
        agentId: 'agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      // Should not throw
      await expect(store.deleteSession(session.id)).resolves.not.toThrow();
    });
  });

  describe('cleanupOldSessions', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should delete sessions past TTL', async () => {
      setNextUUID('00000000-0000-4000-a000-000000000003');
      const session = await store.createSession({
        agentId: 'agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.setResult(session.id, 'Done');

      // Advance past TTL
      vi.advanceTimersByTime(2000);

      const deleted = await store.cleanupOldSessions();
      expect(deleted).toBe(1);
    });

    it('should not delete running sessions', async () => {
      await store.createSession({
        agentId: 'agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      vi.advanceTimersByTime(2000);

      const deleted = await store.cleanupOldSessions();
      expect(deleted).toBe(0);
    });

    it('should not delete recently completed sessions', async () => {
      const session = await store.createSession({
        agentId: 'agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.setResult(session.id, 'Done');

      // Advance but not past TTL
      vi.advanceTimersByTime(500);

      const deleted = await store.cleanupOldSessions();
      expect(deleted).toBe(0);
    });
  });

  describe('auto-save error handling', () => {
    it('should call onAutoSaveError callback on failure', async () => {
      const onError = vi.fn();
      const storeWithCallback = new SessionStore({
        ...defaultConfig,
        onAutoSaveError: onError,
      });

      await storeWithCallback.initialize();

      await storeWithCallback.createSession({
        agentId: 'agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      // Make save fail
      mockWriteFile.mockRejectedValue(new Error('Disk full'));

      await vi.advanceTimersByTimeAsync(150);

      expect(onError).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Error),
        1
      );
    });

    it('should stop auto-save after max consecutive failures', async () => {
      const storeWithLowMax = new SessionStore({
        ...defaultConfig,
        maxConsecutiveAutoSaveFailures: 2,
      });

      await storeWithLowMax.initialize();

      await storeWithLowMax.createSession({
        agentId: 'agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      mockWriteFile.mockRejectedValue(new Error('Persistent failure'));

      // First failure
      await vi.advanceTimersByTimeAsync(150);
      // Second failure - should stop
      await vi.advanceTimersByTimeAsync(150);

      mockWriteFile.mockClear();

      // No more saves should occur
      await vi.advanceTimersByTimeAsync(300);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should save all running sessions as paused', async () => {
      setNextUUID('11111111-1111-4111-a111-111111111111');
      await store.createSession({
        agentId: 'agent',
        prompt: 'Test 1',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      setNextUUID('22222222-2222-4222-a222-222222222222');
      await store.createSession({
        agentId: 'agent',
        prompt: 'Test 2',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      const result = await store.shutdown();

      expect(result.success).toBe(true);
      expect(result.sessionsSaved).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it('should aggregate errors without stopping', async () => {
      setNextUUID('11111111-1111-4111-a111-111111111111');
      await store.createSession({
        agentId: 'agent',
        prompt: 'Test 1',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      setNextUUID('22222222-2222-4222-a222-222222222222');
      await store.createSession({
        agentId: 'agent',
        prompt: 'Test 2',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      // Make ALL subsequent saves fail (shutdown saves)
      mockWriteFile.mockRejectedValue(new Error('Write failed'));

      const result = await store.shutdown();

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should stop all auto-save timers', async () => {
      await store.createSession({
        agentId: 'agent',
        prompt: 'Test',
        workingDirectory: '/tmp',
        env: {},
        maxTurns: 10,
      });

      await store.shutdown();

      mockWriteFile.mockClear();
      mockRename.mockClear();

      await vi.advanceTimersByTimeAsync(200);

      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('path traversal prevention', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should reject invalid session IDs', async () => {
      await expect(store.getSession('../../../etc/passwd')).rejects.toThrow();
      await expect(store.getSession('session/../../../etc/passwd')).rejects.toThrow();
      await expect(store.getSession('session\x00evil')).rejects.toThrow();
    });
  });
});

describe('Singleton functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionStore();
    // Re-establish mock implementation after clearAllMocks
    cryptoMocks.currentUUID = '12345678-1234-4234-a234-123456789abc';
    mockRandomUUID.mockImplementation(() => cryptoMocks.currentUUID);
  });

  describe('getSessionStore', () => {
    it('should return singleton instance', () => {
      const store1 = getSessionStore();
      const store2 = getSessionStore();
      expect(store1).toBe(store2);
    });

    it('should use default config if none provided', () => {
      const store = getSessionStore();
      expect(store).toBeDefined();
    });
  });

  describe('resetSessionStore', () => {
    it('should reset singleton', () => {
      const store1 = getSessionStore();
      resetSessionStore();
      const store2 = getSessionStore();
      expect(store1).not.toBe(store2);
    });
  });
});
