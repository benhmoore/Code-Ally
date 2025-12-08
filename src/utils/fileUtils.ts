/**
 * File content utilities
 */

import { BUFFER_SIZES } from '../config/constants.js';

/**
 * Detect if file content is binary by checking control character ratio
 *
 * Uses a ratio-based approach rather than just detecting any null byte.
 * This handles UTF-16 files (which have ~50% nulls for ASCII text) and
 * occasional corrupted bytes while still catching true binary files.
 *
 * @param content - The file content to check
 * @param sampleSize - Number of characters to sample (default: 1KB)
 * @returns True if content appears to be binary
 */
export function isBinaryContent(content: string, sampleSize: number = BUFFER_SIZES.BINARY_DETECTION_SAMPLE_SIZE): boolean {
  const sample = content.substring(0, sampleSize);
  if (sample.length === 0) return false;

  // Count control characters (0x00-0x08, 0x0E-0x1F) excluding tab, newline, CR
  let controlCount = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code <= 8 || (code >= 14 && code <= 31)) {
      controlCount++;
    }
  }

  // Binary if >10% are control characters
  return controlCount / sample.length > 0.1;
}
