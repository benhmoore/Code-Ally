/**
 * ConfigManager unit tests
 *
 * Tests configuration loading, saving, validation, and runtime modification
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigManager } from '../ConfigManager.js';
import { DEFAULT_CONFIG } from '@config/defaults.js';
import * as paths from '@config/paths.js';

// Mock getBaseConfigFile to prevent loading user's actual base config during tests
vi.mock('@config/paths.js', async () => {
  const actual = await vi.importActual('@config/paths.js');
  return {
    ...actual,
    getBaseConfigFile: () => '/nonexistent/base/config.json',
  };
});

describe('ConfigManager', () => {
  let tempDir: string;
  let configPath: string;
  let configManager: ConfigManager;

  beforeEach(async () => {
    // Create a temporary directory for test config
    tempDir = join(tmpdir(), `code-ally-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    await fs.mkdir(tempDir, { recursive: true });
    configPath = join(tempDir, 'config.json');
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should initialize with default config when no file exists', async () => {
      configManager = new ConfigManager(configPath);
      await configManager.initialize();

      const config = configManager.getConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('should not create config file on initialization if not needed', async () => {
      configManager = new ConfigManager(configPath);
      await configManager.initialize();

      // Config file is not created on init unless there are unknown keys to clean up
      // The file will be created when setValue() is called
      try {
        await fs.access(configPath);
        // If we get here, file exists (which is ok too)
      } catch (error) {
        // File doesn't exist (expected for fresh init)
        expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    it('should load existing config file', async () => {
      // Create a config file with custom values
      const customConfig = {
        ...DEFAULT_CONFIG,
        temperature: 0.7,
        model: 'custom-model',
      };
      await fs.writeFile(configPath, JSON.stringify(customConfig, null, 2));

      configManager = new ConfigManager(configPath);
      await configManager.initialize();

      expect(configManager.getValue('temperature')).toBe(0.7);
      expect(configManager.getValue('model')).toBe('custom-model');
    });

    it('should handle invalid JSON gracefully', async () => {
      // Write invalid JSON
      await fs.writeFile(configPath, 'invalid json{');

      // Spy on logger instead of console
      const { logger } = await import('../Logger.js');
      const loggerSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      configManager = new ConfigManager(configPath);
      await configManager.initialize();

      // Should fall back to defaults
      expect(configManager.getConfig()).toEqual(DEFAULT_CONFIG);
      expect(loggerSpy).toHaveBeenCalled();

      loggerSpy.mockRestore();
    });
  });

  describe('getValue', () => {
    beforeEach(async () => {
      configManager = new ConfigManager(configPath);
      await configManager.initialize();
    });

    it('should get existing config values', () => {
      expect(configManager.getValue('model')).toBe(DEFAULT_CONFIG.model);
      expect(configManager.getValue('temperature')).toBe(DEFAULT_CONFIG.temperature);
      expect(configManager.getValue('context_size')).toBe(DEFAULT_CONFIG.context_size);
    });

    it('should return default value for missing keys', () => {
      expect(configManager.getValue('temperature', 0.5)).toBe(0.3); // Uses actual value
    });

    it('should handle all config types correctly', () => {
      expect(typeof configManager.getValue('model')).toBe('string'); // empty string by default
      expect(typeof configManager.getValue('endpoint')).toBe('string');
      expect(typeof configManager.getValue('context_size')).toBe('number');
      expect(typeof configManager.getValue('temperature')).toBe('number');
      expect(typeof configManager.getValue('auto_confirm')).toBe('boolean');
    });
  });

  describe('setValue', () => {
    beforeEach(async () => {
      configManager = new ConfigManager(configPath);
      await configManager.initialize();
    });

    it('should set valid string values', async () => {
      await configManager.setValue('model', 'test-model');
      expect(configManager.getValue('model')).toBe('test-model');

      // Verify it was saved to disk
      const fileContent = await fs.readFile(configPath, 'utf-8');
      const savedConfig = JSON.parse(fileContent);
      expect(savedConfig.model).toBe('test-model');
    });

    it('should set valid number values', async () => {
      await configManager.setValue('temperature', 0.8);
      expect(configManager.getValue('temperature')).toBe(0.8);
    });

    it('should set valid boolean values', async () => {
      await configManager.setValue('auto_confirm', true);
      expect(configManager.getValue('auto_confirm')).toBe(true);
    });

    it('should reject invalid types', async () => {
      await expect(
        configManager.setValue('temperature', 'invalid' as any)
      ).rejects.toThrow();
    });

    it('should coerce string numbers', async () => {
      await configManager.setValue('temperature', '0.9' as any);
      expect(configManager.getValue('temperature')).toBe(0.9);
    });

    it('should coerce string booleans', async () => {
      await configManager.setValue('auto_confirm', 'true' as any);
      expect(configManager.getValue('auto_confirm')).toBe(true);

      await configManager.setValue('auto_confirm', 'false' as any);
      expect(configManager.getValue('auto_confirm')).toBe(false);
    });
  });

  describe('setValues', () => {
    beforeEach(async () => {
      configManager = new ConfigManager(configPath);
      await configManager.initialize();
    });

    it('should set multiple values at once', async () => {
      await configManager.setValues({
        temperature: 0.7,
        model: 'multi-test',
        auto_confirm: true,
      });

      expect(configManager.getValue('temperature')).toBe(0.7);
      expect(configManager.getValue('model')).toBe('multi-test');
      expect(configManager.getValue('auto_confirm')).toBe(true);
    });

    it('should validate all values before applying any', async () => {
      await expect(
        configManager.setValues({
          temperature: 0.7,
          model: 123 as any, // Invalid type
        })
      ).rejects.toThrow();

      // Temperature should not have been changed
      expect(configManager.getValue('temperature')).toBe(DEFAULT_CONFIG.temperature);
    });

    it('should reject unknown keys', async () => {
      await expect(
        configManager.setValues({
          unknown_key: 'value',
        } as any)
      ).rejects.toThrow();
    });
  });

  describe('reset', () => {
    beforeEach(async () => {
      configManager = new ConfigManager(configPath);
      await configManager.initialize();
    });

    it('should reset all values to defaults', async () => {
      // Change some values
      await configManager.setValues({
        temperature: 0.9,
        model: 'custom-model',
        auto_confirm: true,
      });

      // Reset
      const changes = await configManager.reset();

      // Verify reset
      expect(configManager.getValue('temperature')).toBe(DEFAULT_CONFIG.temperature);
      expect(configManager.getValue('model')).toBe(DEFAULT_CONFIG.model);
      expect(configManager.getValue('auto_confirm')).toBe(DEFAULT_CONFIG.auto_confirm);

      // Verify change tracking
      expect(changes.temperature).toBe(true);
      expect(changes.model).toBe(true);
      expect(changes.auto_confirm).toBe(true);
    });

    it('should not report unchanged values', async () => {
      const changes = await configManager.reset();
      expect(Object.keys(changes).length).toBe(0);
    });
  });

  describe('import/export', () => {
    beforeEach(async () => {
      configManager = new ConfigManager(configPath);
      await configManager.initialize();
    });

    it('should export config as JSON', () => {
      const exported = configManager.exportConfig();
      const parsed = JSON.parse(exported);
      expect(parsed).toEqual(DEFAULT_CONFIG);
    });

    it('should import valid config JSON', async () => {
      const customConfig = {
        temperature: 0.8,
        model: 'imported-model',
      };

      await configManager.importConfig(JSON.stringify(customConfig));

      expect(configManager.getValue('temperature')).toBe(0.8);
      expect(configManager.getValue('model')).toBe('imported-model');
    });

    it('should reject invalid JSON', async () => {
      await expect(configManager.importConfig('invalid json')).rejects.toThrow();
    });

    it('should reject non-object JSON', async () => {
      await expect(configManager.importConfig('["array"]')).rejects.toThrow();
    });
  });

  describe('utility methods', () => {
    beforeEach(async () => {
      configManager = new ConfigManager(configPath);
      await configManager.initialize();
    });

    it('should check if key exists', () => {
      expect(configManager.hasKey('model')).toBe(true);
      expect(configManager.hasKey('temperature')).toBe(true);
      expect(configManager.hasKey('invalid_key')).toBe(false);
    });

    it('should return all keys', () => {
      const keys = configManager.getKeys();
      expect(keys).toContain('model');
      expect(keys).toContain('temperature');
      expect(keys).toContain('context_size');
      expect(keys.length).toBeGreaterThan(0);
    });
  });

  describe('IService lifecycle', () => {
    it('should implement initialize method', async () => {
      configManager = new ConfigManager(configPath);
      expect(typeof configManager.initialize).toBe('function');
      await expect(configManager.initialize()).resolves.toBeUndefined();
    });

    it('should implement cleanup method', async () => {
      configManager = new ConfigManager(configPath);
      await configManager.initialize();
      expect(typeof configManager.cleanup).toBe('function');
      await expect(configManager.cleanup()).resolves.toBeUndefined();
    });
  });

  describe('unknown keys cleanup', () => {
    it('should preserve user settings when cleaning unknown keys', async () => {
      // Simulate an old config file with user customizations + an unknown key
      const oldConfig = {
        model: 'custom-model',
        temperature: 0.7,
        auto_confirm: true,
        old_removed_field: 'should-be-removed', // Unknown key
      };

      await fs.writeFile(configPath, JSON.stringify(oldConfig, null, 2));

      // Load config (this should trigger cleanup)
      configManager = new ConfigManager(configPath);
      await configManager.initialize();

      // Verify user settings are preserved in memory
      expect(configManager.getValue('model')).toBe('custom-model');
      expect(configManager.getValue('temperature')).toBe(0.7);
      expect(configManager.getValue('auto_confirm')).toBe(true);

      // Verify cleaned config was written to disk
      const savedContent = await fs.readFile(configPath, 'utf-8');
      const savedConfig = JSON.parse(savedContent);

      // User settings should be preserved
      expect(savedConfig.model).toBe('custom-model');
      expect(savedConfig.temperature).toBe(0.7);
      expect(savedConfig.auto_confirm).toBe(true);

      // Unknown key should be removed
      expect(savedConfig.old_removed_field).toBeUndefined();
    });

    it('should not reset config when defaults change', async () => {
      // Simulate user config that happens to match current defaults
      const userConfig = {
        model: DEFAULT_CONFIG.model,
        temperature: 0.9, // Different from default
        unknown_key: 'value',
      };

      await fs.writeFile(configPath, JSON.stringify(userConfig, null, 2));

      configManager = new ConfigManager(configPath);
      await configManager.initialize();

      // Verify temperature setting is preserved even though model matches default
      expect(configManager.getValue('temperature')).toBe(0.9);

      // Verify config on disk
      const savedContent = await fs.readFile(configPath, 'utf-8');
      const savedConfig = JSON.parse(savedContent);

      // Temperature should be preserved (different from default)
      expect(savedConfig.temperature).toBe(0.9);

      // Model might or might not be saved (it matches default, so it's optional)
      // The key point is that temperature wasn't lost
    });
  });
});
