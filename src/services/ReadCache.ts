/**
 * ReadCache - mtime-based file read deduplication
 *
 * Caches metadata about file reads (NOT content) to detect when a file hasn't
 * changed since the last read. Returns a "File unchanged" stub instead of
 * re-reading, saving context tokens.
 *
 * Inspired by Claude Code's read deduplication which reports ~18% cache token savings.
 */

export interface ReadCacheEntry {
  filePath: string;
  mtimeMs: number;
  offset: number;
  limit: number;
  lineCount: number;
  totalLines: number;
  lastAccessTime: number;
}

const MAX_CACHE_SIZE = 200;

export class ReadCache {
  private cache = new Map<string, ReadCacheEntry>();

  /**
   * Build cache key from file path and read range
   */
  private key(filePath: string, offset: number, limit: number): string {
    return `${filePath}:${offset}:${limit}`;
  }

  /**
   * Check if a file read can be served from cache.
   * Returns the cached entry if the file hasn't been modified, null otherwise.
   */
  check(filePath: string, mtimeMs: number, offset: number, limit: number): ReadCacheEntry | null {
    const entry = this.cache.get(this.key(filePath, offset, limit));
    if (!entry) {
      return null;
    }
    // Stale if file was modified since last read
    if (entry.mtimeMs !== mtimeMs) {
      this.cache.delete(this.key(filePath, offset, limit));
      return null;
    }
    // Update access time for LRU
    entry.lastAccessTime = Date.now();
    return entry;
  }

  /**
   * Record a successful file read for future deduplication
   */
  record(entry: ReadCacheEntry): void {
    // Evict LRU if at capacity
    if (this.cache.size >= MAX_CACHE_SIZE) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, e] of this.cache) {
        if (e.lastAccessTime < oldestTime) {
          oldestTime = e.lastAccessTime;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(
      this.key(entry.filePath, entry.offset, entry.limit),
      { ...entry, lastAccessTime: Date.now() }
    );
  }

  /**
   * Invalidate all cache entries for a given file path (e.g., after a write/edit)
   */
  invalidate(filePath: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.filePath === filePath) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size (for testing/debugging)
   */
  get size(): number {
    return this.cache.size;
  }
}
