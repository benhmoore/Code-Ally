/**
 * ID generation utilities
 */

import { randomBytes } from 'crypto';

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Generate a short ID (8 characters)
 */
export function generateShortId(): string {
  return randomBytes(4).toString('hex');
}
