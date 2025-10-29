/**
 * PluginConfigManager - Plugin configuration management service
 *
 * Manages plugin configurations with encryption support for sensitive data.
 * Handles saving/loading configurations to ~/.ally/plugins/{name}/config.json
 * with automatic encryption of fields marked as secret.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { logger } from '../services/Logger.js';
import type { PluginConfigSchema, ConfigProperty } from './PluginLoader.js';

/**
 * Encryption configuration
 * Uses AES-256-GCM for authenticated encryption
 */
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits

/**
 * Encrypted field marker
 */
const ENCRYPTED_PREFIX = '__ENCRYPTED__:';

export class PluginConfigManager {
  private encryptionKey: Buffer | null = null;

  /**
   * Get or create the encryption key
   * Key is derived from a machine-specific identifier
   */
  private async getEncryptionKey(): Promise<Buffer> {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    // Use a machine-specific identifier for key derivation
    // In a real production system, you might want to use a more secure key storage
    const keyMaterial = process.env.USER || process.env.USERNAME || 'ally-default';
    const salt = Buffer.from('ally-plugin-config-salt');

    this.encryptionKey = scryptSync(keyMaterial, salt, KEY_LENGTH);
    return this.encryptionKey;
  }

  /**
   * Encrypt a string value
   */
  private async encrypt(value: string): Promise<string> {
    const key = await this.getEncryptionKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt a string value
   */
  private async decrypt(encryptedValue: string): Promise<string> {
    const key = await this.getEncryptionKey();
    const parts = encryptedValue.split(':');

    if (parts.length !== 3) {
      throw new Error('Invalid encrypted value format');
    }

    const iv = Buffer.from(parts[0]!, 'hex');
    const authTag = Buffer.from(parts[1]!, 'hex');
    const encrypted = parts[2]!;

    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');

    return decrypted;
  }

  /**
   * Encrypt secret fields in config object
   */
  private async encryptSecrets(config: any, schema: PluginConfigSchema): Promise<any> {
    if (!schema?.schema?.properties) {
      return config;
    }

    const encrypted = { ...config };

    for (const [key, property] of Object.entries(schema.schema.properties)) {
      const prop = property as ConfigProperty;
      if (prop.secret && encrypted[key] !== undefined && encrypted[key] !== null) {
        const value = String(encrypted[key]);
        // Only encrypt if not already encrypted
        if (!value.startsWith(ENCRYPTED_PREFIX)) {
          const encryptedValue = await this.encrypt(value);
          encrypted[key] = `${ENCRYPTED_PREFIX}${encryptedValue}`;
        }
      }
    }

    return encrypted;
  }

  /**
   * Decrypt secret fields in config object
   */
  private async decryptSecrets(config: any, schema: PluginConfigSchema): Promise<any> {
    if (!schema?.schema?.properties) {
      return config;
    }

    const decrypted = { ...config };

    for (const [key, property] of Object.entries(schema.schema.properties)) {
      const prop = property as ConfigProperty;
      if (prop.secret && decrypted[key] !== undefined && decrypted[key] !== null) {
        const value = String(decrypted[key]);
        if (value.startsWith(ENCRYPTED_PREFIX)) {
          try {
            const encryptedValue = value.substring(ENCRYPTED_PREFIX.length);
            decrypted[key] = await this.decrypt(encryptedValue);
          } catch (error) {
            logger.warn(
              `[PluginConfigManager] Failed to decrypt field '${key}': ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            // Leave the value as-is if decryption fails
          }
        }
      }
    }

    return decrypted;
  }

  /**
   * Normalize config types (convert strings to proper types based on schema)
   */
  private normalizeConfigTypes(config: any, schema: PluginConfigSchema): any {
    if (!schema?.schema?.properties) {
      return config;
    }

    const normalized: any = { ...config };

    for (const [key, property] of Object.entries(schema.schema.properties)) {
      const prop = property as ConfigProperty;
      const value = config[key];

      // Skip if value is not provided
      if (value === undefined || value === null || value === '') {
        continue;
      }

      // Convert based on expected type
      if (prop.type === 'integer' || prop.type === 'number') {
        if (typeof value === 'string') {
          const num = Number(value);
          if (!isNaN(num)) {
            normalized[key] = num;
          }
        }
      } else if (prop.type === 'boolean') {
        if (typeof value === 'string') {
          normalized[key] = value === 'true';
        }
      }
      // string type doesn't need conversion
    }

    return normalized;
  }

  /**
   * Validate config against schema
   */
  private validateConfig(config: any, schema: PluginConfigSchema): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!schema?.schema?.properties) {
      return { valid: true, errors };
    }

    for (const [key, property] of Object.entries(schema.schema.properties)) {
      const prop = property as ConfigProperty;
      const value = config[key];

      // Check required fields
      if (prop.required && (value === undefined || value === null || value === '')) {
        errors.push(`Required field '${key}' is missing`);
        continue;
      }

      // Skip type validation if field is not required and not provided
      if (!prop.required && (value === undefined || value === null)) {
        continue;
      }

      // Type validation with coercion support
      if (value !== undefined && value !== null) {
        const actualType = typeof value;
        let isValid = false;

        // For integer/number types, accept both number and string-numbers
        if (prop.type === 'integer' || prop.type === 'number') {
          if (actualType === 'number') {
            isValid = true;
          } else if (actualType === 'string' && !isNaN(Number(value)) && value.trim() !== '') {
            isValid = true;
          }
        }
        // For boolean type, accept boolean or string boolean
        else if (prop.type === 'boolean') {
          if (actualType === 'boolean') {
            isValid = true;
          } else if (actualType === 'string' && (value === 'true' || value === 'false')) {
            isValid = true;
          }
        }
        // For string type
        else if (prop.type === 'string') {
          isValid = actualType === 'string';
        }

        if (!isValid) {
          errors.push(`Field '${key}' has invalid type. Expected ${prop.type}, got ${actualType}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get the config file path for a plugin
   */
  private getConfigPath(pluginPath: string): string {
    return join(pluginPath, 'config.json');
  }

  /**
   * Save plugin configuration
   * Encrypts secret fields before saving
   */
  async saveConfig(
    pluginName: string,
    pluginPath: string,
    config: any,
    schema?: PluginConfigSchema
  ): Promise<void> {
    try {
      // Normalize types if schema is provided (convert strings to proper types)
      const normalizedConfig = schema ? this.normalizeConfigTypes(config, schema) : config;

      // Validate config if schema is provided
      if (schema) {
        const validation = this.validateConfig(normalizedConfig, schema);
        if (!validation.valid) {
          throw new Error(
            `Invalid configuration for plugin '${pluginName}':\n${validation.errors.join('\n')}`
          );
        }
      }

      // Encrypt secrets if schema is provided
      const configToSave = schema ? await this.encryptSecrets(normalizedConfig, schema) : normalizedConfig;

      // Ensure plugin directory exists
      await fs.mkdir(pluginPath, { recursive: true });

      // Write config file
      const configPath = this.getConfigPath(pluginPath);
      const content = JSON.stringify(configToSave, null, 2);
      await fs.writeFile(configPath, content, 'utf-8');

      logger.debug(`[PluginConfigManager] Saved config for plugin '${pluginName}' to ${configPath}`);
    } catch (error) {
      logger.error(
        `[PluginConfigManager] Failed to save config for plugin '${pluginName}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }

  /**
   * Load plugin configuration
   * Decrypts secret fields after loading
   */
  async loadConfig(
    pluginName: string,
    pluginPath: string,
    schema?: PluginConfigSchema
  ): Promise<any | null> {
    try {
      const configPath = this.getConfigPath(pluginPath);

      // Check if config file exists
      try {
        await fs.access(configPath);
      } catch {
        logger.debug(`[PluginConfigManager] No config file found for plugin '${pluginName}'`);
        return null;
      }

      // Read and parse config file
      const content = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(content);

      // Decrypt secrets if schema is provided
      const decryptedConfig = schema ? await this.decryptSecrets(config, schema) : config;

      logger.debug(`[PluginConfigManager] Loaded config for plugin '${pluginName}' from ${configPath}`);
      return decryptedConfig;
    } catch (error) {
      logger.error(
        `[PluginConfigManager] Failed to load config for plugin '${pluginName}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }

  /**
   * Check if configuration is complete
   * Returns true if all required fields are present and valid
   */
  async isConfigComplete(
    pluginName: string,
    pluginPath: string,
    schema: PluginConfigSchema
  ): Promise<boolean> {
    try {
      const config = await this.loadConfig(pluginName, pluginPath, schema);

      if (!config) {
        return false;
      }

      const validation = this.validateConfig(config, schema);
      return validation.valid;
    } catch (error) {
      logger.debug(
        `[PluginConfigManager] Config validation failed for plugin '${pluginName}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
    }
  }
}
