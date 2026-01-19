/**
 * Orchestrator Unit Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Orchestrator, getOrchestrator, resetOrchestrator } from '../../../src/core/orchestrator.js';
import { AgentRegistry, resetAgentRegistry } from '../../../src/core/agent-registry.js';
import { resetSessionStore } from '../../../src/persistence/session-store.js';
import type { ExtendedAgentDefinition, AgentSpawnRequest } from '../../../src/agents/types.js';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        id: 'msg_test123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Mock response from Claude' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  })),
}));

function createTestAgent(id: string, overrides: Partial<ExtendedAgentDefinition> = {}): ExtendedAgentDefinition {
  return {
    id,
    name: `Test Agent ${id}`,
    description: 'A test agent',
    category: 'task-execution',
    capabilities: ['execute-commands'],
    systemPrompt: 'You are a test agent.',
    tools: [{ name: 'Bash', enabled: true }],
    retryConfig: {
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
      retryableErrors: ['RATE_LIMIT'],
    },
    secretRefs: [],
    maxExecutionTimeMs: 300000,
    maxTurns: 20,
    canSpawnSubagents: false,
    ...overrides,
  };
}

describe('Orchestrator', () => {
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    // Reset all singletons
    resetOrchestrator();
    resetAgentRegistry();
    resetSessionStore();

    // Create fresh orchestrator
    orchestrator = new Orchestrator({
      config: {
        sessionStoragePath: '/tmp/test-sessions',
        defaultWorkingDirectory: '/tmp',
        globalEnv: { ANTHROPIC_API_KEY: 'test-key' },
      },
    });

    // Register test agents
    const registry = orchestrator.getRegistry();
    registry.register(createTestAgent('agent-1'));
    registry.register(createTestAgent('agent-2'));
    registry.register(createTestAgent('agent-3'));

    await orchestrator.initialize();
  });

  afterEach(async () => {
    await orchestrator.shutdown();
  });

  describe('spawnAgent', () => {
    it('should spawn an agent and return result', async () => {
      const request: AgentSpawnRequest = {
        agentId: 'agent-1',
        prompt: 'Test prompt',
      };

      const result = await orchestrator.spawnAgent(request);

      expect(result.agentId).toBe('agent-1');
      expect(result.status).toBe('success');
      expect(result.result).toBe('Mock response from Claude');
      expect(result.turnsTaken).toBeGreaterThan(0);
      expect(result.executionTimeMs).toBeGreaterThan(0);
    });

    it('should return error for non-existent agent', async () => {
      const request: AgentSpawnRequest = {
        agentId: 'non-existent',
        prompt: 'Test prompt',
      };

      const result = await orchestrator.spawnAgent(request);

      expect(result.status).toBe('error');
      expect(result.error).toContain('Agent not found');
    });

    it('should create session for each spawn', async () => {
      const result = await orchestrator.spawnAgent({
        agentId: 'agent-1',
        prompt: 'Test prompt',
      });

      expect(result.sessionId).toBeDefined();
      expect(result.sessionId).not.toBe('no-session');
    });
  });

  describe('spawnParallel', () => {
    it('should spawn multiple agents in parallel and return all results', async () => {
      const requests: AgentSpawnRequest[] = [
        { agentId: 'agent-1', prompt: 'Task 1' },
        { agentId: 'agent-2', prompt: 'Task 2' },
        { agentId: 'agent-3', prompt: 'Task 3' },
      ];

      const results = await orchestrator.spawnParallel(requests);

      // All results should be returned
      expect(results).toHaveLength(3);
      // Each agent should have a result with a valid session ID
      expect(results.every(r => r.sessionId)).toBe(true);
    });

    it('should respect maxConcurrent limit', async () => {
      const requests: AgentSpawnRequest[] = [
        { agentId: 'agent-1', prompt: 'Task 1' },
        { agentId: 'agent-2', prompt: 'Task 2' },
        { agentId: 'agent-3', prompt: 'Task 3' },
      ];

      const results = await orchestrator.spawnParallel(requests, { maxConcurrent: 1 });

      expect(results).toHaveLength(3);
    });

    it('should handle non-existent agents', async () => {
      const requests: AgentSpawnRequest[] = [
        { agentId: 'non-existent', prompt: 'Task' },
      ];

      const results = await orchestrator.spawnParallel(requests);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('error');
      expect(results[0].error).toContain('Agent not found');
    });

    // Fixed in Phase 6: Results are now returned in request order
    it('should return results in request order', async () => {
      const requests: AgentSpawnRequest[] = [
        { agentId: 'agent-1', prompt: 'Task 1' },
        { agentId: 'agent-2', prompt: 'Task 2' },
        { agentId: 'agent-3', prompt: 'Task 3' },
      ];

      const results = await orchestrator.spawnParallel(requests);

      expect(results[0].agentId).toBe('agent-1');
      expect(results[1].agentId).toBe('agent-2');
      expect(results[2].agentId).toBe('agent-3');
    });
  });

  describe('cancelAgent', () => {
    it('should return false for non-existent session', async () => {
      const cancelled = await orchestrator.cancelAgent('non-existent-session');
      expect(cancelled).toBe(false);
    });
  });

  describe('getRegistry', () => {
    it('should return the agent registry', () => {
      const registry = orchestrator.getRegistry();
      expect(registry).toBeInstanceOf(AgentRegistry);
      expect(registry.has('agent-1')).toBe(true);
    });
  });

  describe('getAuditLog', () => {
    it('should return audit log entries', async () => {
      await orchestrator.spawnAgent({
        agentId: 'agent-1',
        prompt: 'Test',
      });

      const log = orchestrator.getAuditLog();
      expect(Array.isArray(log)).toBe(true);
    });
  });

  describe('Singleton management', () => {
    it('should return same instance from getOrchestrator', () => {
      const o1 = getOrchestrator();
      const o2 = getOrchestrator();
      expect(o1).toBe(o2);
    });

    it('should return new instance after reset', () => {
      const o1 = getOrchestrator();
      resetOrchestrator();
      const o2 = getOrchestrator();
      expect(o1).not.toBe(o2);
    });
  });
});
