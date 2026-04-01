/**
 * Tests for PluginManager - plugin installation, uninstallation, and state management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { MarketplaceManifest, PluginManifest } from '@marketplace/types.js';

const { TEST_BASE } = vi.hoisted(() => {
  const { join } = require('path');
  return { TEST_BASE: join('/tmp', `plugin-mgr-test-${process.pid}-${Date.now()}`) };
});

vi.mock('@marketplace/constants.js', () => {
  const { join } = require('path');
  const dir = join(TEST_BASE, 'plugins');
  return {
    MARKETPLACE_DIR: dir,
    INSTALLED_PLUGINS_FILE: join(dir, 'installed_plugins.json'),
    KNOWN_MARKETPLACES_FILE: join(dir, 'known_marketplaces.json'),
    BLOCKLIST_FILE: join(dir, 'blocklist.json'),
    PLUGIN_CACHE_DIR: join(dir, 'cache'),
    MARKETPLACE_CACHE_DIR: join(dir, 'cache', 'marketplaces'),
  };
});

import { PluginManager } from '@marketplace/PluginManager.js';
import { MarketplaceManager } from '@marketplace/MarketplaceManager.js';

describe('PluginManager', () => {
  let pluginManager: PluginManager;
  let marketplaceManager: MarketplaceManager;
  let mktSourceDir: string;

  beforeEach(async () => {
    await fs.rm(TEST_BASE, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(join(TEST_BASE, 'plugins', 'cache', 'marketplaces'), { recursive: true });

    mktSourceDir = join(TEST_BASE, 'marketplace-source');

    // Create a fake marketplace with one plugin
    await createFakeMarketplace(mktSourceDir, {
      name: 'test-mkt',
      description: 'Test marketplace',
      owner: { name: 'Test' },
      plugins: [
        { name: 'test-plugin', source: './plugins/test-plugin', description: 'A test plugin', version: '1.0.0' },
      ],
    });

    // Create the actual plugin directory
    await createFakePlugin(join(mktSourceDir, 'plugins', 'test-plugin'), {
      name: 'test-plugin',
      version: '1.0.0',
      description: 'A test plugin',
      author: { name: 'Tester' },
    });

    marketplaceManager = new MarketplaceManager();
    await marketplaceManager.initialize();
    await marketplaceManager.addMarketplace({ type: 'directory', path: mktSourceDir });

    pluginManager = new PluginManager(marketplaceManager);
    await pluginManager.initialize();
  });

  afterEach(async () => {
    try {
      await pluginManager.cleanup();
      await marketplaceManager.cleanup();
      await fs.rm(TEST_BASE, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('install', () => {
    it('installs a plugin from a marketplace', async () => {
      const result = await pluginManager.install('test-mkt', 'test-plugin');

      expect(result.success).toBe(true);
      expect(result.pluginName).toBe('test-plugin');
      expect(result.version).toBe('1.0.0');
      expect(result.installPath).toContain('cache');
    });

    it('copies plugin files to cache', async () => {
      const result = await pluginManager.install('test-mkt', 'test-plugin');

      const manifest = await pluginManager.readPluginManifest(result.installPath);
      expect(manifest).not.toBeNull();
      expect(manifest!.name).toBe('test-plugin');
    });

    it('reads and returns MCP config', async () => {
      const result = await pluginManager.install('test-mkt', 'test-plugin');

      expect(result.mcpConfig).toBeDefined();
      expect(result.mcpConfig!['test']).toBeDefined();
      expect(result.mcpConfig!['test'].command).toBe('node');
    });

    it('is idempotent for same version', async () => {
      const result1 = await pluginManager.install('test-mkt', 'test-plugin');
      const result2 = await pluginManager.install('test-mkt', 'test-plugin');

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.version).toBe(result2.version);
    });

    it('fails for unknown marketplace', async () => {
      const result = await pluginManager.install('nonexistent', 'test-plugin');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('fails for unknown plugin', async () => {
      const result = await pluginManager.install('test-mkt', 'nonexistent-plugin');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('uninstall', () => {
    it('uninstalls an installed plugin', async () => {
      await pluginManager.install('test-mkt', 'test-plugin');
      const result = await pluginManager.uninstall('test-plugin');

      expect(result.success).toBe(true);
      expect(pluginManager.isInstalled('test-plugin')).toBe(false);
    });

    it('accepts full key format (name@marketplace)', async () => {
      await pluginManager.install('test-mkt', 'test-plugin');
      const result = await pluginManager.uninstall('test-plugin@test-mkt');

      expect(result.success).toBe(true);
    });

    it('fails for non-installed plugin', async () => {
      const result = await pluginManager.uninstall('nonexistent');
      expect(result.success).toBe(false);
    });
  });

  describe('getInstalledPlugins / getEnabledPlugins', () => {
    it('lists installed plugins', async () => {
      await pluginManager.install('test-mkt', 'test-plugin');
      const plugins = pluginManager.getInstalledPlugins();

      expect(plugins).toHaveLength(1);
      expect(plugins[0].pluginName).toBe('test-plugin');
      expect(plugins[0].pluginKey).toBe('test-plugin@test-mkt');
    });

    it('returns only enabled plugins', async () => {
      await pluginManager.install('test-mkt', 'test-plugin');

      expect(pluginManager.getEnabledPlugins()).toHaveLength(1);

      await pluginManager.setEnabled('test-plugin', false);
      expect(pluginManager.getEnabledPlugins()).toHaveLength(0);
    });
  });

  describe('setEnabled', () => {
    it('disables an installed plugin', async () => {
      await pluginManager.install('test-mkt', 'test-plugin');

      const success = await pluginManager.setEnabled('test-plugin', false);
      expect(success).toBe(true);
      expect(pluginManager.isPluginEnabled('test-plugin')).toBe(false);
    });

    it('re-enables a disabled plugin', async () => {
      await pluginManager.install('test-mkt', 'test-plugin');
      await pluginManager.setEnabled('test-plugin', false);
      await pluginManager.setEnabled('test-plugin', true);

      expect(pluginManager.isPluginEnabled('test-plugin')).toBe(true);
    });

    it('returns false for non-installed plugin', async () => {
      const success = await pluginManager.setEnabled('nonexistent', false);
      expect(success).toBe(false);
    });
  });

  describe('getPluginMCPConfig', () => {
    it('substitutes CLAUDE_PLUGIN_ROOT', async () => {
      const result = await pluginManager.install('test-mkt', 'test-plugin');
      const mcpConfig = await pluginManager.getPluginMCPConfig(result.installPath);

      expect(mcpConfig).not.toBeNull();
      const args = mcpConfig!['test'].args!;
      expect(args[0]).toBe(join(result.installPath, 'server', 'dist', 'index.js'));
      expect(args[0]).not.toContain('${');
    });

    it('returns null for plugin without .mcp.json', async () => {
      const pluginDir = join(TEST_BASE, 'no-mcp');
      await fs.mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
      await fs.writeFile(
        join(pluginDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'no-mcp', version: '1.0.0', description: 'No MCP' })
      );

      const config = await pluginManager.getPluginMCPConfig(pluginDir);
      expect(config).toBeNull();
    });
  });

  describe('persistence', () => {
    it('persists installed plugins across instances', async () => {
      await pluginManager.install('test-mkt', 'test-plugin');
      await pluginManager.cleanup();

      const pm2 = new PluginManager(marketplaceManager);
      await pm2.initialize();

      expect(pm2.isInstalled('test-plugin')).toBe(true);
      expect(pm2.getInstalledPlugins()).toHaveLength(1);
      await pm2.cleanup();
    });
  });

  describe('blocklist', () => {
    it('blocks installation of blocklisted plugins', async () => {
      const blocklistDir = join(TEST_BASE, 'plugins');
      await fs.writeFile(
        join(blocklistDir, 'blocklist.json'),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          plugins: [{ plugin: 'test-plugin@test-mkt', added_at: new Date().toISOString(), reason: 'test', text: 'Blocked' }],
        })
      );

      const pm = new PluginManager(marketplaceManager);
      await pm.initialize();

      const result = await pm.install('test-mkt', 'test-plugin');
      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked');
      await pm.cleanup();
    });
  });

  async function createFakeMarketplace(dir: string, manifest: MarketplaceManifest): Promise<void> {
    await fs.mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await fs.writeFile(
      join(dir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest, null, 2)
    );
  }

  async function createFakePlugin(dir: string, manifest: PluginManifest): Promise<void> {
    await fs.mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await fs.writeFile(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify(manifest, null, 2)
    );
    await fs.writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({
        test: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/server/dist/index.js'],
          env: { TEST_TOKEN: '${TEST_TOKEN}' },
        },
      })
    );
  }
});
