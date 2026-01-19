/**
 * Circular Buffer Implementation
 *
 * A fixed-size buffer that overwrites old entries when full.
 * Provides O(1) insertion and maintains chronological order.
 */

/**
 * A circular buffer for storing fixed-size collections with automatic eviction.
 *
 * When the buffer is full, adding new items overwrites the oldest items.
 * This is useful for:
 * - Audit logs that need bounded memory
 * - Recent history tracking
 * - Rolling metrics collection
 *
 * @example
 * ```typescript
 * const buffer = new CircularBuffer<LogEntry>(100);
 * buffer.push({ timestamp: Date.now(), message: 'Hello' });
 *
 * // Get all items in order (oldest to newest)
 * for (const entry of buffer) {
 *   console.log(entry);
 * }
 * ```
 */
export class CircularBuffer<T> {
  private readonly buffer: Array<T | undefined>;
  private readonly maxSize: number;
  private head = 0;  // Next write position
  private count = 0; // Current number of items

  /**
   * Create a new circular buffer.
   * @param maxSize Maximum number of items to store
   */
  constructor(maxSize: number) {
    if (maxSize <= 0) {
      throw new Error('CircularBuffer maxSize must be positive');
    }
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
  }

  /**
   * Add an item to the buffer.
   * If full, the oldest item is overwritten.
   * @returns The overwritten item if any, undefined otherwise
   */
  push(item: T): T | undefined {
    const overwritten = this.isFull() ? this.buffer[this.head] : undefined;

    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.maxSize;

    if (this.count < this.maxSize) {
      this.count++;
    }

    return overwritten;
  }

  /**
   * Get an item by index (0 = oldest, count-1 = newest).
   */
  get(index: number): T | undefined {
    if (index < 0 || index >= this.count) {
      return undefined;
    }
    const actualIndex = this.getActualIndex(index);
    return this.buffer[actualIndex];
  }

  /**
   * Get the oldest item.
   */
  oldest(): T | undefined {
    if (this.count === 0) return undefined;
    return this.get(0);
  }

  /**
   * Get the newest item.
   */
  newest(): T | undefined {
    if (this.count === 0) return undefined;
    return this.get(this.count - 1);
  }

  /**
   * Convert actual array index to logical index.
   */
  private getActualIndex(logicalIndex: number): number {
    if (this.count < this.maxSize) {
      return logicalIndex;
    }
    return (this.head + logicalIndex) % this.maxSize;
  }

  /**
   * Get the current number of items in the buffer.
   */
  get length(): number {
    return this.count;
  }

  /**
   * Get the maximum capacity of the buffer.
   */
  get capacity(): number {
    return this.maxSize;
  }

  /**
   * Check if the buffer is full.
   */
  isFull(): boolean {
    return this.count === this.maxSize;
  }

  /**
   * Check if the buffer is empty.
   */
  isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Clear all items from the buffer.
   */
  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.count = 0;
  }

  /**
   * Convert to array (oldest to newest).
   */
  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i);
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * Filter items and return matching ones.
   */
  filter(predicate: (item: T) => boolean): T[] {
    return this.toArray().filter(predicate);
  }

  /**
   * Find the first item matching a predicate.
   */
  find(predicate: (item: T) => boolean): T | undefined {
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i);
      if (item !== undefined && predicate(item)) {
        return item;
      }
    }
    return undefined;
  }

  /**
   * Iterate over items (oldest to newest).
   */
  *[Symbol.iterator](): Iterator<T> {
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i);
      if (item !== undefined) {
        yield item;
      }
    }
  }

  /**
   * Execute a callback for each item.
   */
  forEach(callback: (item: T, index: number) => void): void {
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i);
      if (item !== undefined) {
        callback(item, i);
      }
    }
  }

  /**
   * Get the last N items (newest).
   */
  lastN(n: number): T[] {
    const start = Math.max(0, this.count - n);
    const result: T[] = [];
    for (let i = start; i < this.count; i++) {
      const item = this.get(i);
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * Get the first N items (oldest).
   */
  firstN(n: number): T[] {
    const result: T[] = [];
    const count = Math.min(n, this.count);
    for (let i = 0; i < count; i++) {
      const item = this.get(i);
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }
}

/**
 * Expiring cache entry with TTL.
 */
interface ExpiringEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * A map with automatic TTL-based expiration.
 *
 * Entries automatically expire after the TTL and are cleaned up lazily.
 *
 * @example
 * ```typescript
 * const cache = new ExpiringMap<string, number>(60000); // 1 minute TTL
 * cache.set('key', 42);
 *
 * // After 1 minute, the entry expires
 * cache.get('key'); // undefined
 * ```
 */
export class ExpiringMap<K, V> {
  private readonly map = new Map<K, ExpiringEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  /**
   * Create a new expiring map.
   * @param ttlMs Time-to-live for entries in milliseconds
   * @param maxSize Maximum number of entries (oldest expired first)
   * @param autoCleanupInterval How often to run cleanup (0 = no auto cleanup)
   */
  constructor(ttlMs: number, maxSize: number = Infinity, autoCleanupInterval: number = 0) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;

    if (autoCleanupInterval > 0) {
      this.cleanupInterval = setInterval(() => this.cleanup(), autoCleanupInterval);
    }
  }

  /**
   * Set a value in the map.
   */
  set(key: K, value: V): void {
    // Cleanup before adding if at capacity
    if (this.map.size >= this.maxSize) {
      this.cleanup();
      // If still at capacity, remove oldest
      if (this.map.size >= this.maxSize) {
        const oldestKey = this.map.keys().next().value;
        if (oldestKey !== undefined) {
          this.map.delete(oldestKey);
        }
      }
    }

    this.map.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Get a value from the map.
   * Returns undefined if expired or not found.
   */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a key from the map.
   */
  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /**
   * Get the current size (including expired entries).
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.map.clear();
  }

  /**
   * Remove all expired entries.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now > entry.expiresAt) {
        this.map.delete(key);
      }
    }
  }

  /**
   * Stop automatic cleanup.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
