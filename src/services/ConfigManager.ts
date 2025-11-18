/**
 * ConfigManager - Configuration management service
 *
 * Manages application configuration with loading, saving, validation,
 * and runtime modification. Implements the IService interface for
 * proper lifecycle management within the service registry.
 */

import { promises as fs } from 'fs';
import { dirname } from 'path';
import type { Config, IService } from '../types/index.js';
import { DEFAULT_CONFIG, validateConfigValue } from '../config/defaults.js';
import { getConfigFile, getBaseConfigFile, ensureDirectories } from '../config/paths.js';
import { logger } from './Logger.js';

export class ConfigManager implements IService {
  private _config: Config;
  private _configPath: string;

  constructor(configPath?: string) {
    this._configPath = configPath || getConfigFile();
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
   * Load base configuration (global defaults)
   *
   * @returns Base config object or empty object if not found
   */
  private async loadBaseConfig(): Promise<Partial<Config>> {
    try {
      const baseConfigPath = getBaseConfigFile();
      const content = await fs.readFile(baseConfigPath, 'utf-8');
      const baseConfig = JSON.parse(content);

      // Validate and coerce types
      const validatedConfig: Partial<Config> = {};
      for (const [key, value] of Object.entries(baseConfig)) {
        if (key in DEFAULT_CONFIG) {
          const validated = validateConfigValue(key as keyof Config, value);
          if (validated.valid) {
            validatedConfig[key as keyof Config] = validated.coercedValue;
          } else {
            logger.warn(`[CONFIG] Invalid value for ${key} in base config: ${validated.error}`);
          }
        } else {
          logger.warn(`[CONFIG] Unknown key '${key}' in base config, ignoring`);
        }
      }

      return validatedConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Base config doesn't exist, return empty
        return {};
      }
      logger.warn('[CONFIG] Error loading base config:', error);
      return {};
    }
  }

