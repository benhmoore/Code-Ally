/**
 * PluginConfigManager - Plugin configuration management service
 *
 * Manages plugin configurations with encryption support for sensitive data.
 * Handles saving/loading configurations to ~/.ally/plugins/{name}/config.json
 * with automatic encryption of fields marked as secret.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../services/Logger.js';
import { CryptoService, CRYPTO_SALTS } from '../services/CryptoService.js';
import type { PluginConfigSchema, ConfigProperty } from './PluginLoader.js';
import { PLUGIN_FILES } from './constants.js';
import { ConfigUtils, PathUtils } from './utils.js';

export class PluginConfigManager {
  private crypto = new CryptoService({ salt: CRYPTO_SALTS.PLUGIN_CONFIG });

  /**
   * Encrypt secret fields in config object
   */
  private encryptSecrets(config: any, schema: PluginConfigSchema): any {
    if (!schema?.schema?.properties) {
      return config;
    }

    const encrypted = { ...config };

    for (const [key, property] of Object.entries(schema.schema.properties)) {
      const prop = property as ConfigProperty;
      if (prop.secret && !ConfigUtils.isEmpty(encrypted[key])) {
        const value = String(encrypted[key]);
        // Only encrypt if not already encrypted
        if (!this.crypto.isEncrypted(value)) {
          const encryptedValue = this.crypto.encrypt(value);
          encrypted[key] = this.crypto.wrapEncrypted(encryptedValue);
        }
      }
    }

    return encrypted;
  }

  /**
   * Decrypt secret fields in config object
   */
  private decryptSecrets(config: any, schema: PluginConfigSchema): any {
    if (!schema?.schema?.properties) {
      return config;
    }

    const decrypted = { ...config };

    for (const [key, property] of Object.entries(schema.schema.properties)) {
      const prop = property as ConfigProperty;
      if (prop.secret && !ConfigUtils.isEmpty(decrypted[key])) {
        const value = String(decrypted[key]);
        if (this.crypto.isEncrypted(value)) {
          try {
            const encryptedValue = this.crypto.unwrapEncrypted(value);
            decrypted[key] = this.crypto.decrypt(encryptedValue);
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
  private async validateConfig(config: any, schema: PluginConfigSchema): Promise<{ valid: boolean; errors: string[] }> {
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
        continue;
      }

      // Path existence validation for filepath and directory types
      if (!ConfigUtils.isEmpty(value) && typeof value === 'string') {
        if (prop.type === 'filepath') {
          const exists = await PathUtils.fileExists(value);
          if (!exists) {
            errors.push(`File not found for field '${key}': ${PathUtils.resolvePath(value)}`);
          }
        } else if (prop.type === 'directory') {
          const exists = await PathUtils.directoryExists(value);
          if (!exists) {
            errors.push(`Directory not found for field '${key}': ${PathUtils.resolvePath(value)}`);
          }
        }
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
        const validation = await this.validateConfig(normalizedConfig, schema);
        if (!validation.valid) {
          throw new Error(
            `Invalid configuration for plugin '${pluginName}':\n${validation.errors.join('\n')}`
          );
        }
      }

      // Encrypt secrets if schema is provided
      const configToSave = schema ? this.encryptSecrets(normalizedConfig, schema) : normalizedConfig;

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
      const decryptedConfig = schema ? this.decryptSecrets(config, schema) : config;

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

      const validation = await this.validateConfig(config, schema);
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
