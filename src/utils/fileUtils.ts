/**
 * File content utilities
 */

import { BUFFER_SIZES } from '../config/constants.js';

/**
 * Detect if file content is binary by looking for null bytes
 *
 * @param content - The file content to check
 * @param sampleSize - Number of characters to sample (default: 1KB)
 * @returns True if content appears to be binary
 */
export function isBinaryContent(content: string, sampleSize: number = BUFFER_SIZES.BINARY_DETECTION_SAMPLE_SIZE): boolean {
  const sample = content.substring(0, sampleSize);
  return sample.includes('\0');
}
