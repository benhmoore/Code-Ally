/**
 * MarketplaceManager - Manages marketplace registration, syncing, and plugin catalog discovery.
 *
 * Marketplaces are directories (local or git-cloned) containing a .claude-plugin/marketplace.json
 * registry that lists available plugins.
 */

import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import {
  KNOWN_MARKETPLACES_FILE,
  MARKETPLACE_DIR,
  MARKETPLACE_CACHE_DIR,
} from './constants.js';
import type {
  MarketplaceManifest,
  MarketplacePluginEntry,
  MarketplaceSource,
  KnownMarketplacesFile,
  KnownMarketplaceEntry,
  MarketplaceInfo,
} from './types.js';
import type { IService } from '../types/index.js';

const execFileAsync = promisify(execFile);

export class MarketplaceManager implements IService {
  private knownMarketplaces: KnownMarketplacesFile = {};
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await mkdir(MARKETPLACE_DIR, { recursive: true });
    await mkdir(MARKETPLACE_CACHE_DIR, { recursive: true });

    await this.loadKnownMarketplaces();
    this.initialized = true;
  }

  async cleanup(): Promise<void> {
    this.knownMarketplaces = {};
    this.initialized = false;
  }

  // ===========================================================================
  // Marketplace Registry
  // ===========================================================================

  /**
   * Add a new marketplace source. Validates that it contains a valid marketplace.json.
   */
  async addMarketplace(source: MarketplaceSource): Promise<string> {
    const location = await this.resolveSourceLocation(source);

    // Validate marketplace.json exists
    const manifest = await this.readMarketplaceManifest(location);
    if (!manifest) {
      throw new Error(
        `No valid .claude-plugin/marketplace.json found at ${location}`
      );
    }

    const name = manifest.name;

    // Check for name collision
    if (this.knownMarketplaces[name]) {
      throw new Error(
        `Marketplace '${name}' is already registered. Remove it first to re-add.`
      );
    }

    this.knownMarketplaces[name] = {
      source,
      installLocation: location,
      lastUpdated: new Date().toISOString(),
    };

    await this.saveKnownMarketplaces();
    logger.info(`[MarketplaceManager] Added marketplace '${name}' from ${source.type}: ${source.path || source.repo}`);
    return name;
  }

  /**
   * Remove a marketplace from the registry.
   */
  async removeMarketplace(name: string): Promise<void> {
    if (!this.knownMarketplaces[name]) {
      throw new Error(`Marketplace '${name}' is not registered`);
    }

    delete this.knownMarketplaces[name];
    await this.saveKnownMarketplaces();
    logger.info(`[MarketplaceManager] Removed marketplace '${name}'`);
  }

  /**
   * Sync a marketplace from its source. For git repos, pulls latest. For directories, re-reads.
   */
  async syncMarketplace(name: string): Promise<void> {
    const entry = this.knownMarketplaces[name];
    if (!entry) {
      throw new Error(`Marketplace '${name}' is not registered`);
    }

    if (entry.source.type === 'github') {
      const cloneDir = join(MARKETPLACE_CACHE_DIR, name);
      try {
        await access(join(cloneDir, '.git'), constants.F_OK);
        // Already cloned, pull
        await execFileAsync('git', ['-C', cloneDir, 'pull', '--ff-only']);
        logger.info(`[MarketplaceManager] Synced marketplace '${name}' via git pull`);
      } catch {
        // Not cloned yet, clone
        await mkdir(cloneDir, { recursive: true });
        const repoUrl = `https://github.com/${entry.source.repo}.git`;
        await execFileAsync('git', ['clone', repoUrl, cloneDir]);
        entry.installLocation = cloneDir;
        logger.info(`[MarketplaceManager] Cloned marketplace '${name}' from ${repoUrl}`);
      }
    }

    // Re-validate the manifest
    const manifest = await this.readMarketplaceManifest(entry.installLocation);
    if (!manifest) {
      logger.warn(`[MarketplaceManager] Marketplace '${name}' has no valid manifest after sync`);
    }

    entry.lastUpdated = new Date().toISOString();
    await this.saveKnownMarketplaces();
  }

  /**
   * Sync all known marketplaces.
   */
  async syncAll(): Promise<void> {
    for (const name of Object.keys(this.knownMarketplaces)) {
      try {
        await this.syncMarketplace(name);
      } catch (error) {
        logger.error(`[MarketplaceManager] Failed to sync '${name}': ${formatError(error)}`);
      }
    }
  }

  // ===========================================================================
  // Catalog Discovery
  // ===========================================================================

  /**
   * List all known marketplaces with their plugin catalogs.
   */
  async listMarketplaces(): Promise<MarketplaceInfo[]> {
    const results: MarketplaceInfo[] = [];

    for (const [name, entry] of Object.entries(this.knownMarketplaces)) {
      try {
        const manifest = await this.readMarketplaceManifest(entry.installLocation);
        if (manifest) {
          results.push({
            name: manifest.name,
            description: manifest.description,
            owner: manifest.owner.name,
            source: entry.source,
            lastUpdated: entry.lastUpdated,
            plugins: manifest.plugins,
          });
        } else {
          results.push({
            name,
            description: '(manifest unavailable)',
            owner: 'unknown',
            source: entry.source,
            lastUpdated: entry.lastUpdated,
            plugins: [],
          });
        }
      } catch (error) {
        logger.warn(`[MarketplaceManager] Could not read manifest for '${name}': ${formatError(error)}`);
        results.push({
          name,
          description: '(error reading manifest)',
          owner: 'unknown',
          source: entry.source,
          lastUpdated: entry.lastUpdated,
          plugins: [],
        });
      }
    }

    return results;
  }

  /**
   * Get the manifest for a specific marketplace.
   */
  async getMarketplaceManifest(name: string): Promise<MarketplaceManifest | null> {
    const entry = this.knownMarketplaces[name];
    if (!entry) return null;
    return this.readMarketplaceManifest(entry.installLocation);
  }

  /**
   * List all available plugins across all marketplaces (or a specific one).
   */
  async listAvailablePlugins(marketplace?: string): Promise<Array<MarketplacePluginEntry & { marketplace: string }>> {
    const results: Array<MarketplacePluginEntry & { marketplace: string }> = [];
    const names = marketplace ? [marketplace] : Object.keys(this.knownMarketplaces);

    for (const name of names) {
      const manifest = await this.getMarketplaceManifest(name);
      if (manifest) {
        for (const plugin of manifest.plugins) {
          results.push({ ...plugin, marketplace: name });
        }
      }
    }

    return results;
  }

  /**
   * Resolve the absolute path to a plugin's source directory within a marketplace.
   */
  resolvePluginSourcePath(marketplace: string, pluginName: string, manifest: MarketplaceManifest): string | null {
    const entry = this.knownMarketplaces[marketplace];
    if (!entry) return null;

    const pluginEntry = manifest.plugins.find(p => p.name === pluginName);
    if (!pluginEntry) return null;

    return join(entry.installLocation, pluginEntry.source);
  }

  /**
   * Get a known marketplace entry by name.
   */
  getMarketplaceEntry(name: string): KnownMarketplaceEntry | undefined {
    return this.knownMarketplaces[name];
  }

  /**
   * Check if a marketplace is registered.
   */
  hasMarketplace(name: string): boolean {
    return name in this.knownMarketplaces;
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  private async resolveSourceLocation(source: MarketplaceSource): Promise<string> {
    if (source.type === 'directory') {
      if (!source.path) {
        throw new Error('Directory source requires a path');
      }
      // Verify directory exists
      try {
        await access(source.path, constants.R_OK);
      } catch {
        throw new Error(`Directory not accessible: ${source.path}`);
      }
      return source.path;
    }

    if (source.type === 'github') {
      if (!source.repo) {
        throw new Error('GitHub source requires a repo (owner/name)');
      }
      // Clone to cache dir
      const name = source.repo.replace('/', '-');
      const cloneDir = join(MARKETPLACE_CACHE_DIR, name);
      try {
        await access(join(cloneDir, '.git'), constants.F_OK);
        // Already exists, pull
        await execFileAsync('git', ['-C', cloneDir, 'pull', '--ff-only']);
      } catch {
        await mkdir(cloneDir, { recursive: true });
        const repoUrl = `https://github.com/${source.repo}.git`;
        await execFileAsync('git', ['clone', repoUrl, cloneDir]);
      }
      return cloneDir;
    }

    throw new Error(`Unknown source type: ${(source as any).type}`);
  }

  private async readMarketplaceManifest(location: string): Promise<MarketplaceManifest | null> {
    const manifestPath = join(location, '.claude-plugin', 'marketplace.json');
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as MarketplaceManifest;

      // Basic validation
      if (!manifest.name || !manifest.plugins || !Array.isArray(manifest.plugins)) {
        logger.warn(`[MarketplaceManager] Invalid manifest at ${manifestPath}: missing name or plugins`);
        return null;
      }

      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.warn(`[MarketplaceManager] Error reading ${manifestPath}: ${formatError(error)}`);
      return null;
    }
  }

  private async loadKnownMarketplaces(): Promise<void> {
    try {
      const raw = await readFile(KNOWN_MARKETPLACES_FILE, 'utf-8');
      this.knownMarketplaces = JSON.parse(raw) as KnownMarketplacesFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.knownMarketplaces = {};
      } else {
        logger.error(`[MarketplaceManager] Error loading known marketplaces: ${formatError(error)}`);
        this.knownMarketplaces = {};
      }
    }
  }

  private async saveKnownMarketplaces(): Promise<void> {
    await mkdir(MARKETPLACE_DIR, { recursive: true });
    await writeFile(
      KNOWN_MARKETPLACES_FILE,
      JSON.stringify(this.knownMarketplaces, null, 2),
      'utf-8'
    );
  }
}
