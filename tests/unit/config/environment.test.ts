/**
 * Environment Configuration Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadEnvironmentConfig,
  getEnvironmentConfigWithDefaults,
  validateConfig,
  resetEnvironmentConfig,
} from '../../../src/config/environment.js';

describe('Environment Configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset cached config before each test
    resetEnvironmentConfig();
    // Clear all relevant env vars
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_DEFAULT_MODEL;
    delete process.env.CLAUDE_SESSION_PATH;
    delete process.env.CLAUDE_WORKING_DIR;
    delete process.env.CLAUDE_MAX_TURNS;
    delete process.env.CLAUDE_MAX_EXECUTION_TIME_MS;
    delete process.env.CLAUDE_AUTO_SAVE_INTERVAL_MS;
    delete process.env.CLAUDE_SESSION_TTL_MS;
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    delete process.env.CLAUDE_AGENT_TEMPLATES;
    delete process.env.CLAUDE_LOG_LEVEL;
    delete process.env.CLAUDE_ENABLE_AUDIT_LOG;
    delete process.env.CLAUDE_MAX_CONCURRENT_AGENTS;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
    resetEnvironmentConfig();
  });

  describe('loadEnvironmentConfig', () => {
    it('should throw if ANTHROPIC_API_KEY is missing', () => {
      expect(() => loadEnvironmentConfig()).toThrow('ANTHROPIC_API_KEY is required');
    });

    it('should load config with valid API key', () => {
      process.env.ANTHROPIC_API_KEY = 'test-api-key';

      const config = loadEnvironmentConfig();

      expect(config.anthropicApiKey).toBe('test-api-key');
      expect(config.defaultModel).toBe('claude-sonnet-4-20250514');
      expect(config.maxTurns).toBe(100);
    });

    it('should use environment variable overrides', () => {
      process.env.ANTHROPIC_API_KEY = 'test-api-key';
      process.env.CLAUDE_DEFAULT_MODEL = 'claude-3-opus';
      process.env.CLAUDE_MAX_TURNS = '50';
      process.env.CLAUDE_LOG_LEVEL = 'debug';

      const config = loadEnvironmentConfig();

      expect(config.defaultModel).toBe('claude-3-opus');
      expect(config.maxTurns).toBe(50);
      expect(config.logLevel).toBe('debug');
    });

    it('should handle numeric environment variables', () => {
      process.env.ANTHROPIC_API_KEY = 'test-api-key';
      process.env.CLAUDE_MAX_TURNS = '200';
      process.env.CLAUDE_MAX_EXECUTION_TIME_MS = '600000';
      process.env.CLAUDE_MAX_CONCURRENT_AGENTS = '5';

      const config = loadEnvironmentConfig();

      expect(config.maxTurns).toBe(200);
      expect(config.maxExecutionTimeMs).toBe(600000);
      expect(config.maxConcurrentAgents).toBe(5);
    });

    it('should handle boolean environment variables', () => {
      process.env.ANTHROPIC_API_KEY = 'test-api-key';
      process.env.CLAUDE_ENABLE_AUDIT_LOG = 'false';

      const config = loadEnvironmentConfig();

      expect(config.enableAuditLog).toBe(false);
    });

    it('should throw for invalid log level', () => {
      process.env.ANTHROPIC_API_KEY = 'test-api-key';
      process.env.CLAUDE_LOG_LEVEL = 'invalid';

      expect(() => loadEnvironmentConfig()).toThrow();
    });

    it('should throw for invalid numeric values', () => {
      process.env.ANTHROPIC_API_KEY = 'test-api-key';
      process.env.CLAUDE_MAX_TURNS = 'not-a-number';

      expect(() => loadEnvironmentConfig()).toThrow();
    });
  });

  describe('getEnvironmentConfigWithDefaults', () => {
    it('should return config with defaults', () => {
      const config = getEnvironmentConfigWithDefaults();

      expect(config.defaultModel).toBe('claude-sonnet-4-20250514');
      expect(config.maxTurns).toBe(100);
      expect(config.logLevel).toBe('info');
      expect(config.enableAuditLog).toBe(true);
    });

    it('should apply overrides', () => {
      const config = getEnvironmentConfigWithDefaults({
        maxTurns: 50,
        logLevel: 'debug',
      });

      expect(config.maxTurns).toBe(50);
      expect(config.logLevel).toBe('debug');
    });

    it('should use env API key if available', () => {
      process.env.ANTHROPIC_API_KEY = 'env-api-key';

      const config = getEnvironmentConfigWithDefaults();

      expect(config.anthropicApiKey).toBe('env-api-key');
    });

    it('should use override API key over env', () => {
      process.env.ANTHROPIC_API_KEY = 'env-api-key';

      const config = getEnvironmentConfigWithDefaults({
        anthropicApiKey: 'override-key',
      });

      expect(config.anthropicApiKey).toBe('override-key');
    });
  });

  describe('validateConfig', () => {
    it('should validate a valid config', () => {
      const config = validateConfig({
        anthropicApiKey: 'test-key',
        defaultModel: 'claude-3',
        sessionStoragePath: './sessions',
        defaultWorkingDirectory: '/tmp',
        maxTurns: 100,
        maxExecutionTimeMs: 300000,
        autoSaveIntervalMs: 30000,
        completedSessionTtlMs: 86400000,
        logLevel: 'info',
        enableAuditLog: true,
        maxConcurrentAgents: 10,
      });

      expect(config.anthropicApiKey).toBe('test-key');
    });

    it('should throw for invalid config', () => {
      expect(() => validateConfig({
        anthropicApiKey: '', // Empty string is invalid
      })).toThrow();
    });

    it('should throw for negative maxTurns', () => {
      expect(() => validateConfig({
        anthropicApiKey: 'test-key',
        maxTurns: -1,
      })).toThrow();
    });
  });
});
