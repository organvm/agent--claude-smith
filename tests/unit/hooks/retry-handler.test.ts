/**
 * Retry Handler Unit Tests
 *
 * Tests for exponential backoff retry logic, error classification,
 * and retry decision making.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  RetryHandler,
  createRetryHandler,
  withRetry,
  isRetryableError,
  type ErrorClassification,
  type RetryDecision,
} from '../../../src/hooks/retry-handler.js';
import type { RetryConfig } from '../../../src/agents/types.js';

// Mock console.log to avoid noise in tests
vi.spyOn(console, 'log').mockImplementation(() => {});

describe('RetryHandler', () => {
  const defaultConfig: RetryConfig = {
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['RATE_LIMIT', 'TIMEOUT', 'NETWORK_ERROR'],
  };

  let handler: RetryHandler;

  beforeEach(() => {
    handler = new RetryHandler(defaultConfig);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('classifyError', () => {
    describe('transient errors', () => {
      const transientPatterns = [
        { input: 'Rate limit exceeded', expected: 'transient' },
        { input: 'Error 429: Too many requests', expected: 'transient' },
        { input: 'Request timeout', expected: 'transient' },
        { input: 'ETIMEDOUT: Connection timed out', expected: 'transient' },
        { input: 'ECONNRESET: Connection reset', expected: 'transient' },
        { input: 'ECONNREFUSED: Connection refused', expected: 'transient' },
        { input: 'Network error occurred', expected: 'transient' },
        { input: 'Temporary failure', expected: 'transient' },
        { input: 'Service unavailable', expected: 'transient' },
        { input: 'Error 503', expected: 'transient' },
        { input: 'Error 502: Bad Gateway', expected: 'transient' },
        { input: 'Error 504: Gateway timeout', expected: 'transient' },
        { input: 'Server overloaded', expected: 'transient' },
      ];

      it.each(transientPatterns)('should classify "$input" as transient', ({ input, expected }) => {
        expect(handler.classifyError(input)).toBe(expected);
        expect(handler.classifyError(new Error(input))).toBe(expected);
      });
    });

    describe('recoverable errors', () => {
      const recoverablePatterns = [
        { input: 'ENOENT: file not found', expected: 'recoverable' },
        { input: 'Resource not found', expected: 'recoverable' },
        { input: 'EACCES: permission denied', expected: 'recoverable' },
        { input: 'Permission denied for path', expected: 'recoverable' },
        { input: 'Invalid input provided', expected: 'recoverable' },
        { input: 'Validation error: field missing', expected: 'recoverable' },
        { input: 'Missing parameter: id', expected: 'recoverable' },
        { input: 'Error 400: Bad request', expected: 'recoverable' },
        { input: 'Error 404', expected: 'recoverable' },
      ];

      it.each(recoverablePatterns)('should classify "$input" as recoverable', ({ input, expected }) => {
        expect(handler.classifyError(input)).toBe(expected);
      });
    });

    describe('permanent errors', () => {
      const permanentPatterns = [
        { input: 'Authentication failed', expected: 'permanent' },
        { input: 'Unauthorized access', expected: 'permanent' },
        { input: 'Forbidden: Access denied', expected: 'permanent' },
        { input: 'Error 401', expected: 'permanent' },
        { input: 'Error 403: Forbidden', expected: 'permanent' },
        { input: 'Invalid API key', expected: 'permanent' },
        { input: 'Invalid token provided', expected: 'permanent' },
        { input: 'Quota exceeded', expected: 'permanent' },
        { input: 'Billing issue: payment required', expected: 'permanent' },
      ];

      it.each(permanentPatterns)('should classify "$input" as permanent', ({ input, expected }) => {
        expect(handler.classifyError(input)).toBe(expected);
      });
    });

    describe('unknown errors', () => {
      it('should classify unrecognized errors as unknown', () => {
        expect(handler.classifyError('Something went wrong')).toBe('unknown');
        expect(handler.classifyError('Generic error')).toBe('unknown');
        expect(handler.classifyError(new Error('Unexpected failure'))).toBe('unknown');
      });
    });
  });

  describe('shouldRetry', () => {
    it('should not retry when max attempts reached', () => {
      const decision = handler.shouldRetry('rate limit error', 3);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain('Max attempts');
      expect(decision.delayMs).toBe(0);
    });

    it('should not retry permanent errors', () => {
      const decision = handler.shouldRetry('Authentication failed', 1);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.classification).toBe('permanent');
      expect(decision.reason).toContain('Permanent error');
    });

    it('should retry transient errors', () => {
      const decision = handler.shouldRetry('rate limit exceeded', 1);

      expect(decision.shouldRetry).toBe(true);
      expect(decision.classification).toBe('transient');
      expect(decision.delayMs).toBeGreaterThan(0);
    });

    it('should retry errors in retryableErrors list', () => {
      const decision = handler.shouldRetry('RATE_LIMIT: please retry', 1);

      expect(decision.shouldRetry).toBe(true);
    });

    it('should not retry non-retryable errors that are not transient', () => {
      // Create handler with limited retryable errors
      const strictHandler = new RetryHandler({
        ...defaultConfig,
        retryableErrors: ['SPECIFIC_ERROR'],
      });

      // A recoverable error not in the retryable list
      const decision = strictHandler.shouldRetry('file not found', 1);

      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain('not in retryable list');
    });

    it('should include attempt info in reason', () => {
      const decision = handler.shouldRetry('timeout error', 2);

      expect(decision.reason).toContain('attempt 3/3');
    });
  });

  describe('calculateDelay', () => {
    it('should calculate exponential backoff', () => {
      // Use real timers for delay calculation
      vi.useRealTimers();

      // Mock Math.random to eliminate jitter for predictable tests
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const delay1 = handler.calculateDelay(1);
      const delay2 = handler.calculateDelay(2);
      const delay3 = handler.calculateDelay(3);

      // Base: 100ms, multiplier: 2
      // Attempt 1: 100 * 2^0 = 100ms
      // Attempt 2: 100 * 2^1 = 200ms
      // Attempt 3: 100 * 2^2 = 400ms
      expect(delay1).toBe(100);
      expect(delay2).toBe(200);
      expect(delay3).toBe(400);
    });

    it('should respect max delay', () => {
      vi.useRealTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      // With high attempt number, should hit max
      const delay = handler.calculateDelay(10);

      expect(delay).toBeLessThanOrEqual(defaultConfig.maxDelayMs);
    });

    it('should add jitter', () => {
      vi.useRealTimers();

      // Test with different random values
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const delayLow = handler.calculateDelay(1);

      vi.spyOn(Math, 'random').mockReturnValue(1);
      const delayHigh = handler.calculateDelay(1);

      // Should differ by jitter (±20% of base)
      expect(delayLow).not.toBe(delayHigh);
      // Both should be within 20% of 100ms base
      expect(delayLow).toBeGreaterThanOrEqual(80);
      expect(delayHigh).toBeLessThanOrEqual(120);
    });
  });

  describe('executeWithRetry', () => {
    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const resultPromise = handler.executeWithRetry(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on transient failure then succeed', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue('success');

      const resultPromise = handler.executeWithRetry(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw after max attempts exhausted', async () => {
      vi.useRealTimers(); // Use real timers to avoid unhandled rejection issues

      // Use short delays for test speed
      const fastHandler = new RetryHandler({
        ...defaultConfig,
        initialDelayMs: 1,
        maxDelayMs: 5,
      });

      const fn = vi.fn().mockRejectedValue(new Error('rate limit'));

      await expect(fastHandler.executeWithRetry(fn)).rejects.toThrow('rate limit');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should throw immediately on permanent error', async () => {
      vi.useRealTimers();

      const fn = vi.fn().mockRejectedValue(new Error('authentication failed'));

      await expect(handler.executeWithRetry(fn)).rejects.toThrow('authentication failed');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should call onRetry callback', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue('success');
      const onRetry = vi.fn();

      const resultPromise = handler.executeWithRetry(fn, { onRetry });
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(
        expect.any(Error),
        1,
        expect.any(Number)
      );
    });

    it('should convert non-Error to Error', async () => {
      vi.useRealTimers();

      // Permanent error so it doesn't retry
      const fn = vi.fn().mockRejectedValue('authentication failed');

      await expect(handler.executeWithRetry(fn)).rejects.toThrow('authentication failed');
    });

    it('should update stats during execution', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue('success');

      const resultPromise = handler.executeWithRetry(fn);
      await vi.runAllTimersAsync();
      await resultPromise;

      const stats = handler.getStats();
      expect(stats.totalAttempts).toBe(2);
      expect(stats.successfulAttempts).toBe(1);
      expect(stats.failedAttempts).toBe(1);
      expect(stats.retriedOperations).toBe(1);
    });
  });

  describe('getStats', () => {
    it('should return copy of stats', async () => {
      const fn = vi.fn().mockResolvedValue('ok');

      const resultPromise = handler.executeWithRetry(fn);
      await vi.runAllTimersAsync();
      await resultPromise;

      const stats1 = handler.getStats();
      const stats2 = handler.getStats();

      // Should be equal but not same object
      expect(stats1).toEqual(stats2);
      expect(stats1).not.toBe(stats2);
    });

    it('should track cumulative stats', async () => {
      const fn = vi.fn().mockResolvedValue('ok');

      for (let i = 0; i < 3; i++) {
        const resultPromise = handler.executeWithRetry(fn);
        await vi.runAllTimersAsync();
        await resultPromise;
      }

      const stats = handler.getStats();
      expect(stats.totalAttempts).toBe(3);
      expect(stats.successfulAttempts).toBe(3);
    });
  });

  describe('resetStats', () => {
    it('should reset all stats to zero', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue('ok');

      const resultPromise = handler.executeWithRetry(fn);
      await vi.runAllTimersAsync();
      await resultPromise;

      handler.resetStats();

      const stats = handler.getStats();
      expect(stats.totalAttempts).toBe(0);
      expect(stats.successfulAttempts).toBe(0);
      expect(stats.failedAttempts).toBe(0);
      expect(stats.retriedOperations).toBe(0);
      expect(stats.totalDelayMs).toBe(0);
    });
  });
});

describe('createRetryHandler', () => {
  it('should create handler with default config', () => {
    const handler = createRetryHandler();

    // Verify defaults are applied
    const decision = handler.shouldRetry('RATE_LIMIT error', 1);
    expect(decision.shouldRetry).toBe(true);
  });

  it('should merge custom config with defaults', () => {
    const handler = createRetryHandler({
      maxAttempts: 5,
      retryableErrors: ['CUSTOM_ERROR'],
    });

    // Should retry CUSTOM_ERROR
    const decision = handler.shouldRetry('CUSTOM_ERROR occurred', 1);
    expect(decision.shouldRetry).toBe(true);

    // Max attempts should be 5
    const decision5 = handler.shouldRetry('CUSTOM_ERROR', 5);
    expect(decision5.shouldRetry).toBe(false);
    expect(decision5.reason).toContain('Max attempts (5)');
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should be a convenience wrapper for one-off operations', async () => {
    const fn = vi.fn().mockResolvedValue('result');

    const resultPromise = withRetry(fn);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('result');
  });

  it('should accept custom config', async () => {
    vi.useRealTimers();

    const fn = vi.fn().mockRejectedValue(new Error('CUSTOM_ERROR'));

    await expect(
      withRetry(fn, {
        maxAttempts: 2,
        initialDelayMs: 1,
        maxDelayMs: 5,
        retryableErrors: ['CUSTOM_ERROR'],
      })
    ).rejects.toThrow('CUSTOM_ERROR');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('isRetryableError', () => {
  it('should return true for transient errors', () => {
    expect(isRetryableError('timeout error')).toBe(true);
    expect(isRetryableError(new Error('rate limit'))).toBe(true);
    expect(isRetryableError('ECONNRESET')).toBe(true);
  });

  it('should return true for unknown errors', () => {
    expect(isRetryableError('some unknown error')).toBe(true);
  });

  it('should return false for permanent errors', () => {
    expect(isRetryableError('authentication failed')).toBe(false);
    expect(isRetryableError(new Error('401 unauthorized'))).toBe(false);
  });

  it('should return false for recoverable errors', () => {
    // Recoverable errors are not auto-retried (they need different input)
    expect(isRetryableError('file not found')).toBe(false);
    expect(isRetryableError('validation error')).toBe(false);
  });
});
