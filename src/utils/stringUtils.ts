/**
 * String manipulation utilities
 */

import { TEXT_LIMITS } from '../config/constants.js';

/**
 * Predefined truncation lengths for consistency
 */
export const TRUNCATE_LENGTHS = {
  SHORT: 40,
  MEDIUM: 80,
  LONG: 120,
  VERY_LONG: 200,
} as const;

/**
 * Truncate a string to a maximum length with ellipsis
 *
 * @param str - The string to truncate
 * @param maxLength - Maximum length (including ellipsis)
 * @param ellipsis - Ellipsis string to append (default: '...')
 * @returns Truncated string
 */
export function truncate(str: string, maxLength: number, ellipsis: string = '...'): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - ellipsis.length) + ellipsis;
}

/**
 * Truncate a string at word boundary to avoid breaking words
 *
 * @param str - The string to truncate
 * @param maxLength - Maximum length (including ellipsis)
 * @param ellipsis - Ellipsis string to append (default: '...')
 * @returns Truncated string
 */
export function truncateAtWord(str: string, maxLength: number, ellipsis: string = '...'): string {
  if (str.length <= maxLength) {
    return str;
  }

  const truncated = str.substring(0, maxLength - ellipsis.length);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLength * TEXT_LIMITS.WORD_BOUNDARY_THRESHOLD) {
    return truncated.substring(0, lastSpace) + ellipsis;
  }

  return truncated + ellipsis;
}
