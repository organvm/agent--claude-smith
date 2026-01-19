/**
 * Thread-Safe Singleton Factory
 *
 * Provides utilities for creating singletons with proper initialization
 * handling to prevent race conditions when multiple callers try to
 * access an uninitialized singleton simultaneously.
 */

/**
 * Creates a thread-safe singleton factory.
 *
 * This ensures that even if multiple callers try to get the singleton
 * before it's initialized, only one initialization will occur and all
 * callers will receive the same instance.
 *
 * @example
 * ```typescript
 * const getDatabase = createSingletonFactory(
 *   () => new Database(),
 *   (db) => db.connect()
 * );
 *
 * // Safe to call from multiple places - only one instance created
 * const db = await getDatabase();
 * ```
 */
export function createSingletonFactory<T>(
  create: () => T,
  initialize?: (instance: T) => Promise<void>
): () => Promise<T> {
  let instance: T | null = null;
  let initPromise: Promise<T> | null = null;

  return async (): Promise<T> => {
    // If already initialized, return immediately
    if (instance !== null) {
      return instance;
    }

    // If initialization is in progress, wait for it
    if (initPromise !== null) {
      return initPromise;
    }

    // Start initialization
    initPromise = (async () => {
      const newInstance = create();

      if (initialize) {
        await initialize(newInstance);
      }

      instance = newInstance;
      return newInstance;
    })();

    try {
      return await initPromise;
    } finally {
      // Clear the promise after resolution (success or failure)
      initPromise = null;
    }
  };
}

/**
 * Creates a simple synchronous singleton factory.
 *
 * Use this for singletons that don't require async initialization.
 */
export function createSyncSingletonFactory<T>(create: () => T): {
  get: () => T;
  reset: () => void;
} {
  let instance: T | null = null;

  return {
    get: (): T => {
      if (instance === null) {
        instance = create();
      }
      return instance;
    },
    reset: (): void => {
      instance = null;
    },
  };
}

/**
 * Mutex implementation for coordinating async operations.
 *
 * @example
 * ```typescript
 * const mutex = new Mutex();
 *
 * async function criticalSection() {
 *   const release = await mutex.acquire();
 *   try {
 *     // Only one caller can be here at a time
 *     await doSomething();
 *   } finally {
 *     release();
 *   }
 * }
 * ```
 */
export class Mutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  /**
   * Acquire the mutex lock.
   * Returns a release function that must be called when done.
   */
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    // Wait for the lock to be released
    return new Promise<() => void>((resolve) => {
      this.waitQueue.push(() => {
        this.locked = true;
        resolve(() => this.release());
      });
    });
  }

  /**
   * Release the mutex lock.
   */
  private release(): void {
    if (this.waitQueue.length > 0) {
      // Give the lock to the next waiter
      const next = this.waitQueue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * Check if the mutex is currently locked.
   */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Execute a function while holding the lock.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * A keyed mutex that provides separate locks per key.
 * Useful for protecting per-session or per-resource operations.
 */
export class KeyedMutex {
  private locks = new Map<string, Mutex>();

  /**
   * Get or create a mutex for the given key.
   */
  private getMutex(key: string): Mutex {
    let mutex = this.locks.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.locks.set(key, mutex);
    }
    return mutex;
  }

  /**
   * Acquire a lock for the given key.
   */
  async acquire(key: string): Promise<() => void> {
    return this.getMutex(key).acquire();
  }

  /**
   * Execute a function while holding the lock for the given key.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.getMutex(key).withLock(fn);
  }

  /**
   * Check if a specific key is locked.
   */
  isLocked(key: string): boolean {
    const mutex = this.locks.get(key);
    return mutex?.isLocked() ?? false;
  }

  /**
   * Clean up unused locks.
   */
  cleanup(): void {
    for (const [key, mutex] of this.locks.entries()) {
      if (!mutex.isLocked()) {
        this.locks.delete(key);
      }
    }
  }
}
