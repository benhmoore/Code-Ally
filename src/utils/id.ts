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

/**
 * Generate a message ID that combines timestamp with random component
 * Format: msg_{timestamp}_{random} for sortability and uniqueness
 */
export function generateMessageId(): string {
  const timestamp = Date.now();
  const random = randomBytes(4).toString('hex');
  return `msg_${timestamp}_${random}`;
}
