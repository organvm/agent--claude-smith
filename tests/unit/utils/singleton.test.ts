/**
 * Singleton Factory and Mutex Unit Tests
 *
 * Tests for thread-safe singleton factories and mutex implementations.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createSingletonFactory,
  createSyncSingletonFactory,
  Mutex,
  KeyedMutex,
} from '../../../src/utils/singleton.js';

describe('createSingletonFactory', () => {
  it('should create a single instance', async () => {
    let createCount = 0;
    const factory = createSingletonFactory(() => {
      createCount++;
      return { id: createCount };
    });

    const instance1 = await factory();
    const instance2 = await factory();

    expect(instance1).toBe(instance2);
    expect(createCount).toBe(1);
    expect(instance1.id).toBe(1);
  });

  it('should call initialize function', async () => {
    const initFn = vi.fn().mockResolvedValue(undefined);
    const factory = createSingletonFactory(
      () => ({ initialized: false }),
      async (instance) => {
        instance.initialized = true;
        await initFn();
      }
    );

    const instance = await factory();

    expect(instance.initialized).toBe(true);
    expect(initFn).toHaveBeenCalledTimes(1);
  });

  it('should handle concurrent access during initialization', async () => {
    let createCount = 0;
    let initCount = 0;

    const factory = createSingletonFactory(
      () => {
        createCount++;
        return { id: createCount };
      },
      async () => {
        initCount++;
        // Simulate slow initialization
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    );

    // Start multiple concurrent requests
    const results = await Promise.all([
      factory(),
      factory(),
      factory(),
      factory(),
      factory(),
    ]);

    // All should get the same instance
    expect(results.every(r => r === results[0])).toBe(true);
    // Only one creation and initialization
    expect(createCount).toBe(1);
    expect(initCount).toBe(1);
  });

  it('should handle initialization failure', async () => {
    let attempts = 0;
    const factory = createSingletonFactory(
      () => ({ id: ++attempts }),
      async () => {
        throw new Error('Init failed');
      }
    );

    // First attempt should fail
    await expect(factory()).rejects.toThrow('Init failed');

    // After failure, initPromise is cleared, so next call tries again
    await expect(factory()).rejects.toThrow('Init failed');
    expect(attempts).toBe(2);
  });

  it('should work without initialize function', async () => {
    const factory = createSingletonFactory(() => ({ value: 42 }));

    const instance = await factory();

    expect(instance.value).toBe(42);
  });
});

describe('createSyncSingletonFactory', () => {
  it('should create a single instance synchronously', () => {
    let createCount = 0;
    const { get } = createSyncSingletonFactory(() => {
      createCount++;
      return { id: createCount };
    });

    const instance1 = get();
    const instance2 = get();

    expect(instance1).toBe(instance2);
    expect(createCount).toBe(1);
  });

  it('should reset the instance', () => {
    let createCount = 0;
    const { get, reset } = createSyncSingletonFactory(() => {
      createCount++;
      return { id: createCount };
    });

    const instance1 = get();
    expect(instance1.id).toBe(1);

    reset();

    const instance2 = get();
    expect(instance2.id).toBe(2);
    expect(createCount).toBe(2);
    expect(instance1).not.toBe(instance2);
  });
});

describe('Mutex', () => {
  it('should allow single holder', async () => {
    const mutex = new Mutex();

    expect(mutex.isLocked()).toBe(false);

    const release = await mutex.acquire();
    expect(mutex.isLocked()).toBe(true);

    release();
    expect(mutex.isLocked()).toBe(false);
  });

  it('should queue waiters', async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    // First acquire
    const release1 = await mutex.acquire();

    // Start two more acquires that will wait
    const promise2 = mutex.acquire().then(release => {
      order.push(2);
      return release;
    });

    const promise3 = mutex.acquire().then(release => {
      order.push(3);
      return release;
    });

    // Let the promises register
    await Promise.resolve();

    // Release first lock
    order.push(1);
    release1();

    // Wait for second to get lock and release it
    const release2 = await promise2;
    release2();

    // Wait for third to get lock
    const release3 = await promise3;
    release3();

    expect(order).toEqual([1, 2, 3]);
  });

  it('should serialize critical sections with withLock', async () => {
    const mutex = new Mutex();
    const results: number[] = [];

    const task = async (id: number) => {
      await mutex.withLock(async () => {
        results.push(id);
        await new Promise(resolve => setTimeout(resolve, 5));
        results.push(id * 10);
      });
    };

    // Start multiple concurrent tasks
    await Promise.all([
      task(1),
      task(2),
      task(3),
    ]);

    // Each task should complete atomically (id, then id*10)
    expect(results).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it('should release lock even on error', async () => {
    const mutex = new Mutex();

    await expect(
      mutex.withLock(async () => {
        throw new Error('Task failed');
      })
    ).rejects.toThrow('Task failed');

    expect(mutex.isLocked()).toBe(false);

    // Should be able to acquire again
    const release = await mutex.acquire();
    expect(mutex.isLocked()).toBe(true);
    release();
  });
});

describe('KeyedMutex', () => {
  it('should provide separate locks per key', async () => {
    const keyedMutex = new KeyedMutex();

    expect(keyedMutex.isLocked('a')).toBe(false);
    expect(keyedMutex.isLocked('b')).toBe(false);

    const releaseA = await keyedMutex.acquire('a');
    expect(keyedMutex.isLocked('a')).toBe(true);
    expect(keyedMutex.isLocked('b')).toBe(false);

    const releaseB = await keyedMutex.acquire('b');
    expect(keyedMutex.isLocked('a')).toBe(true);
    expect(keyedMutex.isLocked('b')).toBe(true);

    releaseA();
    expect(keyedMutex.isLocked('a')).toBe(false);
    expect(keyedMutex.isLocked('b')).toBe(true);

    releaseB();
    expect(keyedMutex.isLocked('a')).toBe(false);
    expect(keyedMutex.isLocked('b')).toBe(false);
  });

  it('should serialize access for same key', async () => {
    const keyedMutex = new KeyedMutex();
    const results: string[] = [];

    const task = async (key: string, id: string) => {
      await keyedMutex.withLock(key, async () => {
        results.push(`${key}:${id}:start`);
        await new Promise(resolve => setTimeout(resolve, 5));
        results.push(`${key}:${id}:end`);
      });
    };

    // Two tasks on same key should serialize
    await Promise.all([
      task('session-1', 'A'),
      task('session-1', 'B'),
    ]);

    // A should complete before B starts
    expect(results).toEqual([
      'session-1:A:start',
      'session-1:A:end',
      'session-1:B:start',
      'session-1:B:end',
    ]);
  });

  it('should allow parallel access for different keys', async () => {
    const keyedMutex = new KeyedMutex();
    const results: string[] = [];

    const task = async (key: string, id: string) => {
      await keyedMutex.withLock(key, async () => {
        results.push(`${key}:${id}:start`);
        await new Promise(resolve => setTimeout(resolve, 5));
        results.push(`${key}:${id}:end`);
      });
    };

    // Two tasks on different keys should run in parallel
    await Promise.all([
      task('session-1', 'A'),
      task('session-2', 'B'),
    ]);

    // Both should start before either ends (interleaved)
    expect(results[0]).toMatch(/start$/);
    expect(results[1]).toMatch(/start$/);
    expect(results[2]).toMatch(/end$/);
    expect(results[3]).toMatch(/end$/);
  });

  it('should cleanup unused locks', async () => {
    const keyedMutex = new KeyedMutex();

    // Acquire and release a lock
    const release1 = await keyedMutex.acquire('cleanup-test');
    release1();

    // Lock for another key that stays locked
    const release2 = await keyedMutex.acquire('active');

    // Both should exist
    expect(keyedMutex.isLocked('cleanup-test')).toBe(false);
    expect(keyedMutex.isLocked('active')).toBe(true);

    // Cleanup should remove unlocked ones
    keyedMutex.cleanup();

    // Active lock should still work
    expect(keyedMutex.isLocked('active')).toBe(true);
    release2();

    // Note: We can't directly test if 'cleanup-test' mutex was removed
    // since isLocked returns false for non-existent keys. But we verify
    // cleanup doesn't break the active lock.
  });

  it('should return false for non-existent key', () => {
    const keyedMutex = new KeyedMutex();
    expect(keyedMutex.isLocked('never-used')).toBe(false);
  });
});
