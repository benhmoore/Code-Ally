/**
 * ReadCache - mtime-based file read deduplication
 *
 * Caches metadata about file reads (NOT content) to detect when a file hasn't
 * changed since the last read. Returns a "File unchanged" stub instead of
 * re-reading, saving context tokens.
 *
 * Inspired by Claude Code's read deduplication which reports ~18% cache token savings.
 */

export interface ReadSelection {
  lineOffset: number;
  lineLimit: number;
  columnOffset: number;
  columnLimit: number;
}

export interface ReadCacheEntry {
  /** Scope that owns the cached read (usually an agent instance ID) */
  scopeId?: string;
  filePath: string;
  mtimeMs: number;
  selection: ReadSelection;
  lineCount: number;
  totalLines: number;
  lastAccessTime: number;
  /**
   * The tool call whose result message carried the file content into the
   * conversation. A cache hit is only truthful while that message is still in
   * the model's active context — compaction can remove it, at which point the
   * "content already in conversation" stub becomes a lie that strands the
   * model without the file and without a way to re-read it.
   */
  toolCallId?: string;
}

const MAX_CACHE_SIZE = 200;
const DEFAULT_SCOPE_ID = 'default';

export class ReadCache {
  private cache = new Map<string, ReadCacheEntry>();

  /**
   * Build cache key from file path and read range
   */
  private key(
    scopeId: string | undefined,
    filePath: string,
    selection: ReadSelection,
  ): string {
    const { lineOffset, lineLimit, columnOffset, columnLimit } = selection;
    return `${scopeId ?? DEFAULT_SCOPE_ID}:${filePath}:${lineOffset}:${lineLimit}:${columnOffset}:${columnLimit}`;
  }

  /**
   * Check if a file read can be served from cache.
   * Returns the cached entry if the file hasn't been modified, null otherwise.
   */
  check(
    filePath: string,
    mtimeMs: number,
    selection: ReadSelection,
    scopeId?: string,
  ): ReadCacheEntry | null {
    const key = this.key(scopeId, filePath, selection);
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }
    // Stale if file was modified since last read
    if (entry.mtimeMs !== mtimeMs) {
      this.cache.delete(key);
      return null;
    }
    // Update access time for LRU
    entry.lastAccessTime = Date.now();
    return entry;
  }

  /**
   * Record a successful file read for future deduplication
   */
  record(entry: ReadCacheEntry, scopeId?: string): void {
    const normalizedScopeId = entry.scopeId ?? scopeId ?? DEFAULT_SCOPE_ID;

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
      this.key(normalizedScopeId, entry.filePath, entry.selection),
      { ...entry, scopeId: normalizedScopeId, lastAccessTime: Date.now() }
    );
  }

  /**
   * Invalidate cache entries for a given file path after a mutation.
   * If no scope is provided, all scoped entries for that file are invalidated.
   */
  invalidate(filePath: string, scopeId?: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.filePath === filePath && (!scopeId || entry.scopeId === scopeId)) {
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
