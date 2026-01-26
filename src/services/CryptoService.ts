/**
 * CryptoService - Shared encryption/decryption service
 *
 * Provides AES-256-GCM encryption for sensitive data like API keys and secrets.
 * Uses a machine-specific key derivation with configurable salt per context.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { ENCRYPTION_CONFIG } from '../config/encryption.js';

export interface CryptoServiceConfig {
  /** Unique salt string for this encryption context */
  salt: string;
}

export class CryptoService {
  private encryptionKey: Buffer | null = null;
  private readonly salt: Buffer;

  constructor(config: CryptoServiceConfig) {
    this.salt = Buffer.from(config.salt);
  }

  /**
   * Get or derive the encryption key
   * Key is derived from machine-specific identifier combined with context salt
   */
  private getEncryptionKey(): Buffer {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    const keyMaterial = process.env.USER || process.env.USERNAME || 'ally-default';
    this.encryptionKey = scryptSync(keyMaterial, this.salt, ENCRYPTION_CONFIG.KEY_LENGTH);
    return this.encryptionKey;
  }

  /**
   * Encrypt a string value using AES-256-GCM
   * @returns Encrypted value in format: iv:authTag:ciphertext
   */
  encrypt(value: string): string {
    const key = this.getEncryptionKey();
    const iv = randomBytes(ENCRYPTION_CONFIG.IV_LENGTH);
    const cipher = createCipheriv(ENCRYPTION_CONFIG.ALGORITHM, key, iv);

    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();
    const sep = ENCRYPTION_CONFIG.SEPARATOR;

    return `${iv.toString('hex')}${sep}${authTag.toString('hex')}${sep}${encrypted}`;
  }

  /**
   * Decrypt a string value
   * @param encryptedValue Value in format: iv:authTag:ciphertext
   */
  decrypt(encryptedValue: string): string {
    const key = this.getEncryptionKey();
    const parts = encryptedValue.split(ENCRYPTION_CONFIG.SEPARATOR);

    if (parts.length !== 3) {
      throw new Error('Invalid encrypted value format');
    }

    const iv = Buffer.from(parts[0]!, 'hex');
    const authTag = Buffer.from(parts[1]!, 'hex');
    const encrypted = parts[2]!;

    const decipher = createDecipheriv(ENCRYPTION_CONFIG.ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
  }

  /**
   * Check if a value has the encryption prefix
   */
  isEncrypted(value: string): boolean {
    const prefix = this.getEncryptedPrefix();
    return value.startsWith(prefix);
  }

  /**
   * Wrap an encrypted value with the standard prefix
   */
  wrapEncrypted(encryptedValue: string): string {
    return `${this.getEncryptedPrefix()}${encryptedValue}`;
  }

  /**
   * Remove the encryption prefix from a wrapped value
   */
  unwrapEncrypted(wrappedValue: string): string {
    const prefix = this.getEncryptedPrefix();
    if (!wrappedValue.startsWith(prefix)) {
      throw new Error('Value does not have encryption prefix');
    }
    return wrappedValue.substring(prefix.length);
  }

  /**
   * Get the encryption prefix string
   */
  private getEncryptedPrefix(): string {
    return `${ENCRYPTION_CONFIG.PREFIX}${ENCRYPTION_CONFIG.SEPARATOR}`;
  }

  /**
   * Clear cached encryption key (for cleanup)
   */
  clearKey(): void {
    this.encryptionKey = null;
  }
}

/**
 * Pre-configured salt values for different contexts
 */
export const CRYPTO_SALTS = {
  PLUGIN_CONFIG: 'ally-plugin-config-salt',
  INTEGRATION: 'ally-integration-config-salt',
} as const;