  /**
   * Load configuration from disk with 3-tier inheritance
   *
   * Priority (highest to lowest):
   * 1. Profile config (~/.ally/profiles/{profile}/config.json)
   * 2. Base config (~/.ally/config.json)
   * 3. Default values (DEFAULT_CONFIG)
   *
   * Validates and coerces types during loading.
   * Automatically removes unknown config keys from profile config and saves cleaned version.
   */
  private async loadConfig(): Promise<void> {
    try {
      // Load base config first (global defaults)
      const baseConfig = await this.loadBaseConfig();

      // Load profile-specific config
      let profileConfig: Partial<Config> = {};
      const unknownKeys: string[] = [];

      try {
        const content = await fs.readFile(this._configPath, 'utf-8');
        const rawProfileConfig = JSON.parse(content);

        // Validate and coerce types for profile config
        for (const [key, value] of Object.entries(rawProfileConfig)) {
          if (key in DEFAULT_CONFIG) {
            const validated = validateConfigValue(key as keyof Config, value);
            if (validated.valid) {
              profileConfig[key as keyof Config] = validated.coercedValue;
            } else {
              logger.warn(`[CONFIG] Invalid value for ${key} in profile config: ${validated.error}. Using inherited value.`);
            }
          } else {
            unknownKeys.push(key);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('[CONFIG] Error loading profile config:', error);
        }
        // Profile config doesn't exist or is invalid, that's ok
      }

      // Build final config with 3-tier inheritance
      // Priority: profileConfig > baseConfig > DEFAULT_CONFIG
      this._config = { ...DEFAULT_CONFIG };

      // Apply base config
      for (const key in baseConfig) {
        if (key in DEFAULT_CONFIG) {
          (this._config as any)[key] = baseConfig[key as keyof Config];
        }
      }

      // Apply profile config (highest priority)
      for (const key in profileConfig) {
        if (key in DEFAULT_CONFIG) {
          (this._config as any)[key] = profileConfig[key as keyof Config];
        }
      }

      // If unknown keys were found, clean the profile config file
      if (unknownKeys.length > 0) {
        await this.saveConfig();
        logger.info(`\nProfile config cleanup: Removed unknown keys: ${unknownKeys.join(', ')}\n`);
      }
    } catch (error) {
      logger.error('[CONFIG] Error in loadConfig:', error);
      // Return defaults on error
      this._config = { ...DEFAULT_CONFIG };
    }
  }

  /**
   * Save configuration to disk (profile config only)
   *
   * Only saves values that differ from base config + defaults to keep
   * profile config minimal. This ensures profile config only stores overrides.
   */
  async saveConfig(): Promise<void> {
    try {
      const profileConfigPath = this._configPath;

      // Ensure profile config directory exists
      const profileConfigDir = dirname(profileConfigPath);
      await fs.mkdir(profileConfigDir, { recursive: true });

      // Only save values that differ from base config + defaults
      // This keeps profile config minimal
      const baseConfig = await this.loadBaseConfig();
      const configToSave: Partial<Config> = {};

      for (const key in this._config) {
        if (key in DEFAULT_CONFIG) {
          const value = this._config[key as keyof Config];
          const baseValue = baseConfig[key as keyof Config];
          const defaultValue = DEFAULT_CONFIG[key as keyof Config];

          // Save if different from both base and default
          if (baseValue !== undefined) {
            // Base config has this key, only save if different from base
            if (JSON.stringify(value) !== JSON.stringify(baseValue)) {
              (configToSave as any)[key] = value;
            }
          } else {
            // No base config, save if different from default
            if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
              (configToSave as any)[key] = value;
            }
          }
        }
      }

      await fs.writeFile(
        profileConfigPath,
        JSON.stringify(configToSave, null, 2),
        'utf-8'
      );

      logger.debug('[CONFIG] Saved profile config');
    } catch (error) {
      logger.error('[CONFIG] Error saving config:', error);
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

  /**
   * Parse key-value input supporting multiple formats
   *
   * Supports three input formats:
   * 1. key=value
   * 2. key = value (with spaces around =)
   * 3. key value (space-separated)
   *
   * @param input - The key-value string to parse
   * @returns Object with key and valueString, or null if invalid format
   */
  parseKeyValue(input: string): { key: string; valueString: string } | null {
    if (!input || !input.trim()) {
      return null;
    }

    // Try format 1 & 2: key=value or key = value
    const equalsMatch = input.match(/^([^=]+)=(.+)$/);
    if (equalsMatch && equalsMatch[1] && equalsMatch[2]) {
      const key = equalsMatch[1].trim();
      const valueString = equalsMatch[2].trim();
      if (key && valueString) {
        return { key, valueString };
      }
    }

    // Try format 3: key value (space-separated)
    const spaceMatch = input.match(/^(\S+)\s+(.+)$/);
    if (spaceMatch && spaceMatch[1] && spaceMatch[2]) {
      const key = spaceMatch[1].trim();
      const valueString = spaceMatch[2].trim();
      if (key && valueString) {
        return { key, valueString };
      }
    }

    return null;
  }

  /**
   * Get the source of a configuration value
   *
   * @param key - Config key
   * @returns 'profile' | 'base' | 'default'
   */
  async getConfigSource(key: keyof Config): Promise<'profile' | 'base' | 'default'> {
    try {
      // Check profile config
      const profileConfigPath = this._configPath;
      const profileContent = await fs.readFile(profileConfigPath, 'utf-8');
      const profileConfig = JSON.parse(profileContent);
      if (key in profileConfig) {
        return 'profile';
      }
    } catch {
      // Profile config doesn't exist or error reading
    }

    try {
      // Check base config
      const baseConfig = await this.loadBaseConfig();
      if (key in baseConfig) {
        return 'base';
      }
    } catch {
      // Base config doesn't exist or error reading
    }

    return 'default';
  }

  /**
   * Get similar configuration keys for typo suggestions
   *
   * Finds keys that start with or contain the input string (case-insensitive).
   * Results are sorted by relevance (prefix matches first, then contains).
   *
   * @param input - The input string to match against
   * @param limit - Maximum number of suggestions to return (default: 3)
   * @returns Array of similar configuration keys
   */
  getSimilarKeys(input: string, limit: number = 3): string[] {
    const lowerInput = input.toLowerCase();
    const allKeys = this.getKeys() as string[];

    // Find keys that start with the input or contain it
    const matches = allKeys.filter(key => {
      const lowerKey = key.toLowerCase();
      return lowerKey.startsWith(lowerInput) || lowerKey.includes(lowerInput);
    });

    // Sort by relevance (exact prefix match first, then contains)
    return matches
      .sort((a, b) => {
        const aStr = a.toLowerCase();
        const bStr = b.toLowerCase();
        const aStarts = aStr.startsWith(lowerInput);
        const bStarts = bStr.startsWith(lowerInput);

        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return aStr.localeCompare(bStr);
      })
      .slice(0, limit);
  }

  /**
   * Set a configuration value from a key-value string
   *
   * High-level method that parses input, validates the key, parses the value,
   * and sets the configuration.
   *
   * @param kvInput - Key-value input string (e.g., "key=value", "key value")
   * @returns Object with key, oldValue, and newValue
   * @throws Error if input format is invalid, key is unknown, or validation fails
   */
  async setFromString(kvInput: string): Promise<{ key: string; oldValue: any; newValue: any }> {
    // Parse the input
    const parsed = this.parseKeyValue(kvInput);

    if (!parsed) {
      throw new Error('Invalid format. Use key=value, key = value, or key value');
    }

    const { key, valueString } = parsed;

    // Validate key exists
    if (!this.hasKey(key)) {
      const suggestions = this.getSimilarKeys(key);

      if (suggestions.length > 0) {
        let errorMsg = `Unknown configuration key: ${key}.`;
        errorMsg += '\n\nDid you mean one of these?';
        for (const suggestedKey of suggestions) {
          const currentValue = this.getValue(suggestedKey as keyof Config);
          errorMsg += `\n  ${suggestedKey} (current: ${JSON.stringify(currentValue)})`;
        }
        throw new Error(errorMsg);
      }

      throw new Error(`Unknown configuration key: ${key}. Use getKeys() to see all options.`);
    }

    // Parse value (try JSON first, fallback to string)
    let value: any = valueString;
    try {
      value = JSON.parse(valueString);
    } catch {
      // Keep as string if not valid JSON
      value = valueString;
    }

    // Get old value before setting
    const oldValue = this.getValue(key as keyof Config);

    // Set the value (this validates and saves)
    await this.setValue(key as keyof Config, value);

    return { key, oldValue, newValue: value };
  }

  /**
   * Reset a single configuration field to its default value
   *
   * @param key - Configuration key to reset
   * @returns Object with key, oldValue, and newValue (default)
   * @throws Error if key doesn't exist
   */
  async resetField(key: keyof Config): Promise<{ key: string; oldValue: any; newValue: any }> {
    if (!this.hasKey(key as string)) {
      throw new Error(`Unknown configuration key: ${key}`);
    }

    const oldValue = this.getValue(key);
    const newValue = DEFAULT_CONFIG[key];

    (this._config as any)[key] = newValue;
    await this.saveConfig();

    return { key: key as string, oldValue, newValue };
  }
}
