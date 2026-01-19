/**
 * Circular Buffer and ExpiringMap Unit Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircularBuffer, ExpiringMap } from '../../../src/utils/circular-buffer.js';

describe('CircularBuffer', () => {
  describe('basic operations', () => {
    it('should store items up to capacity', () => {
      const buffer = new CircularBuffer<number>(3);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      expect(buffer.length).toBe(3);
      expect(buffer.toArray()).toEqual([1, 2, 3]);
    });

    it('should overwrite oldest items when full', () => {
      const buffer = new CircularBuffer<number>(3);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.push(4); // Overwrites 1

      expect(buffer.length).toBe(3);
      expect(buffer.toArray()).toEqual([2, 3, 4]);
    });

    it('should return overwritten item from push', () => {
      const buffer = new CircularBuffer<number>(2);
      expect(buffer.push(1)).toBeUndefined();
      expect(buffer.push(2)).toBeUndefined();
      expect(buffer.push(3)).toBe(1); // Returns overwritten value
    });

    it('should throw for invalid capacity', () => {
      expect(() => new CircularBuffer<number>(0)).toThrow('maxSize must be positive');
      expect(() => new CircularBuffer<number>(-1)).toThrow('maxSize must be positive');
    });
  });

  describe('get operations', () => {
    it('should get item by index (oldest = 0)', () => {
      const buffer = new CircularBuffer<string>(5);
      buffer.push('a');
      buffer.push('b');
      buffer.push('c');

      expect(buffer.get(0)).toBe('a');
      expect(buffer.get(1)).toBe('b');
      expect(buffer.get(2)).toBe('c');
    });

    it('should return undefined for out of bounds', () => {
      const buffer = new CircularBuffer<number>(5);
      buffer.push(1);

      expect(buffer.get(-1)).toBeUndefined();
      expect(buffer.get(1)).toBeUndefined();
      expect(buffer.get(100)).toBeUndefined();
    });

    it('should get oldest and newest', () => {
      const buffer = new CircularBuffer<number>(3);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      expect(buffer.oldest()).toBe(1);
      expect(buffer.newest()).toBe(3);

      buffer.push(4); // Overwrites 1

      expect(buffer.oldest()).toBe(2);
      expect(buffer.newest()).toBe(4);
    });

    it('should return undefined for oldest/newest on empty buffer', () => {
      const buffer = new CircularBuffer<number>(3);

      expect(buffer.oldest()).toBeUndefined();
      expect(buffer.newest()).toBeUndefined();
    });
  });

  describe('status methods', () => {
    it('should report isFull correctly', () => {
      const buffer = new CircularBuffer<number>(2);

      expect(buffer.isFull()).toBe(false);
      buffer.push(1);
      expect(buffer.isFull()).toBe(false);
      buffer.push(2);
      expect(buffer.isFull()).toBe(true);
    });

    it('should report isEmpty correctly', () => {
      const buffer = new CircularBuffer<number>(2);

      expect(buffer.isEmpty()).toBe(true);
      buffer.push(1);
      expect(buffer.isEmpty()).toBe(false);
    });

    it('should report capacity', () => {
      const buffer = new CircularBuffer<number>(10);
      expect(buffer.capacity).toBe(10);
    });
  });

  describe('clear', () => {
    it('should clear all items', () => {
      const buffer = new CircularBuffer<number>(5);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      buffer.clear();

      expect(buffer.length).toBe(0);
      expect(buffer.isEmpty()).toBe(true);
      expect(buffer.toArray()).toEqual([]);
    });
  });

  describe('iteration and filtering', () => {
    it('should iterate in order (oldest to newest)', () => {
      const buffer = new CircularBuffer<number>(3);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      const items: number[] = [];
      for (const item of buffer) {
        items.push(item);
      }

      expect(items).toEqual([1, 2, 3]);
    });

    it('should filter items', () => {
      const buffer = new CircularBuffer<number>(5);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.push(4);
      buffer.push(5);

      const evens = buffer.filter(n => n % 2 === 0);
      expect(evens).toEqual([2, 4]);
    });

    it('should find first matching item', () => {
      const buffer = new CircularBuffer<number>(5);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      expect(buffer.find(n => n > 1)).toBe(2);
      expect(buffer.find(n => n > 10)).toBeUndefined();
    });

    it('should execute forEach callback', () => {
      const buffer = new CircularBuffer<number>(3);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      const results: Array<{ item: number; index: number }> = [];
      buffer.forEach((item, index) => {
        results.push({ item, index });
      });

      expect(results).toEqual([
        { item: 1, index: 0 },
        { item: 2, index: 1 },
        { item: 3, index: 2 },
      ]);
    });
  });

  describe('lastN and firstN', () => {
    it('should get last N items', () => {
      const buffer = new CircularBuffer<number>(5);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);
      buffer.push(4);
      buffer.push(5);

      expect(buffer.lastN(2)).toEqual([4, 5]);
      expect(buffer.lastN(5)).toEqual([1, 2, 3, 4, 5]);
      expect(buffer.lastN(10)).toEqual([1, 2, 3, 4, 5]); // More than available
    });

    it('should get first N items', () => {
      const buffer = new CircularBuffer<number>(5);
      buffer.push(1);
      buffer.push(2);
      buffer.push(3);

      expect(buffer.firstN(2)).toEqual([1, 2]);
      expect(buffer.firstN(5)).toEqual([1, 2, 3]); // More than available
    });
  });

  describe('wraparound behavior', () => {
    it('should correctly handle multiple wraparounds', () => {
      const buffer = new CircularBuffer<number>(3);

      // Fill and wrap multiple times
      for (let i = 1; i <= 10; i++) {
        buffer.push(i);
      }

      // Should contain last 3 items
      expect(buffer.toArray()).toEqual([8, 9, 10]);
      expect(buffer.oldest()).toBe(8);
      expect(buffer.newest()).toBe(10);
    });
  });
});

describe('ExpiringMap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic operations', () => {
    it('should store and retrieve values', () => {
      const map = new ExpiringMap<string, number>(60000);

      map.set('a', 1);
      map.set('b', 2);

      expect(map.get('a')).toBe(1);
      expect(map.get('b')).toBe(2);
    });

    it('should return undefined for non-existent keys', () => {
      const map = new ExpiringMap<string, number>(60000);

      expect(map.get('missing')).toBeUndefined();
    });

    it('should check existence with has', () => {
      const map = new ExpiringMap<string, number>(60000);

      map.set('a', 1);

      expect(map.has('a')).toBe(true);
      expect(map.has('b')).toBe(false);
    });

    it('should delete entries', () => {
      const map = new ExpiringMap<string, number>(60000);

      map.set('a', 1);
      expect(map.delete('a')).toBe(true);
      expect(map.get('a')).toBeUndefined();
      expect(map.delete('a')).toBe(false);
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', () => {
      const map = new ExpiringMap<string, number>(1000); // 1 second TTL

      map.set('a', 1);
      expect(map.get('a')).toBe(1);

      // Advance time past TTL
      vi.advanceTimersByTime(1001);

      expect(map.get('a')).toBeUndefined();
      expect(map.has('a')).toBe(false);
    });

    it('should not expire entries before TTL', () => {
      const map = new ExpiringMap<string, number>(1000);

      map.set('a', 1);

      // Advance time but not past TTL
      vi.advanceTimersByTime(500);

      expect(map.get('a')).toBe(1);
    });
  });

  describe('max size', () => {
    it('should evict oldest entry when at capacity', () => {
      const map = new ExpiringMap<string, number>(60000, 2);

      map.set('a', 1);
      map.set('b', 2);
      map.set('c', 3); // Should evict 'a'

      expect(map.get('a')).toBeUndefined();
      expect(map.get('b')).toBe(2);
      expect(map.get('c')).toBe(3);
    });

    it('should prefer evicting expired entries first', () => {
      const map = new ExpiringMap<string, number>(1000, 3);

      map.set('a', 1);
      vi.advanceTimersByTime(500);
      map.set('b', 2);
      vi.advanceTimersByTime(600); // 'a' is now expired

      map.set('c', 3);
      map.set('d', 4); // Should cleanup expired 'a' first

      // 'a' expired and was cleaned up, b, c, d should exist
      expect(map.get('a')).toBeUndefined();
      expect(map.get('b')).toBe(2);
      expect(map.get('c')).toBe(3);
      expect(map.get('d')).toBe(4);
    });
  });

  describe('cleanup', () => {
    it('should remove all expired entries', () => {
      const map = new ExpiringMap<string, number>(1000);

      map.set('a', 1);
      map.set('b', 2);
      vi.advanceTimersByTime(500);
      map.set('c', 3); // Added later, expires later

      vi.advanceTimersByTime(600); // 'a' and 'b' expired, 'c' still valid

      map.cleanup();

      expect(map.size).toBe(1);
      expect(map.get('c')).toBe(3);
    });
  });

  describe('clear and destroy', () => {
    it('should clear all entries', () => {
      const map = new ExpiringMap<string, number>(60000);

      map.set('a', 1);
      map.set('b', 2);

      map.clear();

      expect(map.size).toBe(0);
      expect(map.get('a')).toBeUndefined();
    });

    it('should stop auto cleanup on destroy', () => {
      const map = new ExpiringMap<string, number>(1000, Infinity, 500);

      map.set('a', 1);
      map.destroy();

      // After destroy, auto-cleanup should be stopped
      // This test mainly ensures destroy doesn't throw
      expect(map.get('a')).toBe(1);
    });
  });
});
