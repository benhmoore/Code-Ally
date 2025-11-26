/**
 * Content Hashing Utility
 *
 * Provides fast, non-cryptographic hash functions for string content.
 * Uses the FNV-1a algorithm which provides excellent distribution and
 * collision resistance for hash table/cache use cases.
 *
 * FNV-1a (Fowler-Noll-Vo) is chosen for:
 * - Fast computation (simple operations)
 * - Good avalanche properties (small changes → different hashes)
 * - Low collision rate for similar strings
 * - No cryptographic overhead (security not needed)
 *
 * Important: Uses charCodeAt() which hashes UTF-16 code units, not Unicode code points.
 * This is acceptable because:
 * - Deterministic (same string = same hash, always)
 * - Fast (no Unicode normalization overhead)
 * - Sufficient for cache keys (not cryptographic use)
 * - JavaScript strings are UTF-16 internally
 */

/**
 * FNV-1a 32-bit hash constants
 * FNV_PRIME: 16777619 (magic prime number for FNV-1a)
 * FNV_OFFSET: 2166136261 (initial hash value)
 */
const FNV_PRIME = 16777619;
const FNV_OFFSET = 2166136261;

/**
 * Generate a hash string from content using FNV-1a algorithm
 *
 * This function creates a deterministic hash that's suitable for cache keys.
 * The same content will always produce the same hash.
 *
 * Time Complexity: O(n) where n is the string length
 * Space Complexity: O(1)
 *
 * @param content - The string content to hash
 * @returns A hexadecimal hash string (8 characters)
 *
 * @example
 * ```typescript
 * const hash1 = contentHash('Hello, world!');
 * const hash2 = contentHash('Hello, world!');
 * console.log(hash1 === hash2); // true - deterministic
 *
 * const hash3 = contentHash('Hello, world?');
 * console.log(hash1 === hash3); // false - different content
 * ```
 */
export function contentHash(content: string): string {
  // Handle edge case: empty string
  if (content.length === 0) {
    return '00000000';
  }

  // Initialize hash with FNV offset basis
  let hash = FNV_OFFSET;

  // Process each character in the string
  for (let i = 0; i < content.length; i++) {
    // XOR hash with byte (character code)
    hash ^= content.charCodeAt(i);

    // Multiply by FNV prime (with 32-bit overflow handling)
    // JavaScript bitwise operations automatically use 32-bit integers
    hash = Math.imul(hash, FNV_PRIME);
  }

  // Convert to unsigned 32-bit integer and then to hex string
  // >>> 0 converts to unsigned 32-bit integer
  // toString(16) converts to hexadecimal
  // padStart ensures 8 characters (32 bits = 8 hex chars)
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Generate a hash for markdown content (optimized for cache keys)
 *
 * This is a convenience wrapper around contentHash() that's specifically
 * designed for markdown caching use cases. It handles the same input
 * format that MarkdownText component receives.
 *
 * @param markdown - The markdown content to hash
 * @returns A hexadecimal hash string
 *
 * @example
 * ```typescript
 * const cacheKey = markdownHash('# Hello\n\nWorld');
 * cache.set(cacheKey, parsedMarkdown);
 * ```
 */
export function markdownHash(markdown: string): string {
  return contentHash(markdown);
}

/**
 * Verify hash collision resistance (for testing/validation)
 *
 * This function tests the hash function against a set of similar strings
 * to verify it produces different hashes (no collisions).
 *
 * @param testStrings - Array of test strings to check
 * @returns True if no collisions detected
 *
 * @example
 * ```typescript
 * const similar = ['test', 'test ', ' test', 'Test'];
 * const noCollisions = verifyHashDistribution(similar);
 * console.log(noCollisions); // true
 * ```
 */
export function verifyHashDistribution(testStrings: string[]): boolean {
  const hashes = new Set<string>();

  for (const str of testStrings) {
    const hash = contentHash(str);
    if (hashes.has(hash)) {
      return false; // Collision detected
    }
    hashes.add(hash);
  }

  return true; // No collisions
}
