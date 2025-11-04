/**
 * ConfigManager - Configuration management service
 *
 * Manages application configuration with loading, saving, validation,
 * and runtime modification. Implements the IService interface for
 * proper lifecycle management within the service registry.
 */

import { promises as fs } from 'fs';
import type { Config, IService } from '../types/index.js';
import { DEFAULT_CONFIG, validateConfigValue } from '../config/defaults.js';
import { CONFIG_FILE, ensureDirectories } from '../config/paths.js';

export class ConfigManager implements IService {
  private _config: Config;
  private _configPath: string;

  constructor(configPath?: string) {
    this._configPath = configPath || CONFIG_FILE;
    this._config = { ...DEFAULT_CONFIG };
  }

  /**
   * Initialize the service
   * Loads configuration from disk and ensures directories exist
   */
  async initialize(): Promise<void> {
    await ensureDirectories();
    await this.loadConfig();
  }

  /**
   * Cleanup the service
   * No cleanup needed for ConfigManager
   */
  async cleanup(): Promise<void> {
    // No-op: Configuration is persisted on save
  }

  /**
   * Load configuration from disk
   *
   * Priority:
   * 1. Config file (~/.ally/config.json)
   * 2. Default values
   *
   * Validates and coerces types during loading.
   * Automatically removes unknown config keys and saves cleaned config.
   */
  private async loadConfig(): Promise<void> {
    try {
      // Check if config file exists
      await fs.access(this._configPath);

      // Read and parse config file
      const content = await fs.readFile(this._configPath, 'utf-8');
      const fileConfig = JSON.parse(content);

      const unknownKeys: string[] = [];

      // Merge with defaults, validating each value
      for (const [key, value] of Object.entries(fileConfig)) {
        if (key in DEFAULT_CONFIG) {
          const validation = validateConfigValue(key as keyof Config, value);

          if (validation.valid) {
            (this._config as any)[key] = validation.coercedValue;
          } else {
            console.warn(
              `Invalid config value for '${key}': ${validation.error}. Using default.`
            );
          }
        } else {
          unknownKeys.push(key);
        }
      }

      // If unknown keys were found, clean the config file
      if (unknownKeys.length > 0) {
        await this.saveConfig();
        console.log(`\nConfig cleanup: Removed unknown keys: ${unknownKeys.join(', ')}\n`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Config file doesn't exist - use defaults and create it
        await this.saveConfig();
      } else if (error instanceof SyntaxError) {
        console.error('Error parsing config file - using defaults:', error.message);
      } else {
        console.error('Error loading config - using defaults:', error);
      }
    }
  }

  /**
   * Save configuration to disk
   *
   * Writes the current configuration as pretty-printed JSON.
   */
  async saveConfig(): Promise<void> {
    try {
      const content = JSON.stringify(this._config, null, 2);
      await fs.writeFile(this._configPath, content, 'utf-8');
    } catch (error) {
      console.error('Error saving config:', error);
      throw error;
    }
  }

  /**
   * Get the complete configuration object
   */
  getConfig(): Readonly<Config> {
    return { ...this._config };
  }

  /**
   * Get a specific configuration value
   *
   * @param key - Configuration key
   * @param defaultValue - Optional default if key doesn't exist
   * @returns The configuration value
   */
  getValue<K extends keyof Config>(key: K): Config[K];
  getValue<K extends keyof Config>(key: K, defaultValue: Config[K]): Config[K];
  getValue<K extends keyof Config>(key: K, defaultValue?: Config[K]): Config[K] {
    if (key in this._config) {
      return this._config[key];
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    return DEFAULT_CONFIG[key];
  }

  /**
   * Set a configuration value with validation
   *
   * Validates the value against the expected type and saves the configuration.
   *
   * @param key - Configuration key
   * @param value - New value to set
   * @throws Error if validation fails
   */
  async setValue<K extends keyof Config>(key: K, value: Config[K]): Promise<void> {
    const validation = validateConfigValue(key, value);

    if (!validation.valid) {
      throw new Error(
        `Cannot set config value '${key}': ${validation.error}`
      );
    }

    this._config[key] = validation.coercedValue as Config[K];

    // Save to disk
    await this.saveConfig();
  }

  /**
   * Set multiple configuration values at once
   *
   * @param values - Object with key-value pairs to set
   * @throws Error if any validation fails
   */
  async setValues(values: Partial<Config>): Promise<void> {
    // Validate all values first
    const validations: Array<[keyof Config, any]> = [];

    for (const [key, value] of Object.entries(values)) {
      if (key in DEFAULT_CONFIG) {
        const validation = validateConfigValue(key as keyof Config, value);

        if (!validation.valid) {
          throw new Error(
            `Cannot set config value '${key}': ${validation.error}`
          );
        }

        validations.push([key as keyof Config, validation.coercedValue]);
      } else {
        throw new Error(`Unknown config key '${key}'`);
      }
    }

    // Apply all validated values
    for (const [key, value] of validations) {
      (this._config as any)[key] = value;
    }

    // Save to disk
    await this.saveConfig();
  }

  /**
   * Reset configuration to default values
   *
   * @returns Object indicating which values were reset
   */
  async reset(): Promise<Record<string, boolean>> {
    const changes: Record<string, boolean> = {};

    for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof Config>) {
      if (JSON.stringify(this._config[key]) !== JSON.stringify(DEFAULT_CONFIG[key])) {
        (this._config as any)[key] = DEFAULT_CONFIG[key];
        changes[key] = true;
      }
    }

    await this.saveConfig();
    return changes;
  }

  /**
   * Check if a configuration key exists
   */
  hasKey(key: string): key is keyof Config {
    return key in DEFAULT_CONFIG;
  }

  /**
   * Get all configuration keys
   */
  getKeys(): Array<keyof Config> {
    return Object.keys(DEFAULT_CONFIG) as Array<keyof Config>;
  }

  /**
   * Export configuration as JSON string
   */
  exportConfig(): string {
    return JSON.stringify(this._config, null, 2);
  }

  /**
   * Import configuration from JSON string
   *
   * @param json - JSON string containing configuration
   * @throws Error if JSON is invalid or validation fails
   */
  async importConfig(json: string): Promise<void> {
    try {
      const imported = JSON.parse(json);

      if (typeof imported !== 'object' || imported === null) {
        throw new Error('Invalid configuration format');
      }

      await this.setValues(imported);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON: ${error.message}`);
      }
      throw error;
    }
  }
}
