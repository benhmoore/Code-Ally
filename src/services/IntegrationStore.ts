/**
 * IntegrationStore - Integration settings persistence service
 *
 * Manages storage and retrieval of external service integrations.
 * Stores settings in ~/.ally/integrations.json with encryption
 * for sensitive fields like API keys using AES-256-GCM.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { logger } from './Logger.js';
import type { IService } from '../types/index.js';
import type { IntegrationSettings, SearchProviderType } from '../types/integration.js';
import {
  DEFAULT_INTEGRATION_SETTINGS,
  INTEGRATION_ENCRYPTION,
  INTEGRATION_FILES,
} from '../types/integration.js';

export class IntegrationStore implements IService {
  private settings: IntegrationSettings = { ...DEFAULT_INTEGRATION_SETTINGS };
  private encryptionKey: Buffer | null = null;
  private initialized = false;

  /**
   * Get the path to the integrations settings file
   */
  private getSettingsPath(): string {
    return join(homedir(), '.ally', INTEGRATION_FILES.SETTINGS);
  }

  /**
   * Get the path to the .ally directory
   */
  private getAllyDir(): string {
    return join(homedir(), '.ally');
  }

  /**
   * Get or create the encryption key
   * Key is derived from machine-specific identifier for local-only encryption
   */
  private getEncryptionKey(): Buffer {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    const keyMaterial = process.env.USER || process.env.USERNAME || 'ally-default';
    const salt = Buffer.from('ally-integration-config-salt');

    this.encryptionKey = scryptSync(keyMaterial, salt, INTEGRATION_ENCRYPTION.KEY_LENGTH);
    return this.encryptionKey;
  }

  /**
   * Encrypt a string value using AES-256-GCM
   */
  private encrypt(value: string): string {
    const key = this.getEncryptionKey();
    const iv = randomBytes(INTEGRATION_ENCRYPTION.IV_LENGTH);
    const cipher = createCipheriv(INTEGRATION_ENCRYPTION.ALGORITHM, key, iv);

    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encrypted
    const sep = INTEGRATION_ENCRYPTION.SEPARATOR;
    return `${iv.toString('hex')}${sep}${authTag.toString('hex')}${sep}${encrypted}`;
  }

  /**
   * Decrypt a string value
   */
  private decrypt(encryptedValue: string): string {
    const key = this.getEncryptionKey();
    const parts = encryptedValue.split(INTEGRATION_ENCRYPTION.SEPARATOR);

    if (parts.length !== 3) {
      throw new Error('Invalid encrypted value format');
    }

    const iv = Buffer.from(parts[0]!, 'hex');
    const authTag = Buffer.from(parts[1]!, 'hex');
    const encrypted = parts[2]!;

    const decipher = createDecipheriv(INTEGRATION_ENCRYPTION.ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');

    return decrypted;
  }

  /**
   * Check if a value is encrypted (has the encryption prefix)
   */
  private isEncrypted(value: string): boolean {
    const prefix = `${INTEGRATION_ENCRYPTION.PREFIX}${INTEGRATION_ENCRYPTION.SEPARATOR}`;
    return value.startsWith(prefix);
  }

  /**
   * Encrypt the API key for storage
   */
  private encryptAPIKey(key: string | null): string | null {
    if (key === null) {
      return null;
    }

    const prefix = `${INTEGRATION_ENCRYPTION.PREFIX}${INTEGRATION_ENCRYPTION.SEPARATOR}`;

    // Already encrypted
    if (this.isEncrypted(key)) {
      return key;
    }

    const encryptedValue = this.encrypt(key);
    return `${prefix}${encryptedValue}`;
  }

  /**
   * Decrypt the API key from storage
   */
  private decryptAPIKey(key: string | null): string | null {
    if (key === null) {
      return null;
    }

    const prefix = `${INTEGRATION_ENCRYPTION.PREFIX}${INTEGRATION_ENCRYPTION.SEPARATOR}`;

    // Not encrypted (shouldn't happen, but handle gracefully)
    if (!this.isEncrypted(key)) {
      return key;
    }

    try {
      const encryptedValue = key.substring(prefix.length);
      return this.decrypt(encryptedValue);
    } catch (error) {
      const errorMsg = `Failed to decrypt API key: ${
        error instanceof Error ? error.message : String(error)
      }. The encryption key may have changed, or the config file may be corrupted.`;
      logger.error(`[IntegrationStore] ${errorMsg}`);
      throw new Error(errorMsg);
    }
  }

  /**
   * Load settings from disk
   */
  private async loadFromDisk(): Promise<IntegrationSettings> {
    const settingsPath = this.getSettingsPath();

    try {
      await fs.access(settingsPath);
    } catch {
      logger.debug(`[IntegrationStore] No settings file found at ${settingsPath}, using defaults`);
      return { ...DEFAULT_INTEGRATION_SETTINGS };
    }

    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const stored = JSON.parse(content) as IntegrationSettings;

      // Decrypt the API key if present
      const settings: IntegrationSettings = {
        searchProvider: stored.searchProvider ?? DEFAULT_INTEGRATION_SETTINGS.searchProvider,
        searchAPIKey: this.decryptAPIKey(stored.searchAPIKey),
        searchCount: stored.searchCount ?? DEFAULT_INTEGRATION_SETTINGS.searchCount,
      };

      logger.debug(`[IntegrationStore] Loaded settings from ${settingsPath}`);
      return settings;
    } catch (error) {
      logger.error(
        `[IntegrationStore] Failed to load settings: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }

  /**
   * Initialize the service by loading settings from disk
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      this.settings = await this.loadFromDisk();
      this.initialized = true;
      logger.debug('[IntegrationStore] Initialized successfully');
    } catch (error) {
      // On initialization failure, use defaults but log the error
      logger.error(
        `[IntegrationStore] Initialization failed, using defaults: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.settings = { ...DEFAULT_INTEGRATION_SETTINGS };
      this.initialized = true;
    }
  }

  /**
   * Cleanup the service - save settings and release resources
   */
  async cleanup(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    try {
      await this.saveSettings();
      logger.debug('[IntegrationStore] Cleanup completed');
    } catch (error) {
      logger.error(
        `[IntegrationStore] Cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    this.encryptionKey = null;
    this.initialized = false;
  }

  /**
   * Get current integration settings
   */
  getSettings(): IntegrationSettings {
    return { ...this.settings };
  }

  /**
   * Set the search provider
   * Resets API key if provider changes
   */
  setSearchProvider(provider: SearchProviderType): void {
    if (this.settings.searchProvider !== provider) {
      this.settings.searchProvider = provider;
      // Reset API key when provider changes
      this.settings.searchAPIKey = null;
      logger.debug(`[IntegrationStore] Search provider set to '${provider}', API key reset`);
    } else {
      logger.debug(`[IntegrationStore] Search provider unchanged: '${provider}'`);
    }
  }

  /**
   * Set the search API key
   */
  setSearchAPIKey(key: string | null): void {
    this.settings.searchAPIKey = key;
    logger.debug(`[IntegrationStore] Search API key ${key ? 'set' : 'cleared'}`);
  }

  /**
   * Increment the search usage counter
   */
  incrementSearchCount(): void {
    this.settings.searchCount++;
    logger.debug(`[IntegrationStore] Search count incremented to ${this.settings.searchCount}`);
  }

  /**
   * Check if search is fully configured (provider selected and API key set)
   */
  isSearchConfigured(): boolean {
    const { searchProvider, searchAPIKey } = this.settings;

    // 'none' provider doesn't require configuration
    if (searchProvider === 'none') {
      return false;
    }

    return searchAPIKey !== null && searchAPIKey.length > 0;
  }

  /**
   * Save settings to disk
   */
  async saveSettings(): Promise<void> {
    const allyDir = this.getAllyDir();
    const settingsPath = this.getSettingsPath();

    try {
      // Ensure .ally directory exists
      await fs.mkdir(allyDir, { recursive: true });

      // Prepare settings for storage with encrypted API key
      const storedSettings: IntegrationSettings = {
        searchProvider: this.settings.searchProvider,
        searchAPIKey: this.encryptAPIKey(this.settings.searchAPIKey),
        searchCount: this.settings.searchCount,
      };

      const content = JSON.stringify(storedSettings, null, 2);
      await fs.writeFile(settingsPath, content, 'utf-8');

      logger.debug(`[IntegrationStore] Saved settings to ${settingsPath}`);
    } catch (error) {
      logger.error(
        `[IntegrationStore] Failed to save settings: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }
}
