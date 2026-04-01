/**
 * Marketplace and Plugin type definitions
 *
 * Defines all types for the Claude-style marketplace plugin system.
 */

import type { BaseTool } from '../tools/BaseTool.js';

// ============================================================================
// Marketplace Manifest (.claude-plugin/marketplace.json)
// ============================================================================

/**
 * Root marketplace manifest found at .claude-plugin/marketplace.json
 */
export interface MarketplaceManifest {
  name: string;
  description: string;
  owner: { name: string };
  plugins: MarketplacePluginEntry[];
}

/**
 * A single plugin entry in a marketplace manifest
 */
export interface MarketplacePluginEntry {
  name: string;
  /** Relative path from marketplace root to plugin directory */
  source: string;
  description: string;
  version: string;
}

// ============================================================================
// Plugin Manifest (.claude-plugin/plugin.json)
// ============================================================================

/**
 * Plugin metadata found at .claude-plugin/plugin.json within each plugin
 */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: { name: string };
}

// ============================================================================
// MCP Server Config (.mcp.json)
// ============================================================================

/**
 * Single MCP server entry within .mcp.json
 */
export interface PluginMCPServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Full .mcp.json file -- keys are server names
 */
export type PluginMCPConfig = Record<string, PluginMCPServerEntry>;

// ============================================================================
// Installed Plugins State (~/.ally/plugins/installed_plugins.json)
// ============================================================================

/**
 * Root structure of installed_plugins.json
 */
export interface InstalledPluginsFile {
  version: 2;
  plugins: Record<string, InstalledPluginEntry[]>;
}

/**
 * A single installed plugin entry.
 * Key in the parent record is "pluginName@marketplaceName".
 */
export interface InstalledPluginEntry {
  scope: 'user';
  version: string;
  /** Absolute path to the plugin in cache */
  installPath: string;
  marketplace: string;
  installedAt: string;
  lastUpdated: string;
  enabled: boolean;
}

// ============================================================================
// Known Marketplaces (~/.ally/plugins/known_marketplaces.json)
// ============================================================================

export interface MarketplaceSource {
  type: 'directory' | 'github';
  /** For directory sources: absolute filesystem path */
  path?: string;
  /** For github sources: owner/repo */
  repo?: string;
}

export interface KnownMarketplaceEntry {
  source: MarketplaceSource;
  /** Where the marketplace is stored/cached */
  installLocation: string;
  lastUpdated: string;
}

export type KnownMarketplacesFile = Record<string, KnownMarketplaceEntry>;

// ============================================================================
// Blocklist (~/.ally/plugins/blocklist.json)
// ============================================================================

export interface BlocklistEntry {
  /** Format: "pluginName@marketplaceName" */
  plugin: string;
  added_at: string;
  reason: string;
  text: string;
}

export interface BlocklistFile {
  fetchedAt: string;
  plugins: BlocklistEntry[];
}

// ============================================================================
// Service Interfaces
// ============================================================================

/**
 * Tool manager service interface (used by MCPCommand and MarketplaceCommand)
 */
export interface ToolManagerService {
  registerTools(tools: BaseTool[]): void;
  registerTool(tool: BaseTool): void;
  unregisterTool(toolName: string): void;
}

// ============================================================================
// Result Types
// ============================================================================

export interface PluginInstallResult {
  success: boolean;
  pluginName: string;
  marketplace: string;
  version: string;
  installPath: string;
  mcpConfig?: PluginMCPConfig;
  error?: string;
}

export interface PluginUninstallResult {
  success: boolean;
  pluginName: string;
  error?: string;
}

/**
 * Information about a marketplace and its available plugins
 */
export interface MarketplaceInfo {
  name: string;
  description: string;
  owner: string;
  source: MarketplaceSource;
  lastUpdated: string;
  plugins: MarketplacePluginEntry[];
}
