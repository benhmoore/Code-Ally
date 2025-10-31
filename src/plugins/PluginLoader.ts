/**
 * PluginLoader - Dynamic plugin loading system for Ally
 *
 * Enables extending Ally with custom tools through a plugin architecture.
 * Supports executable plugins (Python, shell scripts, etc.) that communicate
 * via stdio.
 *
 * Plugin Structure:
 * - Each plugin lives in its own directory under the plugins folder
 * - Must contain a plugin.json manifest file describing the plugin
 * - Plugins are executable programs wrapped automatically
 *
 * Example plugin.json:
 * {
 *   "name": "my-tool",
 *   "version": "1.0.0",
 *   "description": "Does something useful",
 *   "command": "python3",
 *   "args": ["tool.py"],
 *   "requiresConfirmation": false
 * }
 */

import { BaseTool } from '../tools/BaseTool.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityEventType } from '../types/index.js';
import { PluginConfigManager } from './PluginConfigManager.js';
import { PluginEnvironmentManager } from './PluginEnvironmentManager.js';
import { PLUGIN_FILES } from './constants.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../services/Logger.js';

/**
 * Plugin manifest schema
 *
 * Describes the metadata and configuration for a plugin toolset.
 * Every plugin is a toolset (even single-tool plugins).
 */
export interface PluginManifest {
  /** Unique plugin identifier (should match directory name) */
  name: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** Human-readable description of what the plugin does */
  description: string;

  /** Plugin author information (optional) */
  author?: string;

  /** Array of tools provided by this plugin */
  tools: ToolDefinition[];

  /** Configuration schema for interactive setup (optional) */
  config?: PluginConfigSchema;

  /** Runtime environment (e.g., 'python3', 'node') */
  runtime?: string;

  /** Dependency specification for automatic installation */
  dependencies?: {
    /** Dependencies file (e.g., "requirements.txt", "package.json") */
    file: string;
    /** Optional custom install command */
    install_command?: string;
  };

  // Backward compatibility fields (deprecated)
  /** @deprecated Use tools array instead */
  command?: string;
  /** @deprecated Use tools array instead */
  args?: string[];
  /** @deprecated Use tools array instead */
  requiresConfirmation?: boolean;
  /** @deprecated Use tools array instead */
  schema?: any;
}

/**
 * Individual tool definition within a plugin toolset
 */
export interface ToolDefinition {
  /** Tool name (will be exposed to LLM) */
  name: string;

  /** Tool description for LLM */
  description: string;

  /** Command to execute */
  command: string;

  /** Command arguments */
  args?: string[];

  /** Requires user confirmation before execution */
  requiresConfirmation?: boolean;

  /** Timeout in milliseconds (default: 120000) */
  timeout?: number;

  /** JSON Schema for tool parameters */
  schema?: any;

  /** Optional usage guidance to inject into agent system prompt */
  usageGuidance?: string;
}

/**
 * Plugin configuration schema
 */
export interface PluginConfigSchema {
  schema: {
    type: 'object';
    properties: Record<string, ConfigProperty>;
  };
}

/**
 * Configuration property definition
 */
export interface ConfigProperty {
  type: 'string' | 'number' | 'boolean' | 'integer';
  description: string;
  required?: boolean;
  secret?: boolean;
  default?: any;
}

/**
 * Pending plugin config requests (stored at module level for UI to check on mount)
 */
let pendingConfigRequests: Array<{
  pluginName: string;
  pluginPath: string;
  schema: PluginConfigSchema;
}> = [];

/**
 * PluginLoader - Discovers and loads plugins from the plugins directory
 *
 * Loads executable plugins with comprehensive error handling to ensure
 * one broken plugin doesn't prevent others from loading.
 */
export class PluginLoader {
  private activityStream: ActivityStream;
  private configManager: PluginConfigManager;
  private envManager: PluginEnvironmentManager;

  constructor(activityStream: ActivityStream, configManager: PluginConfigManager) {
    this.activityStream = activityStream;
    this.configManager = configManager;
    this.envManager = new PluginEnvironmentManager();
  }

  /**
   * Get any pending configuration requests
   * Returns the first pending request and removes it from the queue
   */
  static getPendingConfigRequest(): { pluginName: string; pluginPath: string; schema: PluginConfigSchema } | null {
    if (pendingConfigRequests.length === 0) {
      return null;
    }
    return pendingConfigRequests.shift() || null;
  }

  /**
   * Clear all pending configuration requests
   */
  static clearPendingConfigRequests(): void {
    pendingConfigRequests = [];
  }

