/**
 * Test Setup
 *
 * Global test configuration and utilities for vitest.
 */

import { beforeEach, afterEach, vi } from 'vitest';

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Global test utilities
export function createMockHookContext(overrides: Partial<{
  sessionId: string;
  agentId: string;
  turnNumber: number;
  workingDirectory: string;
  env: Record<string, string>;
}> = {}) {
  return {
    sessionId: overrides.sessionId ?? 'test-session-id',
    agentId: overrides.agentId ?? 'test-agent',
    turnNumber: overrides.turnNumber ?? 1,
    workingDirectory: overrides.workingDirectory ?? '/tmp/test',
    env: overrides.env ?? {},
  };
}

// Test file system helpers
export const TEST_TEMP_DIR = '/tmp/agent-claude-smith-tests';
