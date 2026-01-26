/**
 * Encryption configuration constants
 *
 * Centralized configuration for AES-256-GCM encryption used across
 * plugin configs, integration settings, and other sensitive data.
 */

/**
 * Encryption algorithm and key configuration
 */
export const ENCRYPTION_CONFIG = {
  /** Encryption algorithm - AES-256-GCM provides authenticated encryption */
  ALGORITHM: 'aes-256-gcm' as const,
  /** Encryption key length in bytes (256 bits) */
  KEY_LENGTH: 32,
  /** Initialization vector length in bytes (128 bits for GCM) */
  IV_LENGTH: 16,
  /** Prefix for identifying encrypted values */
  PREFIX: '__ENCRYPTED__',
  /** Separator for encrypted value components (iv:authTag:ciphertext) */
  SEPARATOR: ':',
} as const;
