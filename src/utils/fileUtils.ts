/**
 * File content utilities
 */

/**
 * Detect if file content is binary by looking for null bytes
 *
 * @param content - The file content to check
 * @param sampleSize - Number of characters to sample (default: 1024)
 * @returns True if content appears to be binary
 */
export function isBinaryContent(content: string, sampleSize: number = 1024): boolean {
  const sample = content.substring(0, sampleSize);
  return sample.includes('\0');
}
