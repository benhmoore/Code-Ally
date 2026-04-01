/**
 * Tests for MarketplaceManager - marketplace registration, syncing, and catalog discovery
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { MarketplaceManifest } from '@marketplace/types.js';

const { TEST_BASE } = vi.hoisted(() => {
  const { join } = require('path');
  return { TEST_BASE: join('/tmp', `marketplace-mgr-test-${process.pid}-${Date.now()}`) };
});

vi.mock('@marketplace/constants.js', () => {
  const { join } = require('path');
  const dir = join(TEST_BASE, 'plugins');
  return {
    MARKETPLACE_DIR: dir,
    KNOWN_MARKETPLACES_FILE: join(dir, 'known_marketplaces.json'),
    BLOCKLIST_FILE: join(dir, 'blocklist.json'),
    PLUGIN_CACHE_DIR: join(dir, 'cache'),
    MARKETPLACE_CACHE_DIR: join(dir, 'cache', 'marketplaces'),
    INSTALLED_PLUGINS_FILE: join(dir, 'installed_plugins.json'),
  };
});

// Import after mock
import { MarketplaceManager } from '@marketplace/MarketplaceManager.js';

describe('MarketplaceManager', () => {
  let manager: MarketplaceManager;

  beforeEach(async () => {
    await fs.rm(TEST_BASE, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(join(TEST_BASE, 'plugins', 'cache', 'marketplaces'), { recursive: true });
    manager = new MarketplaceManager();
  });

  afterEach(async () => {
    try {
      await manager.cleanup();
      await fs.rm(TEST_BASE, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('initialize', () => {
    it('initializes without error when no known marketplaces exist', async () => {
      await expect(manager.initialize()).resolves.toBeUndefined();
    });
  });

  describe('addMarketplace', () => {
    it('adds a local directory marketplace', async () => {
      await manager.initialize();

      const mktDir = join(TEST_BASE, 'my-marketplace');
      await createFakeMarketplace(mktDir, {
        name: 'test-mkt',
        description: 'Test marketplace',
        owner: { name: 'Test' },
        plugins: [
          { name: 'plugin-a', source: './plugins/plugin-a', description: 'Plugin A', version: '1.0.0' },
        ],
      });

      const name = await manager.addMarketplace({ type: 'directory', path: mktDir });
      expect(name).toBe('test-mkt');
    });

    it('rejects duplicate marketplace names', async () => {
      await manager.initialize();

      const mktDir = join(TEST_BASE, 'dup-mkt');
      await createFakeMarketplace(mktDir, {
        name: 'dup-mkt',
        description: 'Test',
        owner: { name: 'Test' },
        plugins: [],
      });

      await manager.addMarketplace({ type: 'directory', path: mktDir });
      await expect(manager.addMarketplace({ type: 'directory', path: mktDir }))
        .rejects.toThrow(/already registered/);
    });

    it('rejects invalid marketplace (no manifest)', async () => {
      await manager.initialize();

      const emptyDir = join(TEST_BASE, 'empty');
      await fs.mkdir(emptyDir, { recursive: true });

      await expect(manager.addMarketplace({ type: 'directory', path: emptyDir }))
        .rejects.toThrow(/No valid/);
    });

    it('rejects non-existent directory', async () => {
      await manager.initialize();

      await expect(manager.addMarketplace({ type: 'directory', path: '/nonexistent/path' }))
        .rejects.toThrow(/not accessible/);
    });
  });

  describe('removeMarketplace', () => {
    it('removes a registered marketplace', async () => {
      await manager.initialize();

      const mktDir = join(TEST_BASE, 'rm-mkt');
      await createFakeMarketplace(mktDir, {
        name: 'rm-mkt',
        description: 'Test',
        owner: { name: 'Test' },
        plugins: [],
      });

      await manager.addMarketplace({ type: 'directory', path: mktDir });
      await manager.removeMarketplace('rm-mkt');

      expect(manager.hasMarketplace('rm-mkt')).toBe(false);
    });

    it('throws for unknown marketplace', async () => {
      await manager.initialize();
      await expect(manager.removeMarketplace('nonexistent')).rejects.toThrow(/not registered/);
    });
  });

  describe('listMarketplaces', () => {
    it('returns empty array when no marketplaces registered', async () => {
      await manager.initialize();
      const result = await manager.listMarketplaces();
      expect(result).toEqual([]);
    });

    it('returns marketplace info with plugin catalog', async () => {
      await manager.initialize();

      const mktDir = join(TEST_BASE, 'list-mkt');
      await createFakeMarketplace(mktDir, {
        name: 'list-mkt',
        description: 'Test marketplace',
        owner: { name: 'Test Org' },
        plugins: [
          { name: 'plugin-a', source: './plugins/plugin-a', description: 'Plugin A', version: '1.0.0' },
          { name: 'plugin-b', source: './plugins/plugin-b', description: 'Plugin B', version: '2.0.0' },
        ],
      });

      await manager.addMarketplace({ type: 'directory', path: mktDir });
      const result = await manager.listMarketplaces();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('list-mkt');
      expect(result[0].owner).toBe('Test Org');
      expect(result[0].plugins).toHaveLength(2);
    });
  });

  describe('listAvailablePlugins', () => {
    it('returns plugins across all marketplaces', async () => {
      await manager.initialize();

      const mkt1 = join(TEST_BASE, 'mkt1');
      await createFakeMarketplace(mkt1, {
        name: 'mkt-one',
        description: 'First',
        owner: { name: 'Test' },
        plugins: [{ name: 'plugin-a', source: './a', description: 'A', version: '1.0.0' }],
      });

      const mkt2 = join(TEST_BASE, 'mkt2');
      await createFakeMarketplace(mkt2, {
        name: 'mkt-two',
        description: 'Second',
        owner: { name: 'Test' },
        plugins: [{ name: 'plugin-b', source: './b', description: 'B', version: '2.0.0' }],
      });

      await manager.addMarketplace({ type: 'directory', path: mkt1 });
      await manager.addMarketplace({ type: 'directory', path: mkt2 });

      const plugins = await manager.listAvailablePlugins();
      expect(plugins).toHaveLength(2);
      expect(plugins.map(p => p.name)).toContain('plugin-a');
      expect(plugins.map(p => p.name)).toContain('plugin-b');
    });

    it('filters by marketplace when specified', async () => {
      await manager.initialize();

      const mkt1 = join(TEST_BASE, 'filter-mkt1');
      await createFakeMarketplace(mkt1, {
        name: 'filter-one',
        description: 'First',
        owner: { name: 'Test' },
        plugins: [{ name: 'plugin-a', source: './a', description: 'A', version: '1.0.0' }],
      });

      const mkt2 = join(TEST_BASE, 'filter-mkt2');
      await createFakeMarketplace(mkt2, {
        name: 'filter-two',
        description: 'Second',
        owner: { name: 'Test' },
        plugins: [{ name: 'plugin-b', source: './b', description: 'B', version: '2.0.0' }],
      });

      await manager.addMarketplace({ type: 'directory', path: mkt1 });
      await manager.addMarketplace({ type: 'directory', path: mkt2 });

      const plugins = await manager.listAvailablePlugins('filter-one');
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('plugin-a');
    });
  });

  describe('resolvePluginSourcePath', () => {
    it('resolves relative plugin source to absolute path', async () => {
      await manager.initialize();

      const mktDir = join(TEST_BASE, 'resolve-mkt');
      await createFakeMarketplace(mktDir, {
        name: 'resolve-mkt',
        description: 'Test',
        owner: { name: 'Test' },
        plugins: [{ name: 'my-plugin', source: './plugins/my-plugin', description: 'My Plugin', version: '1.0.0' }],
      });

      await manager.addMarketplace({ type: 'directory', path: mktDir });

      const manifest = await manager.getMarketplaceManifest('resolve-mkt');
      const resolved = manager.resolvePluginSourcePath('resolve-mkt', 'my-plugin', manifest!);
      expect(resolved).toBe(join(mktDir, 'plugins', 'my-plugin'));
    });
  });

  describe('persistence', () => {
    it('persists marketplace registry across instances', async () => {
      await manager.initialize();

      const mktDir = join(TEST_BASE, 'persist-mkt');
      await createFakeMarketplace(mktDir, {
        name: 'persist-mkt',
        description: 'Test',
        owner: { name: 'Test' },
        plugins: [],
      });

      await manager.addMarketplace({ type: 'directory', path: mktDir });
      await manager.cleanup();

      const manager2 = new MarketplaceManager();
      await manager2.initialize();
      expect(manager2.hasMarketplace('persist-mkt')).toBe(true);
      await manager2.cleanup();
    });
  });

  async function createFakeMarketplace(dir: string, manifest: MarketplaceManifest): Promise<void> {
    await fs.mkdir(join(dir, '.claude-plugin'), { recursive: true });
    await fs.writeFile(
      join(dir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest, null, 2)
    );
  }
});
