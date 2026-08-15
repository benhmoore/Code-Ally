/**
 * CryptoService - Shared encryption/decryption service
 *
 * Provides AES-256-GCM encryption for sensitive data like API keys and secrets.
 * Uses a random installation-local key with per-context key derivation.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { chmodSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENCRYPTION_CONFIG } from '../config/encryption.js';
import { ALLY_HOME } from '../config/paths.js';

export interface CryptoServiceConfig {
  /** Unique salt string for this encryption context */
  salt: string;
  /** Override the installation key path (primarily for isolated runtimes/tests). */
  keyPath?: string;
}

export class CryptoService {
  private encryptionKey: Buffer | null = null;
  private readonly salt: Buffer;
  private readonly keyPath: string;

  constructor(config: CryptoServiceConfig) {
    this.salt = Buffer.from(config.salt);
    this.keyPath = config.keyPath ?? join(ALLY_HOME, '.secret-key');
  }

  /**
   * Get or derive the encryption key
   * Key is derived from an installation-local secret combined with context salt
   */
  private getEncryptionKey(): Buffer {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    const keyPath = this.keyPath;
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    let keyMaterial: Buffer;
    try {
      const encodedKey = readFileSync(keyPath, 'utf-8').trim();
      keyMaterial = this.decodeKeyMaterial(encodedKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      keyMaterial = randomBytes(ENCRYPTION_CONFIG.KEY_LENGTH);
      try {
        const fd = openSync(keyPath, 'wx', 0o600);
        try {
          writeFileSync(fd, keyMaterial.toString('hex'), 'utf-8');
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        keyMaterial = this.decodeKeyMaterial(readFileSync(keyPath, 'utf-8').trim());
      }
    }

    chmodSync(keyPath, 0o600);
    this.encryptionKey = scryptSync(keyMaterial, this.salt, ENCRYPTION_CONFIG.KEY_LENGTH);
    return this.encryptionKey;
  }

  private decodeKeyMaterial(encodedKey: string): Buffer {
    if (!/^[0-9a-f]{64}$/i.test(encodedKey)) {
      throw new Error(`Invalid installation encryption key: ${this.keyPath}`);
    }

    return Buffer.from(encodedKey, 'hex');
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
    const parts = encryptedValue.split(ENCRYPTION_CONFIG.SEPARATOR);

    if (parts.length !== 3) {
      throw new Error('Invalid encrypted value format');
    }

    const iv = Buffer.from(parts[0]!, 'hex');
    const authTag = Buffer.from(parts[1]!, 'hex');
    const encrypted = parts[2]!;

    const decipher = createDecipheriv(
      ENCRYPTION_CONFIG.ALGORITHM,
      this.getEncryptionKey(),
      iv
    );
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
  CONFIG: 'ally-config-salt',
  PLUGIN_CONFIG: 'ally-plugin-config-salt',
  INTEGRATION: 'ally-integration-config-salt',
} as const;
