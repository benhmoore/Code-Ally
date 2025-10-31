/**
 * Plugin service interfaces
 *
 * Type-safe interfaces for plugin-related services registered in ServiceRegistry.
 */

import type { BaseTool } from '../tools/BaseTool.js';
import type { PluginConfigSchema } from './PluginLoader.js';

/**
 * Plugin configuration management service
 */
export interface PluginConfigManagerService {
  /**
   * Save plugin configuration with encryption for secret fields
   */
  saveConfig(
    pluginName: string,
    pluginPath: string,
    config: any,
    schema?: PluginConfigSchema
  ): Promise<void>;

  /**
   * Load plugin configuration with decryption for secret fields
   */
  loadConfig(
    pluginName: string,
    pluginPath: string,
    schema?: PluginConfigSchema
  ): Promise<any | null>;

  /**
   * Check if all required configuration fields are present and valid
   */
  isConfigComplete(
    pluginName: string,
    pluginPath: string,
    schema: PluginConfigSchema
  ): Promise<boolean>;
}

/**
 * Plugin installation result
 */
export interface PluginInstallResult {
  success: boolean;
  pluginName?: string;
  tools?: BaseTool[];
  error?: string;
}

/**
 * Plugin uninstallation result
 */
export interface PluginUninstallResult {
  success: boolean;
  error?: string;
}

/**
 * Plugin load result
 */
export interface PluginLoadResult {
  tools: BaseTool[];
  pluginCount: number;
}

/**
 * Plugin loader service
 */
export interface PluginLoaderService {
  /**
   * Load all plugins from directory
   */
  loadPlugins(pluginDir: string): Promise<PluginLoadResult>;

  /**
   * Install plugin from local filesystem path
   */
  installFromPath(
    sourcePath: string,
    pluginsDir: string
  ): Promise<PluginInstallResult>;

  /**
   * Uninstall plugin by name
   */
  uninstall(
    pluginName: string,
    pluginsDir: string
  ): Promise<PluginUninstallResult>;

  /**
   * Reload plugin after configuration
   */
  reloadPlugin(pluginName: string, pluginPath: string): Promise<BaseTool[]>;
}

/**
 * Tool manager service
 */
export interface ToolManagerService {
  /**
   * Register multiple tools at once
   */
  registerTools(tools: BaseTool[]): void;

  /**
   * Register a single tool
   */
  registerTool(tool: BaseTool): void;

  /**
   * Unregister a tool by name
   */
  unregisterTool(toolName: string): void;
}