  /**
   * Install a plugin from a local filesystem path
   *
   * Validates the plugin manifest, copies it to the plugins directory,
   * and loads it (triggering dependency installation if needed).
   *
   * @param sourcePath - Absolute path to the plugin directory
   * @param pluginsDir - Target plugins directory (defaults to PLUGINS_DIR)
   * @returns Object with success status, plugin name, and loaded tools
   */
  async installFromPath(
    sourcePath: string,
    pluginsDir: string
  ): Promise<{
    success: boolean;
    pluginName?: string;
    tools?: BaseTool[];
    error?: string;
  }> {
    try {
      // Validate source path exists
      try {
        const stat = await fs.stat(sourcePath);
        if (!stat.isDirectory()) {
          return { success: false, error: 'Source path is not a directory' };
        }
      } catch {
        return { success: false, error: 'Source path does not exist' };
      }

      // Read and validate manifest
      const manifestPath = join(sourcePath, PLUGIN_FILES.MANIFEST);
      let manifest: PluginManifest;

      try {
        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(manifestContent);
      } catch (error) {
        return {
          success: false,
          error: `Invalid or missing ${PLUGIN_FILES.MANIFEST}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      // Validate required manifest fields
      if (!manifest.name) {
        return { success: false, error: 'Plugin manifest missing required field: name' };
      }

      if (!manifest.tools || manifest.tools.length === 0) {
        return { success: false, error: 'Plugin manifest missing or empty tools array' };
      }

      // Check if plugin already exists - if so, remove it (update scenario)
      const targetPath = join(pluginsDir, manifest.name);
      let isUpdate = false;
      try {
        await fs.access(targetPath);
        isUpdate = true;
        logger.info(`[PluginLoader] Updating existing plugin '${manifest.name}'`);
        await fs.rm(targetPath, { recursive: true, force: true });
      } catch {
        // Target doesn't exist - fresh install
      }

      // Copy plugin directory to plugins folder
      logger.info(
        `[PluginLoader] ${isUpdate ? 'Updating' : 'Installing'} plugin '${manifest.name}' from ${sourcePath}`
      );
      await this.copyDirectory(sourcePath, targetPath);

      // Load the plugin (this triggers dependency installation)
      const tools = await this.loadPlugin(targetPath);

      // If no tools loaded, check if it's because config is needed (not an error)
      if (tools.length === 0) {
        // Check if plugin requires configuration
        if (manifest.config) {
          const isComplete = await this.configManager.isConfigComplete(
            manifest.name,
            targetPath,
            manifest.config
          );

          if (!isComplete) {
            // Plugin needs configuration - this is expected, not an error
            logger.info(
              `[PluginLoader] ✓ Plugin '${manifest.name}' installed successfully. Configuration required before use.`
            );
            return {
              success: true,
              pluginName: manifest.name,
              tools: [],
            };
          }
        }

        // Not a config issue - actual failure
        return {
          success: false,
          error: 'Plugin installed but failed to load tools. Check logs for details.',
        };
      }

      logger.info(
        `[PluginLoader] ✓ Plugin '${manifest.name}' installed successfully with ${tools.length} tool(s)`
      );

      return {
        success: true,
        pluginName: manifest.name,
        tools,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to install plugin: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Uninstall a plugin
   *
   * Removes the plugin directory and its virtual environment.
   *
   * @param pluginName - Name of the plugin to uninstall
   * @param pluginsDir - Plugins directory (defaults to PLUGINS_DIR)
   * @returns Object with success status and error if any
   */
  async uninstall(
    pluginName: string,
    pluginsDir: string
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const pluginPath = join(pluginsDir, pluginName);

      // Check if plugin exists
      try {
        await fs.access(pluginPath);
      } catch {
        return {
          success: false,
          error: `Plugin '${pluginName}' not found`,
        };
      }

      // Remove plugin directory
      logger.info(`[PluginLoader] Uninstalling plugin '${pluginName}'`);
      await fs.rm(pluginPath, { recursive: true, force: true });

      // Remove plugin environment if it exists
      await this.envManager.removeEnvironment(pluginName);

      logger.info(`[PluginLoader] ✓ Plugin '${pluginName}' uninstalled successfully`);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Failed to uninstall plugin: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Copy directory recursively
   *
   * @param src - Source directory
   * @param dest - Destination directory
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    // Create destination directory
    await fs.mkdir(dest, { recursive: true });

    // Read source directory
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);

      if (entry.isDirectory()) {
        // Skip certain directories
        if (entry.name === 'venv' || entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === '.git') {
          continue;
        }
        // Recursively copy subdirectory
        await this.copyDirectory(srcPath, destPath);
      } else {
        // Copy file
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Load all plugins from the specified directory
   *
   * Creates the directory if it doesn't exist, then scans for subdirectories
   * containing plugin.json manifests. Each valid plugin is loaded and returned
   * as a BaseTool instance.
   *
   * @param pluginDir - Path to the plugins directory
   * @returns Array of loaded tool instances
   */
  async loadPlugins(pluginDir: string): Promise<{ tools: BaseTool[], pluginCount: number }> {
    const tools: BaseTool[] = [];
    let pluginCount = 0;

    try {
      // Ensure the plugins directory exists
      await fs.mkdir(pluginDir, { recursive: true });
      logger.debug(`[PluginLoader] Scanning plugins directory: ${pluginDir}`);

      // Read all entries in the plugins directory
      let entries: string[];
      try {
        entries = await fs.readdir(pluginDir);
      } catch (error) {
        logger.warn(
          `[PluginLoader] Failed to read plugins directory: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return { tools, pluginCount };
      }

      // Filter to only directories (each plugin should be in its own subdirectory)
      const pluginDirs: string[] = [];
      for (const entry of entries) {
        const entryPath = join(pluginDir, entry);
        try {
          const stat = await fs.stat(entryPath);
          if (stat.isDirectory()) {
            pluginDirs.push(entryPath);
          }
        } catch (error) {
          // Skip entries we can't stat (permissions, broken symlinks, etc.)
          logger.debug(
            `[PluginLoader] Skipping ${entry}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      if (pluginDirs.length === 0) {
        logger.debug('[PluginLoader] No plugin directories found');
        return { tools, pluginCount };
      }

      logger.debug(`[PluginLoader] Found ${pluginDirs.length} potential plugin(s)`);

      // Attempt to load each plugin
      for (const pluginPath of pluginDirs) {
        try {
          const pluginTools = await this.loadPlugin(pluginPath);
          if (pluginTools.length > 0) {
            tools.push(...pluginTools);
            pluginCount++;
            logger.debug(
              `[PluginLoader] Successfully loaded plugin with ${pluginTools.length} tool(s): ${pluginTools.map(t => t.name).join(', ')}`
            );
          }
        } catch (error) {
          // Log the error but continue loading other plugins
          logger.warn(
            `[PluginLoader] Failed to load plugin from ${pluginPath}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      logger.debug(`[PluginLoader] Successfully loaded ${pluginCount} plugin(s) with ${tools.length} tool(s)`);
    } catch (error) {
      // Catch-all for unexpected errors during the loading process
      logger.error(
        `[PluginLoader] Unexpected error during plugin loading: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return { tools, pluginCount };
  }

  /**
   * Reload a single plugin after configuration
   *
   * Used to reload a plugin after its configuration has been provided.
   * Reads the manifest, loads the configuration, and returns loaded tools.
   *
   * @param pluginName - Name of the plugin to reload
   * @param pluginPath - Path to the plugin directory
   * @returns Array of loaded tool instances
   */
  async reloadPlugin(pluginName: string, pluginPath: string): Promise<BaseTool[]> {
    logger.info(`[PluginLoader] Reloading plugin '${pluginName}' from ${pluginPath}`);

    try {
      const tools = await this.loadPlugin(pluginPath);

      if (tools.length > 0) {
        logger.info(
          `[PluginLoader] Successfully reloaded plugin '${pluginName}' with ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`
        );
      } else {
        logger.warn(`[PluginLoader] No tools loaded when reloading plugin '${pluginName}'`);
      }

      return tools;
    } catch (error) {
      logger.error(
        `[PluginLoader] Failed to reload plugin '${pluginName}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }

  /**
   * Load a single plugin from a directory
   *
   * Reads and validates the plugin manifest, then creates
   * ExecutableToolWrapper instances for each tool in the toolset.
   *
   * @param pluginPath - Path to the plugin directory
   * @returns Array of loaded tool instances
   */
  private async loadPlugin(pluginPath: string): Promise<BaseTool[]> {
    const manifestPath = join(pluginPath, PLUGIN_FILES.MANIFEST);

    // Check if manifest exists
    try {
      await fs.access(manifestPath);
    } catch {
      logger.warn(
        `[PluginLoader] Skipping ${pluginPath}: No ${PLUGIN_FILES.MANIFEST} manifest found`
      );
      return [];
    }

    // Read and parse the manifest
    let manifest: PluginManifest;
    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(manifestContent);
    } catch (error) {
      logger.error(
        `[PluginLoader] Failed to parse ${PLUGIN_FILES.MANIFEST} in ${pluginPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return [];
    }

    // Validate required fields
    if (!manifest.name) {
      logger.error(
        `[PluginLoader] Invalid manifest in ${pluginPath}: Missing required field 'name'`
      );
      return [];
    }

    // Backward compatibility: convert old single-tool format to toolset
    if (!manifest.tools && manifest.command) {
      logger.info(
        `[PluginLoader] Converting legacy plugin '${manifest.name}' to toolset format`
      );
      manifest.tools = [
        {
          name: manifest.name.replace(/-/g, '_'),
          description: manifest.description,
          command: manifest.command,
          args: manifest.args,
          requiresConfirmation: manifest.requiresConfirmation,
          schema: manifest.schema,
        },
      ];
    }

    // Validate tools array
    if (!manifest.tools || manifest.tools.length === 0) {
      logger.error(
        `[PluginLoader] Invalid manifest in ${pluginPath}: Missing or empty 'tools' array`
      );
      return [];
    }

    // Check if plugin requires configuration
    let pluginConfig: any = null;
    if (manifest.config) {
      const isComplete = await this.configManager.isConfigComplete(
        manifest.name,
        pluginPath,
        manifest.config
      );

      if (!isComplete) {
        // Config is incomplete, store pending request and emit event
        logger.info(
          `[PluginLoader] Plugin '${manifest.name}' requires configuration. Storing pending request and emitting event.`
        );

        // Store the request so UI can pick it up on mount
        pendingConfigRequests.push({
          pluginName: manifest.name,
          pluginPath: pluginPath,
          schema: manifest.config,
        });

        // Also emit event (in case UI is already mounted)
        this.activityStream.emit({
          id: `plugin-config-${manifest.name}-${Date.now()}`,
          type: ActivityEventType.PLUGIN_CONFIG_REQUEST,
          timestamp: Date.now(),
          data: {
            pluginName: manifest.name,
            pluginPath: pluginPath,
            schema: manifest.config,
          },
        });

        logger.debug(
          `[PluginLoader] Plugin '${manifest.name}' waiting for configuration - returning empty tools array`
        );
        return [];
      }

      // Config is complete, load it
      try {
        pluginConfig = await this.configManager.loadConfig(
          manifest.name,
          pluginPath,
          manifest.config
        );
        logger.debug(
          `[PluginLoader] Loaded configuration for plugin '${manifest.name}'`
        );
      } catch (error) {
        logger.error(
          `[PluginLoader] Failed to load config for plugin '${manifest.name}': ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return [];
      }
    }

    // Ensure dependencies are installed if plugin specifies them
    if (manifest.runtime && manifest.dependencies) {
      const depsReady = await this.envManager.ensureDependencies(
        manifest.name,
        pluginPath,
        manifest.runtime,
        manifest.dependencies
      );

      if (!depsReady) {
        logger.error(
          `[PluginLoader] Failed to install dependencies for plugin '${manifest.name}'. Plugin will not be loaded.`
        );
        return [];
      }
    }

    // Load all tools in the toolset
    const tools: BaseTool[] = [];
    for (const toolDef of manifest.tools) {
      try {
        const tool = await this.loadToolFromDefinition(toolDef, manifest, pluginPath, pluginConfig);
        tools.push(tool);
      } catch (error) {
        logger.error(
          `[PluginLoader] Failed to load tool '${toolDef.name}' from plugin '${manifest.name}': ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return tools;
  }

  /**
   * Load a single tool from its definition
   *
   * Creates an ExecutableToolWrapper instance that handles communication
   * with the external process via stdio.
   *
   * @param toolDef - Tool definition from plugin manifest
   * @param manifest - Complete plugin manifest (for runtime info)
   * @param pluginPath - Path to the plugin directory
   * @param config - Plugin configuration object (if available)
   * @returns Loaded tool wrapper instance
   */
  private async loadToolFromDefinition(
    toolDef: ToolDefinition,
    manifest: PluginManifest,
    pluginPath: string,
    config?: any
  ): Promise<BaseTool> {
    // Import ExecutableToolWrapper dynamically to avoid circular dependencies
    let ExecutableToolWrapper: any;
    try {
      const wrapperModule = await import('./ExecutableToolWrapper.js');
      ExecutableToolWrapper = wrapperModule.ExecutableToolWrapper;
    } catch (error) {
      throw new Error(
        `ExecutableToolWrapper not found. Error: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Create the wrapper instance
    const tool = new ExecutableToolWrapper(
      toolDef,
      manifest,
      pluginPath,
      this.activityStream,
      this.envManager,
      toolDef.timeout,
      config
    );

    return tool;
  }
}
