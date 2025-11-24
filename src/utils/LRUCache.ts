/**
 * LRU (Least Recently Used) Cache
 *
 * A generic cache implementation that evicts the least recently used items
 * when the cache reaches its maximum capacity. Uses a Map for O(1) lookups
 * and a doubly-linked list structure (via Map ordering) for O(1) eviction.
 *
 * @template K - The type of cache keys
 * @template V - The type of cached values
 *
 * @example
 * ```typescript
 * const cache = new LRUCache<string, ParsedNode[]>(200);
 * cache.set('key1', value1);
 * const value = cache.get('key1'); // Returns value1
 * cache.has('key1'); // Returns true
 * cache.clear(); // Removes all entries
 * ```
 */
export class LRUCache<K, V> {
  /** Internal storage using Map (preserves insertion order) */
  private cache: Map<K, V>;

  /** Maximum number of items to store */
  private readonly maxSize: number;

  /**
   * Create a new LRU Cache
   *
   * @param maxSize - Maximum number of items to store (must be > 0)
   * @throws {Error} If maxSize is not a positive integer
   */
  constructor(maxSize: number) {
    if (maxSize <= 0 || !Number.isInteger(maxSize)) {
      throw new Error('LRUCache maxSize must be a positive integer');
    }

    this.maxSize = maxSize;
    this.cache = new Map<K, V>();
  }

  /**
   * Get a value from the cache
   *
   * Accessing an item marks it as recently used (moves to end of eviction queue).
   *
   * @param key - The key to look up
   * @returns The cached value, or undefined if not found
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key);

    if (value !== undefined) {
      // Move to end (most recently used) by deleting and re-inserting
      this.cache.delete(key);
      this.cache.set(key, value);
    }

    return value;
  }

  /**
   * Store a value in the cache
   *
   * If the cache is at capacity, the least recently used item will be evicted.
   * If the key already exists, its value is updated and it's marked as recently used.
   *
   * @param key - The key to store under
   * @param value - The value to cache
   */
  set(key: K, value: V): void {
    // If key exists, delete it first (we'll re-add to mark as most recent)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Cache is full - evict least recently used (first item in Map)
      const firstKey = this.cache.keys().next().value as K;
      // Defensive check: Map with size > 0 always has first key
      // This check prevents edge cases during cache operations
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    // Add to end (most recently used)
    this.cache.set(key, value);
  }

  /**
   * Check if a key exists in the cache
   *
   * Note: This does NOT update the item's recency (use get() for that).
   *
   * @param key - The key to check
   * @returns True if the key exists in the cache
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Clear all items from the cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the current number of items in the cache
   *
   * @returns The number of cached items
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get the maximum capacity of the cache
   *
   * @returns The maximum number of items this cache can hold
   */
  get capacity(): number {
    return this.maxSize;
  }

  /**
   * Remove a specific key from the cache
   *
   * @param key - The key to remove
   * @returns True if the key was removed, false if it didn't exist
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Get all keys currently in the cache (in LRU order: oldest to newest)
   *
   * @returns An array of cache keys
   */
  keys(): K[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get all values currently in the cache (in LRU order: oldest to newest)
   *
   * @returns An array of cached values
   */
  values(): V[] {
    return Array.from(this.cache.values());
  }
}
