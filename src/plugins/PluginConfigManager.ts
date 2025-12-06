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
import { PLUGIN_ENCRYPTION, PLUGIN_FILES } from './constants.js';
import { ConfigUtils } from './utils.js';

export class PluginConfigManager {
  private encryptionKey: Buffer | null = null;

  /**
   * Get or create the encryption key
   * Key is derived from machine-specific identifier for local-only encryption
   */
  private async getEncryptionKey(): Promise<Buffer> {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    const keyMaterial = process.env.USER || process.env.USERNAME || 'ally-default';
    const salt = Buffer.from('ally-plugin-config-salt');

    this.encryptionKey = scryptSync(keyMaterial, salt, PLUGIN_ENCRYPTION.KEY_LENGTH);
    return this.encryptionKey;
  }

  /**
   * Encrypt a string value using AES-256-GCM
   */
  private async encrypt(value: string): Promise<string> {
    const key = await this.getEncryptionKey();
    const iv = randomBytes(PLUGIN_ENCRYPTION.IV_LENGTH);
    const cipher = createCipheriv(PLUGIN_ENCRYPTION.ALGORITHM, key, iv);

    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encrypted
    const sep = PLUGIN_ENCRYPTION.SEPARATOR;
    return `${iv.toString('hex')}${sep}${authTag.toString('hex')}${sep}${encrypted}`;
  }

  /**
   * Decrypt a string value
   */
  private async decrypt(encryptedValue: string): Promise<string> {
    const key = await this.getEncryptionKey();
    const parts = encryptedValue.split(PLUGIN_ENCRYPTION.SEPARATOR);

    if (parts.length !== 3) {
      throw new Error('Invalid encrypted value format');
    }

    const iv = Buffer.from(parts[0]!, 'hex');
    const authTag = Buffer.from(parts[1]!, 'hex');
    const encrypted = parts[2]!;

    const decipher = createDecipheriv(PLUGIN_ENCRYPTION.ALGORITHM, key, iv);
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
    const prefix = `${PLUGIN_ENCRYPTION.PREFIX}${PLUGIN_ENCRYPTION.SEPARATOR}`;

    for (const [key, property] of Object.entries(schema.schema.properties)) {
      const prop = property as ConfigProperty;
      if (prop.secret && !ConfigUtils.isEmpty(encrypted[key])) {
        const value = String(encrypted[key]);
        // Only encrypt if not already encrypted
        if (!value.startsWith(prefix)) {
          const encryptedValue = await this.encrypt(value);
          encrypted[key] = `${prefix}${encryptedValue}`;
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
    const prefix = `${PLUGIN_ENCRYPTION.PREFIX}${PLUGIN_ENCRYPTION.SEPARATOR}`;

    for (const [key, property] of Object.entries(schema.schema.properties)) {
      const prop = property as ConfigProperty;
      if (prop.secret && !ConfigUtils.isEmpty(decrypted[key])) {
        const value = String(decrypted[key]);
        if (value.startsWith(prefix)) {
          try {
            const encryptedValue = value.substring(prefix.length);
            decrypted[key] = await this.decrypt(encryptedValue);
          } catch (error) {
            // Decryption failure is a critical error - don't silently continue
            // with encrypted value as it would cause cryptic downstream failures
            const errorMsg = `Failed to decrypt secret field '${key}': ${
              error instanceof Error ? error.message : String(error)
            }. The encryption key may have changed, or the config file may be corrupted.`;
            logger.error(`[PluginConfigManager] ${errorMsg}`);
            throw new Error(errorMsg);
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

      if (ConfigUtils.isEmpty(value)) {
        continue;
      }

      normalized[key] = ConfigUtils.coerceType(value, prop.type);
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
      if (prop.required && ConfigUtils.isEmpty(value)) {
        errors.push(`Required field '${key}' is missing`);
        continue;
      }

      // Skip type validation if field is not required and not provided
      if (!prop.required && ConfigUtils.isEmpty(value)) {
        continue;
      }

      // Type validation with coercion support
      if (!ConfigUtils.isEmpty(value) && !ConfigUtils.validateType(value, prop.type)) {
        errors.push(`Field '${key}' has invalid type. Expected ${prop.type}, got ${typeof value}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get the config file path for a plugin
   */
  private getConfigPath(pluginPath: string): string {
    return join(pluginPath, PLUGIN_FILES.CONFIG);
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
