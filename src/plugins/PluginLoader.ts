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
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../services/Logger.js';

/**
 * Plugin manifest schema
 *
 * Describes the metadata and configuration for an executable plugin.
 */
export interface PluginManifest {
  /** Unique plugin identifier (should match directory name) */
  name: string;

  /** Semantic version (e.g., "1.0.0") */
  version: string;

  /** Human-readable description of what the plugin does */
  description: string;

  /** Command to execute (e.g., "python3", "node", "./script.sh") */
  command: string;

  /** Arguments to pass to the command (e.g., ["search.py", "--verbose"]) */
  args?: string[];

  /** Whether the tool requires user confirmation before execution */
  requiresConfirmation?: boolean;

  /** JSON Schema for tool parameters (optional) */
  schema?: any;

  /** Plugin author information (optional) */
  author?: string;
}

/**
 * PluginLoader - Discovers and loads plugins from the plugins directory
 *
 * Loads executable plugins with comprehensive error handling to ensure
 * one broken plugin doesn't prevent others from loading.
 */
export class PluginLoader {
  private activityStream: ActivityStream;

  constructor(activityStream: ActivityStream) {
    this.activityStream = activityStream;
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
  async loadPlugins(pluginDir: string): Promise<BaseTool[]> {
    const tools: BaseTool[] = [];

    try {
      // Ensure the plugins directory exists
      await fs.mkdir(pluginDir, { recursive: true });
      logger.info(`[PluginLoader] Scanning plugins directory: ${pluginDir}`);

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
        return tools;
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
        logger.info('[PluginLoader] No plugin directories found');
        return tools;
      }

      logger.info(`[PluginLoader] Found ${pluginDirs.length} potential plugin(s)`);

      // Attempt to load each plugin
      for (const pluginPath of pluginDirs) {
        try {
          const tool = await this.loadPlugin(pluginPath);
          if (tool) {
            tools.push(tool);
            logger.info(`[PluginLoader] Successfully loaded plugin: ${tool.name}`);
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

      if (tools.length > 0) {
        logger.info(`[PluginLoader] Successfully loaded ${tools.length} plugin(s)`);
      } else {
        logger.info('[PluginLoader] No plugins loaded');
      }
    } catch (error) {
      // Catch-all for unexpected errors during the loading process
      logger.error(
        `[PluginLoader] Unexpected error during plugin loading: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return tools;
  }

  /**
   * Load a single plugin from a directory
   *
   * Reads and validates the plugin.json manifest, then creates an
   * ExecutableToolWrapper to handle the plugin execution.
   *
   * @param pluginPath - Path to the plugin directory
   * @returns Loaded tool instance, or null if the plugin couldn't be loaded
   */
  private async loadPlugin(pluginPath: string): Promise<BaseTool | null> {
    const manifestPath = join(pluginPath, 'plugin.json');

    // Check if plugin.json exists
    try {
      await fs.access(manifestPath);
    } catch {
      logger.warn(
        `[PluginLoader] Skipping ${pluginPath}: No plugin.json manifest found`
      );
      return null;
    }

    // Read and parse the manifest
    let manifest: PluginManifest;
    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(manifestContent);
    } catch (error) {
      logger.error(
        `[PluginLoader] Failed to parse plugin.json in ${pluginPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }

    // Validate required fields
    if (!manifest.name) {
      logger.error(
        `[PluginLoader] Invalid manifest in ${pluginPath}: Missing required field 'name'`
      );
      return null;
    }

    if (!manifest.command) {
      logger.error(
        `[PluginLoader] Invalid manifest in ${pluginPath}: Missing required field 'command'`
      );
      return null;
    }

    // Load the executable plugin
    try {
      return await this.loadExecutablePlugin(pluginPath, manifest);
    } catch (error) {
      logger.error(
        `[PluginLoader] Failed to load plugin '${manifest.name}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  /**
   * Load an executable plugin (Python, shell script, etc.)
   *
   * Creates an ExecutableToolWrapper instance that handles communication
   * with the external process via stdio.
   *
   * @param pluginPath - Path to the plugin directory
   * @param manifest - Parsed plugin manifest
   * @returns Loaded tool wrapper instance
   */
  private async loadExecutablePlugin(
    pluginPath: string,
    manifest: PluginManifest
  ): Promise<BaseTool> {
    // Import ExecutableToolWrapper dynamically to avoid circular dependencies
    let ExecutableToolWrapper: any;
    try {
      const wrapperModule = await import('./ExecutableToolWrapper.js');
      ExecutableToolWrapper = wrapperModule.ExecutableToolWrapper;
    } catch (error) {
      throw new Error(
        `ExecutableToolWrapper not found. Executable plugins are not yet supported. Error: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Create the wrapper instance
    const tool = new ExecutableToolWrapper(
      manifest,
      pluginPath,
      this.activityStream
    );

    return tool;
  }
}
