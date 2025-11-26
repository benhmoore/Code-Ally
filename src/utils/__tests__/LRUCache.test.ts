/**
 * Tests for LRU Cache implementation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LRUCache } from '@utils/LRUCache.js';

describe('LRUCache', () => {
  describe('constructor', () => {
    it('should create cache with specified capacity', () => {
      const cache = new LRUCache<string, number>(100);
      expect(cache.capacity).toBe(100);
      expect(cache.size).toBe(0);
    });

    it('should throw error for invalid max size', () => {
      expect(() => new LRUCache<string, number>(0)).toThrow('LRUCache maxSize must be a positive integer');
      expect(() => new LRUCache<string, number>(-1)).toThrow('LRUCache maxSize must be a positive integer');
      expect(() => new LRUCache<string, number>(1.5)).toThrow('LRUCache maxSize must be a positive integer');
    });
  });

  describe('set and get', () => {
    let cache: LRUCache<string, number>;

    beforeEach(() => {
      cache = new LRUCache<string, number>(3);
    });

    it('should store and retrieve values', () => {
      cache.set('key1', 100);
      expect(cache.get('key1')).toBe(100);
    });

    it('should return undefined for non-existent keys', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should update value for existing key', () => {
      cache.set('key1', 100);
      cache.set('key1', 200);
      expect(cache.get('key1')).toBe(200);
      expect(cache.size).toBe(1);
    });

    it('should track size correctly', () => {
      expect(cache.size).toBe(0);
      cache.set('key1', 1);
      expect(cache.size).toBe(1);
      cache.set('key2', 2);
      expect(cache.size).toBe(2);
      cache.set('key3', 3);
      expect(cache.size).toBe(3);
    });
  });

  describe('LRU eviction', () => {
    let cache: LRUCache<string, number>;

    beforeEach(() => {
      cache = new LRUCache<string, number>(3);
    });

    it('should evict least recently used item when at capacity', () => {
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);
      cache.set('key4', 4); // Should evict key1

      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBe(2);
      expect(cache.get('key3')).toBe(3);
      expect(cache.get('key4')).toBe(4);
      expect(cache.size).toBe(3);
    });

    it('should update recency on get', () => {
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);

      // Access key1 to make it most recently used
      cache.get('key1');

      // Add new item - should evict key2 (least recently used)
      cache.set('key4', 4);

      expect(cache.get('key1')).toBe(1);
      expect(cache.get('key2')).toBeUndefined();
      expect(cache.get('key3')).toBe(3);
      expect(cache.get('key4')).toBe(4);
    });

    it('should update recency on set with existing key', () => {
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);

      // Update key1 to make it most recently used
      cache.set('key1', 10);

      // Add new item - should evict key2
      cache.set('key4', 4);

      expect(cache.get('key1')).toBe(10);
      expect(cache.get('key2')).toBeUndefined();
      expect(cache.get('key3')).toBe(3);
      expect(cache.get('key4')).toBe(4);
    });
  });

  describe('has', () => {
    let cache: LRUCache<string, number>;

    beforeEach(() => {
      cache = new LRUCache<string, number>(3);
    });

    it('should return true for existing keys', () => {
      cache.set('key1', 1);
      expect(cache.has('key1')).toBe(true);
    });

    it('should return false for non-existent keys', () => {
      expect(cache.has('key1')).toBe(false);
    });

    it('should not affect recency (unlike get)', () => {
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);

      // has() should NOT update recency
      cache.has('key1');

      // Add new item - key1 should still be evicted
      cache.set('key4', 4);

      expect(cache.get('key1')).toBeUndefined();
    });
  });

  describe('delete', () => {
    let cache: LRUCache<string, number>;

    beforeEach(() => {
      cache = new LRUCache<string, number>(3);
    });

    it('should remove key and return true', () => {
      cache.set('key1', 1);
      expect(cache.delete('key1')).toBe(true);
      expect(cache.has('key1')).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('should return false for non-existent key', () => {
      expect(cache.delete('nonexistent')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all items', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeUndefined();
      expect(cache.get('key3')).toBeUndefined();
    });
  });

  describe('keys and values', () => {
    let cache: LRUCache<string, number>;

    beforeEach(() => {
      cache = new LRUCache<string, number>(5);
    });

    it('should return all keys in LRU order (oldest to newest)', () => {
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);

      expect(cache.keys()).toEqual(['key1', 'key2', 'key3']);
    });

    it('should return all values in LRU order', () => {
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);

      expect(cache.values()).toEqual([1, 2, 3]);
    });

    it('should reflect recency updates in keys/values order', () => {
      cache.set('key1', 1);
      cache.set('key2', 2);
      cache.set('key3', 3);

      // Access key1 to make it most recent
      cache.get('key1');

      expect(cache.keys()).toEqual(['key2', 'key3', 'key1']);
      expect(cache.values()).toEqual([2, 3, 1]);
    });
  });

  describe('edge cases', () => {
    it('should handle cache size of 1', () => {
      const cache = new LRUCache<string, number>(1);

      cache.set('key1', 1);
      expect(cache.get('key1')).toBe(1);

      cache.set('key2', 2);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBe(2);
    });

    it('should handle complex object values', () => {
      interface ComplexValue {
        data: string;
        nested: { count: number };
      }

      const cache = new LRUCache<string, ComplexValue>(3);
      const value: ComplexValue = { data: 'test', nested: { count: 42 } };

      cache.set('key1', value);
      const retrieved = cache.get('key1');

      expect(retrieved).toEqual(value);
      expect(retrieved).toBe(value); // Same reference
    });

    it('should handle various key types', () => {
      const cache = new LRUCache<number, string>(3);

      cache.set(1, 'one');
      cache.set(2, 'two');
      cache.set(3, 'three');

      expect(cache.get(1)).toBe('one');
      expect(cache.get(2)).toBe('two');
      expect(cache.get(3)).toBe('three');
    });

    it('should maintain correct state after multiple operations', () => {
      const cache = new LRUCache<string, number>(3);

      cache.set('a', 1);
      cache.set('b', 2);
      cache.get('a');
      cache.set('c', 3);
      cache.delete('b');
      cache.set('d', 4);
      cache.get('c');
      cache.set('e', 5);

      expect(cache.size).toBe(3);
      expect(cache.has('a')).toBe(false); // Evicted
      expect(cache.has('b')).toBe(false); // Deleted
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
      expect(cache.has('e')).toBe(true);
    });
  });
});
