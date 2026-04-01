/**
 * PluginManager - Manages plugin installation, uninstallation, updates, and enabled state.
 *
 * Plugins are installed from marketplaces into a local cache. Each installed plugin
 * is tracked in installed_plugins.json with version, path, and enabled state.
 */

import { readFile, writeFile, mkdir, rm, cp, access } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import {
  INSTALLED_PLUGINS_FILE,
  BLOCKLIST_FILE,
  PLUGIN_CACHE_DIR,
  MARKETPLACE_DIR,
} from './constants.js';
import type { MarketplaceManager } from './MarketplaceManager.js';
import type {
  InstalledPluginsFile,
  InstalledPluginEntry,
  BlocklistFile,
  PluginManifest,
  PluginMCPConfig,
  PluginInstallResult,
  PluginUninstallResult,
} from './types.js';
import type { IService } from '../types/index.js';

export class PluginManager implements IService {
  private installedPlugins: InstalledPluginsFile = { version: 2, plugins: {} };
  private blocklist: BlocklistFile = { fetchedAt: '', plugins: [] };
  private initialized = false;

  constructor(private marketplaceManager: MarketplaceManager) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await mkdir(PLUGIN_CACHE_DIR, { recursive: true });
    await this.loadInstalledPlugins();
    await this.loadBlocklist();
    this.initialized = true;
  }

  async cleanup(): Promise<void> {
    this.installedPlugins = { version: 2, plugins: {} };
    this.initialized = false;
  }

  // ===========================================================================
  // Plugin Installation
  // ===========================================================================

  /**
   * Install a plugin from a marketplace into the local cache.
   */
  async install(marketplace: string, pluginName: string): Promise<PluginInstallResult> {
    const pluginKey = `${pluginName}@${marketplace}`;

    // Check blocklist
    if (this.isBlocked(pluginName, marketplace)) {
      return {
        success: false,
        pluginName,
        marketplace,
        version: '',
        installPath: '',
        error: `Plugin '${pluginKey}' is blocked`,
      };
    }

    // Get marketplace manifest to find the plugin
    const manifest = await this.marketplaceManager.getMarketplaceManifest(marketplace);
    if (!manifest) {
      return {
        success: false,
        pluginName,
        marketplace,
        version: '',
        installPath: '',
        error: `Marketplace '${marketplace}' not found or has no manifest`,
      };
    }

    const pluginEntry = manifest.plugins.find(p => p.name === pluginName);
    if (!pluginEntry) {
      return {
        success: false,
        pluginName,
        marketplace,
        version: '',
        installPath: '',
        error: `Plugin '${pluginName}' not found in marketplace '${marketplace}'`,
      };
    }

    // Resolve source path
    const sourcePath = this.marketplaceManager.resolvePluginSourcePath(
      marketplace,
      pluginName,
      manifest
    );
    if (!sourcePath) {
      return {
        success: false,
        pluginName,
        marketplace,
        version: pluginEntry.version,
        installPath: '',
        error: `Could not resolve source path for '${pluginName}'`,
      };
    }

    // Validate source has plugin.json
    const sourceManifest = await this.readPluginManifest(sourcePath);
    if (!sourceManifest) {
      return {
        success: false,
        pluginName,
        marketplace,
        version: pluginEntry.version,
        installPath: '',
        error: `No valid .claude-plugin/plugin.json at ${sourcePath}`,
      };
    }

    const version = sourceManifest.version || pluginEntry.version || '0.0.0';
    const installPath = join(PLUGIN_CACHE_DIR, marketplace, pluginName, version);

    // Check if already installed at this version
    const existing = this.getInstalledEntry(pluginKey);
    if (existing && existing.version === version) {
      logger.info(`[PluginManager] Plugin '${pluginKey}' v${version} already installed`);
      const mcpConfig = await this.getPluginMCPConfig(existing.installPath);
      return {
        success: true,
        pluginName,
        marketplace,
        version,
        installPath: existing.installPath,
        mcpConfig: mcpConfig || undefined,
      };
    }

    // Copy plugin to cache
    try {
      await rm(installPath, { recursive: true, force: true });
      await mkdir(installPath, { recursive: true });
      await cp(sourcePath, installPath, { recursive: true });
    } catch (error) {
      // Clean up partial copy
      await rm(installPath, { recursive: true, force: true }).catch(() => {});
      return {
        success: false,
        pluginName,
        marketplace,
        version,
        installPath: '',
        error: `Failed to copy plugin: ${formatError(error)}`,
      };
    }

    // Update installed_plugins.json
    const entry: InstalledPluginEntry = {
      scope: 'user',
      version,
      installPath,
      marketplace,
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      enabled: true,
    };

    // Replace any existing entries for this key
    this.installedPlugins.plugins[pluginKey] = [entry];
    await this.saveInstalledPlugins();

    // Read MCP config from installed copy
    const mcpConfig = await this.getPluginMCPConfig(installPath);

    logger.info(`[PluginManager] Installed '${pluginKey}' v${version} to ${installPath}`);

    return {
      success: true,
      pluginName,
      marketplace,
      version,
      installPath,
      mcpConfig: mcpConfig || undefined,
    };
  }

  /**
   * Uninstall a plugin.
   * @param pluginKey - Either "pluginName" or "pluginName@marketplace"
   */
  async uninstall(pluginKey: string): Promise<PluginUninstallResult> {
    const resolvedKey = this.resolvePluginKey(pluginKey);
    if (!resolvedKey) {
      return { success: false, pluginName: pluginKey, error: `Plugin '${pluginKey}' is not installed` };
    }

    const entry = this.getInstalledEntry(resolvedKey);
    if (entry) {
      // Remove cache directory
      try {
        await rm(entry.installPath, { recursive: true, force: true });
      } catch (error) {
        logger.warn(`[PluginManager] Failed to remove cache for '${resolvedKey}': ${formatError(error)}`);
      }
    }

    delete this.installedPlugins.plugins[resolvedKey];
    await this.saveInstalledPlugins();

    const pluginName = resolvedKey.split('@')[0] ?? resolvedKey;
    logger.info(`[PluginManager] Uninstalled '${resolvedKey}'`);
    return { success: true, pluginName };
  }

  /**
   * Update a plugin to the latest version from its marketplace.
   */
  async update(pluginKey: string): Promise<PluginInstallResult> {
    const resolvedKey = this.resolvePluginKey(pluginKey);
    if (!resolvedKey) {
      return {
        success: false,
        pluginName: pluginKey,
        marketplace: '',
        version: '',
        installPath: '',
        error: `Plugin '${pluginKey}' is not installed`,
      };
    }

    const entry = this.getInstalledEntry(resolvedKey);
    if (!entry) {
      return {
        success: false,
        pluginName: pluginKey,
        marketplace: '',
        version: '',
        installPath: '',
        error: `Plugin '${pluginKey}' has no install entry`,
      };
    }

    const parts = resolvedKey.split('@');
    const pluginName = parts[0] ?? '';
    const marketplace = parts[1] ?? '';

    // Re-install from marketplace (will detect version change)
    return this.install(marketplace, pluginName);
  }

  // ===========================================================================
  // State Queries
  // ===========================================================================

  /**
   * Get all installed plugin entries (flat list).
   */
  getInstalledPlugins(): Array<InstalledPluginEntry & { pluginKey: string; pluginName: string }> {
    const results: Array<InstalledPluginEntry & { pluginKey: string; pluginName: string }> = [];
    for (const [key, entries] of Object.entries(this.installedPlugins.plugins)) {
      for (const entry of entries) {
        results.push({
          ...entry,
          pluginKey: key,
          pluginName: key.split('@')[0] ?? key,
        });
      }
    }
    return results;
  }

  /**
   * Get only enabled installed plugins.
   */
  getEnabledPlugins(): Array<InstalledPluginEntry & { pluginKey: string; pluginName: string }> {
    return this.getInstalledPlugins().filter(p => p.enabled);
  }

  /**
   * Check if a plugin (by name, ignoring marketplace) is enabled.
   */
  isPluginEnabled(pluginName: string): boolean {
    for (const [key, entries] of Object.entries(this.installedPlugins.plugins)) {
      if (key.startsWith(pluginName + '@')) {
        return entries.some(e => e.enabled);
      }
    }
    return false;
  }

  /**
   * Toggle enabled state of a plugin.
   */
  async setEnabled(pluginKey: string, enabled: boolean): Promise<boolean> {
    const resolvedKey = this.resolvePluginKey(pluginKey);
    if (!resolvedKey) return false;

    const entries = this.installedPlugins.plugins[resolvedKey];
    if (!entries || entries.length === 0) return false;

    entries[0]!.enabled = enabled;
    entries[0]!.lastUpdated = new Date().toISOString();
    await this.saveInstalledPlugins();
    return true;
  }

  /**
   * Check if a plugin is on the blocklist.
   */
  isBlocked(pluginName: string, marketplace: string): boolean {
    const key = `${pluginName}@${marketplace}`;
    return this.blocklist.plugins.some(b => b.plugin === key);
  }

  /**
   * Check if a plugin is installed.
   */
  isInstalled(pluginKey: string): boolean {
    return this.resolvePluginKey(pluginKey) !== null;
  }

  // ===========================================================================
  // Plugin File Reading
  // ===========================================================================

  /**
   * Read .claude-plugin/plugin.json from a plugin directory.
   */
  async readPluginManifest(pluginPath: string): Promise<PluginManifest | null> {
    const manifestPath = join(pluginPath, '.claude-plugin', 'plugin.json');
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      return JSON.parse(raw) as PluginManifest;
    } catch {
      return null;
    }
  }

  /**
   * Read .mcp.json from a plugin directory and perform variable substitution.
   */
  async getPluginMCPConfig(pluginPath: string): Promise<PluginMCPConfig | null> {
    const configPath = join(pluginPath, '.mcp.json');
    try {
      const raw = await readFile(configPath, 'utf-8');
      const config = JSON.parse(raw) as PluginMCPConfig;

      // Perform variable substitution
      for (const [_serverKey, serverConfig] of Object.entries(config)) {
        // Substitute args
        if (serverConfig.args) {
          serverConfig.args = serverConfig.args.map(arg =>
            this.substituteVars(arg, pluginPath)
          );
        }

        // Substitute command
        serverConfig.command = this.substituteVars(serverConfig.command, pluginPath);

        // Substitute env values
        if (serverConfig.env) {
          const substitutedEnv: Record<string, string> = {};
          for (const [envKey, envVal] of Object.entries(serverConfig.env)) {
            substitutedEnv[envKey] = this.substituteVars(envVal, pluginPath);
          }
          serverConfig.env = substitutedEnv;
        }
      }

      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null; // Plugin has no MCP servers, just commands/skills
      }
      logger.warn(`[PluginManager] Error reading .mcp.json at ${configPath}: ${formatError(error)}`);
      return null;
    }
  }

  /**
   * Check if a plugin has commands (commands/ directory).
   */
  async hasCommands(pluginPath: string): Promise<boolean> {
    try {
      await access(join(pluginPath, 'commands'), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a plugin has skills (skills/ directory).
   */
  async hasSkills(pluginPath: string): Promise<boolean> {
    try {
      await access(join(pluginPath, 'skills'), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  /**
   * Resolve a plugin key that might be just a name (without @marketplace) to a full key.
   * Returns null if not found.
   */
  private resolvePluginKey(input: string): string | null {
    // If already a full key
    if (this.installedPlugins.plugins[input]) {
      return input;
    }

    // Search by plugin name prefix
    for (const key of Object.keys(this.installedPlugins.plugins)) {
      if (key.startsWith(input + '@')) {
        return key;
      }
    }

    return null;
  }

  private getInstalledEntry(pluginKey: string): InstalledPluginEntry | null {
    const entries = this.installedPlugins.plugins[pluginKey];
    if (!entries || entries.length === 0) return null;
    return entries[0] ?? null;
  }

  /**
   * Substitute ${CLAUDE_PLUGIN_ROOT} and ${ENV_VAR} in a string value.
   */
  private substituteVars(value: string, pluginPath: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      if (varName === 'CLAUDE_PLUGIN_ROOT') {
        return pluginPath;
      }
      const envVal = process.env[varName];
      if (envVal === undefined) {
        logger.warn(`[PluginManager] Environment variable '${varName}' is not set`);
        return '';
      }
      return envVal;
    });
  }

  private async loadInstalledPlugins(): Promise<void> {
    try {
      const raw = await readFile(INSTALLED_PLUGINS_FILE, 'utf-8');
      this.installedPlugins = JSON.parse(raw) as InstalledPluginsFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.installedPlugins = { version: 2, plugins: {} };
      } else {
        logger.error(`[PluginManager] Error loading installed plugins: ${formatError(error)}`);
        this.installedPlugins = { version: 2, plugins: {} };
      }
    }
  }

  private async saveInstalledPlugins(): Promise<void> {
    await mkdir(MARKETPLACE_DIR, { recursive: true });
    await writeFile(
      INSTALLED_PLUGINS_FILE,
      JSON.stringify(this.installedPlugins, null, 2),
      'utf-8'
    );
  }

  private async loadBlocklist(): Promise<void> {
    try {
      const raw = await readFile(BLOCKLIST_FILE, 'utf-8');
      this.blocklist = JSON.parse(raw) as BlocklistFile;
    } catch {
      this.blocklist = { fetchedAt: '', plugins: [] };
    }
  }
}
