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
import { PLUGIN_FILES, PLUGIN_CONSTRAINTS, PLUGIN_TIMEOUTS } from './constants.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../services/Logger.js';
import type { SocketClient } from './SocketClient.js';
import type { BackgroundProcessManager, BackgroundProcessConfig } from './BackgroundProcessManager.js';
import type { EventSubscriptionManager } from './EventSubscriptionManager.js';
import type { AgentDefinition } from './interfaces.js';
import type { AgentData } from '../services/AgentManager.js';
import { parseFrontmatterYAML, extractFrontmatter } from '../utils/yamlUtils.js';
import { validateToolName, validateAgentName } from '../utils/namingValidation.js';

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

  /** Array of agent definitions provided by this plugin (optional) */
  agents?: AgentDefinition[];

  /** Configuration schema for interactive setup (optional) */
  config?: PluginConfigSchema;

  /** Activation mode - determines when plugin tools are loaded (default: 'always') */
  activationMode?: 'always' | 'tagged';

  /** Runtime environment (e.g., 'python3', 'node') */
  runtime?: string;

  /** Dependency specification for automatic installation */
  dependencies?: {
    /** Dependencies file (e.g., "requirements.txt", "package.json") */
    file: string;
    /** Optional custom install command */
    install_command?: string;
  };

  /** Background daemon configuration (for background_rpc tools) */
  background?: {
    /** Enable background daemon for this plugin */
    enabled?: boolean;
    /** Command to start the daemon */
    command: string;
    /** Command arguments */
    args: string[];
    /** Communication configuration */
    communication: {
      /** Communication type (only 'socket' supported currently) */
      type?: string;
      /** Unix socket path for JSON-RPC communication */
      path: string;
    };
    /** Event subscriptions - events this plugin wants to receive */
    events?: string[];
    /** Health check configuration */
    healthcheck?: {
      /** Milliseconds between health checks */
      interval: number;
      /** Milliseconds to wait for health response */
      timeout: number;
      /** Failed checks before marking unhealthy */
      retries: number;
    };
    /** Milliseconds to wait for daemon to start */
    startup_timeout?: number;
    /** Milliseconds to wait after SIGTERM before SIGKILL */
    shutdown_grace_period?: number;
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

  /** Optional custom display name for UI presentation (e.g., "List" instead of "Ls") */
  display_name?: string;

  /** Tool description for LLM */
  description: string;

  /** Tool type - 'executable' spawns a process, 'background_rpc' calls a daemon via RPC */
  type?: 'executable' | 'background_rpc';

  /** Command to execute (for executable type) */
  command?: string;

  /** Command arguments (for executable type) */
  args?: string[];

  /** RPC method name (for background_rpc type) */
  method?: string;

  /** Requires user confirmation before execution */
  requiresConfirmation?: boolean;

  /** Timeout in milliseconds (default: 120000 for executable, 30000 for RPC) */
  timeout?: number;

  /** JSON Schema for tool parameters */
  schema?: any;

  /** Optional usage guidance to inject into agent system prompt */
  usageGuidance?: string;

  /** Optional array of agent names this tool is visible to (empty or missing = visible to all) */
  visible_to?: string[];

  /**
   * Optional subtext template string with {param} placeholders for parameter substitution.
   * When a tool is executed, parameter names in curly braces will be replaced with their actual values.
   * Example: "{a} + {b}" will display "5 + 3" when a=5 and b=3
   */
  subtext?: string;
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
  type: 'string' | 'number' | 'boolean' | 'integer' | 'choice';
  description: string;
  required?: boolean;
  secret?: boolean;
  default?: any;
  choices?: Array<{
    label: string;
    value: string;
    description?: string;
  }>;
}

/**
 * Result of plugin manifest validation
 */
interface ValidationResult {
  /** Whether validation passed (no errors) */
  valid: boolean;
  /** Fatal validation errors that prevent plugin loading */
  errors: string[];
  /** Non-fatal warnings about plugin configuration */
  warnings: string[];
}

/**
 * Pending plugin config requests (stored at module level for UI to check on mount)
 */
let pendingConfigRequests: Array<{
  pluginName: string;
  pluginPath: string;
  schema: PluginConfigSchema;
  author?: string;
  description?: string;
  version?: string;
  tools?: any[];
  agents?: any[];
}> = [];

/**
 * Loaded plugin information
 */
interface LoadedPluginInfo {
  manifest: PluginManifest;
  pluginPath: string;
  config?: any;
}

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
  private socketClient: SocketClient;
  private processManager: BackgroundProcessManager;
  private eventSubscriptionManager: EventSubscriptionManager;
  private loadedPlugins: Map<string, LoadedPluginInfo> = new Map();

  constructor(
    activityStream: ActivityStream,
    configManager: PluginConfigManager,
    socketClient: SocketClient,
    processManager: BackgroundProcessManager,
    eventSubscriptionManager: EventSubscriptionManager
  ) {
    this.activityStream = activityStream;
    this.configManager = configManager;
    this.envManager = new PluginEnvironmentManager();
    this.socketClient = socketClient;
    this.processManager = processManager;
    this.eventSubscriptionManager = eventSubscriptionManager;
  }

  /**
   * Validates a plugin manifest for completeness and correctness
   *
   * Performs comprehensive validation of plugin configuration including:
   * - Required fields for all plugins (name, version, tools)
   * - Plugin name format (must not start with + or -)
   * - Background daemon configuration (if enabled)
   * - Tool definitions and type-specific requirements
   * - Socket path length constraints
   * - Timeout and health check values
   *
   * @param manifest - Plugin manifest to validate
   * @returns ValidationResult with errors and warnings
   */
  private validatePluginManifest(manifest: PluginManifest): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields for all plugins
    if (!manifest.name || typeof manifest.name !== 'string') {
      errors.push("Missing required field 'name'");
    } else {
      // Validate plugin name format: must not start with + or -
      if (manifest.name.startsWith('+') || manifest.name.startsWith('-')) {
        errors.push(`Invalid plugin name '${manifest.name}': plugin names cannot start with '+' or '-'`);
      }
      // Validate plugin name pattern: only lowercase alphanumeric, underscore, and hyphen
      if (!/^[a-z0-9_-]+$/.test(manifest.name)) {
        errors.push(`Invalid plugin name '${manifest.name}': must contain only lowercase letters, numbers, underscores, and hyphens`);
      }
    }
    if (!manifest.version || typeof manifest.version !== 'string') {
      errors.push("Missing required field 'version'");
    }
    if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
      errors.push("Plugin must define at least one tool");
    }

    // Validate background configuration if enabled
    if (manifest.background?.enabled) {
      // Required background fields
      if (!manifest.background.command) {
        errors.push("Background plugin missing 'background.command'");
      }
      if (!Array.isArray(manifest.background.args)) {
        errors.push("Background plugin 'background.args' must be an array");
      }
      if (!manifest.background.communication?.type) {
        errors.push("Background plugin missing 'background.communication.type'");
      } else if (manifest.background.communication.type !== 'socket') {
        errors.push(`Unsupported communication type: ${manifest.background.communication.type}`);
      }
      if (!manifest.background.communication?.path) {
        errors.push("Background plugin missing 'background.communication.path'");
      } else {
        // Validate socket path length
        if (manifest.background.communication.path.length > PLUGIN_CONSTRAINTS.MAX_SOCKET_PATH_LENGTH) {
          errors.push(
            `Socket path exceeds maximum length (${manifest.background.communication.path.length} > ${PLUGIN_CONSTRAINTS.MAX_SOCKET_PATH_LENGTH})`
          );
        }
      }

      // Validate timeouts
      if (manifest.background.startup_timeout !== undefined) {
        if (typeof manifest.background.startup_timeout !== 'number' || manifest.background.startup_timeout <= 0) {
          errors.push("'background.startup_timeout' must be a positive number");
        }
      }
      if (manifest.background.shutdown_grace_period !== undefined) {
        if (typeof manifest.background.shutdown_grace_period !== 'number' || manifest.background.shutdown_grace_period <= 0) {
          errors.push("'background.shutdown_grace_period' must be a positive number");
        }
      }

      // Validate health check config if provided
      if (manifest.background.healthcheck) {
        const hc = manifest.background.healthcheck;
        if (hc.interval !== undefined && (typeof hc.interval !== 'number' || hc.interval <= 0)) {
          errors.push("'background.healthcheck.interval' must be a positive number");
        }
        if (hc.timeout !== undefined && (typeof hc.timeout !== 'number' || hc.timeout <= 0)) {
          errors.push("'background.healthcheck.timeout' must be a positive number");
        }
        if (hc.retries !== undefined && (typeof hc.retries !== 'number' || hc.retries < 0)) {
          errors.push("'background.healthcheck.retries' must be a non-negative number");
        }
      }
    }

    // Validate activation mode (optional field)
    if (manifest.activationMode !== undefined) {
      if (manifest.activationMode !== 'always' && manifest.activationMode !== 'tagged') {
        errors.push(
          `Invalid activationMode '${manifest.activationMode}'. Must be 'always' or 'tagged'`
        );
      }
    }

    // Validate tools
    manifest.tools?.forEach((tool, index) => {
      // Validate tool name format (kebab-case)
      if (!tool.name) {
        errors.push(`Tool at index ${index} missing required 'name' field`);
      } else {
        const validation = validateToolName(tool.name);
        if (!validation.valid) {
          errors.push(`Plugin '${manifest.name}': ${validation.error}`);
        }
      }

      const toolType = tool.type || 'executable';

      if (toolType === 'background_rpc') {
        // Background RPC tool validation
        if (!manifest.background?.enabled) {
          errors.push(
            `Tool '${tool.name}' has type 'background_rpc' but plugin does not have background.enabled = true`
          );
        }
        if (!tool.method) {
          errors.push(`Tool '${tool.name}' has type 'background_rpc' but missing 'method' field`);
        }
      } else if (toolType === 'executable') {
        // Executable tool validation
        if (!tool.command) {
          errors.push(`Tool '${tool.name}' has type 'executable' but missing 'command' field`);
        }
      } else {
        warnings.push(`Tool '${tool.name}' has unknown type: ${toolType}`);
      }

      // Common tool validations
      if (!tool.description) {
        warnings.push(`Tool '${tool.name}' missing recommended 'description' field`);
      }
    });

    // Validate agents (if present)
    manifest.agents?.forEach((agent, index) => {
      // Validate agent name format (kebab-case)
      if (!agent.name) {
        errors.push(`Agent at index ${index} missing required 'name' field`);
      } else {
        const validation = validateAgentName(agent.name);
        if (!validation.valid) {
          errors.push(`Plugin '${manifest.name}': ${validation.error}`);
        }
      }

      // Validate required fields
      if (!agent.system_prompt_file) {
        errors.push(`Agent '${agent.name}' missing required 'system_prompt_file' field`);
      }
    });

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Get any pending configuration requests
   * Returns the first pending request and removes it from the queue
   */
  static getPendingConfigRequest(): {
    pluginName: string;
    pluginPath: string;
    schema: PluginConfigSchema;
    author?: string;
    description?: string;
    version?: string;
    tools?: any[];
    agents?: any[];
  } | null {
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
    agents?: any[];
    error?: string;
    hadExistingConfig?: boolean;
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

      // Validate plugin name format
      if (manifest.name.startsWith('+') || manifest.name.startsWith('-')) {
        return { success: false, error: `Invalid plugin name '${manifest.name}': plugin names cannot start with '+' or '-'` };
      }
      if (!/^[a-z0-9_-]+$/.test(manifest.name)) {
        return { success: false, error: `Invalid plugin name '${manifest.name}': must contain only lowercase letters, numbers, underscores, and hyphens` };
      }

      if (!manifest.tools || manifest.tools.length === 0) {
        return { success: false, error: 'Plugin manifest missing or empty tools array' };
      }

      // Check if plugin already exists - if so, preserve config before removing
      const targetPath = join(pluginsDir, manifest.name);
      let isUpdate = false;
      let savedConfig: string | null = null;
      let hadExistingConfig = false;

      try {
        await fs.access(targetPath);
        isUpdate = true;
        logger.debug(`[PluginLoader] Updating existing plugin '${manifest.name}'`);

        // Check if there's an existing config file to preserve
        const configPath = join(targetPath, PLUGIN_FILES.CONFIG);
        try {
          savedConfig = await fs.readFile(configPath, 'utf-8');
          hadExistingConfig = true;
          logger.debug(`[PluginLoader] Preserving existing configuration for '${manifest.name}'`);
        } catch {
          // No config file exists - that's okay
          logger.debug(`[PluginLoader] No existing config to preserve for '${manifest.name}'`);
        }

        await fs.rm(targetPath, { recursive: true, force: true });
      } catch {
        // Target doesn't exist - fresh install
      }

      // Copy plugin directory to plugins folder
      logger.debug(
        `[PluginLoader] ${isUpdate ? 'Updating' : 'Installing'} plugin '${manifest.name}' from ${sourcePath}`
      );
      await this.copyDirectory(sourcePath, targetPath);

      // Restore the saved config if it existed
      if (savedConfig) {
        const configPath = join(targetPath, PLUGIN_FILES.CONFIG);
        await fs.writeFile(configPath, savedConfig, 'utf-8');
        logger.debug(`[PluginLoader] Restored existing configuration for '${manifest.name}'`);
      }

      // Load the plugin (this triggers dependency installation)
      const { tools, agents } = await this.loadPlugin(targetPath);

      // If no tools or agents loaded, check if it's because config is needed (not an error)
      if (tools.length === 0 && agents.length === 0) {
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
              agents: [],
              hadExistingConfig,
            };
          }
        }

        // Not a config issue - actual failure
        return {
          success: false,
          error: 'Plugin installed but failed to load tools. Check logs for details.',
        };
      }

      const toolsCount = tools.length;
      const agentsCount = agents.length;
      const toolsText = `${toolsCount} tool(s)`;
      const agentsText = agentsCount > 0 ? ` and ${agentsCount} agent(s)` : '';
      logger.debug(
        `[PluginLoader] Plugin '${manifest.name}' installed successfully with ${toolsText}${agentsText}`
      );

      return {
        success: true,
        pluginName: manifest.name,
        tools,
        agents,
        hadExistingConfig,
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
   * @returns Object containing tools, agents, and plugin count
   */
  async loadPlugins(pluginDir: string): Promise<{ tools: BaseTool[], agents: AgentData[], pluginCount: number }> {
    const tools: BaseTool[] = [];
    const agents: AgentData[] = [];
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
        return { tools, agents, pluginCount };
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
        return { tools, agents, pluginCount };
      }

      logger.debug(`[PluginLoader] Found ${pluginDirs.length} potential plugin(s)`);

      // Attempt to load each plugin
      for (const pluginPath of pluginDirs) {
        try {
          const result = await this.loadPlugin(pluginPath);
          if (result.tools.length > 0 || result.agents.length > 0) {
            tools.push(...result.tools);
            agents.push(...result.agents);
            pluginCount++;
            logger.debug(
              `[PluginLoader] Successfully loaded plugin with ${result.tools.length} tool(s) and ${result.agents.length} agent(s): ${result.tools.map(t => t.name).join(', ')}`
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

      logger.debug(`[PluginLoader] Successfully loaded ${pluginCount} plugin(s) with ${tools.length} tool(s) and ${agents.length} agent(s)`);
    } catch (error) {
      // Catch-all for unexpected errors during the loading process
      logger.error(
        `[PluginLoader] Unexpected error during plugin loading: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return { tools, agents, pluginCount };
  }

  /**
   * Start background process for a single plugin
   *
   * Starts the background daemon for a specific plugin if it has background.enabled === true.
   * This is idempotent - if the plugin is already running, it will not start again.
   *
   * @param pluginName - Name of the plugin to start
   * @throws Error if plugin is not loaded or does not have background enabled
   */
  async startPluginBackground(pluginName: string): Promise<void> {
    const plugin = this.loadedPlugins.get(pluginName);

    if (!plugin) {
      throw new Error(`Plugin '${pluginName}' is not loaded`);
    }

    if (!plugin.manifest.background?.enabled) {
      throw new Error(`Plugin '${pluginName}' does not have background enabled`);
    }

    // Check if already running (idempotent)
    if (this.processManager.isRunning(pluginName)) {
      logger.debug(`[PluginLoader] Background process for '${pluginName}' is already running`);
      return;
    }

    const manifest = plugin.manifest;
    const pluginPath = plugin.pluginPath;

    // Build process configuration from manifest
    const config: BackgroundProcessConfig = {
      pluginName: manifest.name,
      pluginPath: pluginPath,
      command: this.envManager.getPythonPath(manifest.name), // Use venv Python
      args: manifest.background!.args,
      socketPath: manifest.background!.communication.path,
      envVars: this.buildEnvVars(manifest, pluginName, plugin.config),
      healthcheck: manifest.background!.healthcheck,
      startupTimeout: manifest.background!.startup_timeout || PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_STARTUP,
      shutdownGracePeriod: manifest.background!.shutdown_grace_period || PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_SHUTDOWN_GRACE_PERIOD,
    };

    // Start the daemon
    await this.processManager.startProcess(config);
    logger.info(`[PluginLoader] ✓ Started background process for '${pluginName}'`);

    // Subscribe to events if specified in manifest
    const events = manifest.background!.events;
    if (events && events.length > 0) {
      try {
        this.eventSubscriptionManager.subscribe(
          pluginName,
          manifest.background!.communication.path,
          events
        );
        logger.info(`[PluginLoader] ✓ Subscribed '${pluginName}' to ${events.length} event(s): ${events.join(', ')}`);
      } catch (error) {
        logger.error(
          `[PluginLoader] Failed to subscribe '${pluginName}' to events: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue - plugin is still running, just won't receive events
      }
    }
  }

  /**
   * Start background processes for all enabled plugins
   *
   * This should be called after loadPlugins() completes. It iterates through
   * all loaded plugins and starts background daemons for those with
   * background.enabled === true.
   */
  async startBackgroundPlugins(): Promise<void> {
    const pluginsWithBackground: string[] = [];

    // Find all plugins with background enabled
    for (const [pluginName, plugin] of this.loadedPlugins.entries()) {
      if (plugin.manifest.background?.enabled) {
        pluginsWithBackground.push(pluginName);
      }
    }

    if (pluginsWithBackground.length === 0) {
      logger.debug('[PluginLoader] No background plugins to start');
      return;
    }

    logger.info(`[PluginLoader] Starting ${pluginsWithBackground.length} background plugin(s)...`);

    // Start each background plugin sequentially
    for (const pluginName of pluginsWithBackground) {
      try {
        await this.startPluginBackground(pluginName);
      } catch (error) {
        // Log error but continue with other plugins
        logger.error(
          `[PluginLoader] Failed to start background process for '${pluginName}': ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        logger.warn(`[PluginLoader] Plugin '${pluginName}' tools will fail until daemon is started`);
      }
    }

    logger.info('[PluginLoader] Background plugin startup complete');
  }

  /**
   * Build environment variables for background process
   */
  private buildEnvVars(_manifest: PluginManifest, _pluginName: string, config?: any): Record<string, string> {
    const envVars: Record<string, string> = {};

    // Add plugin config as environment variables
    if (config) {
      for (const [key, value] of Object.entries(config)) {
        const envKey = `PLUGIN_CONFIG_${key.toUpperCase()}`;
        envVars[envKey] = String(value);
      }
    }

    return envVars;
  }

  /**
   * Reload a single plugin after configuration
   *
   * Used to reload a plugin after its configuration has been provided.
   * Reads the manifest, loads the configuration, and returns loaded tools.
   * Note: This only returns tools for backward compatibility. Agents are
   * loaded internally but not returned.
   *
   * @param pluginName - Name of the plugin to reload
   * @param pluginPath - Path to the plugin directory
   * @returns Array of loaded tool instances
   */
  async reloadPlugin(pluginName: string, pluginPath: string): Promise<BaseTool[]> {
    logger.info(`[PluginLoader] Reloading plugin '${pluginName}' from ${pluginPath}`);

    try {
      const { tools, agents } = await this.loadPlugin(pluginPath);

      if (tools.length > 0 || agents.length > 0) {
        logger.info(
          `[PluginLoader] Successfully reloaded plugin '${pluginName}' with ${tools.length} tool(s) and ${agents.length} agent(s): ${tools.map(t => t.name).join(', ')}`
        );
      } else {
        logger.warn(`[PluginLoader] No tools or agents loaded when reloading plugin '${pluginName}'`);
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
   * Also loads any agents defined in the plugin.
   *
   * @param pluginPath - Path to the plugin directory
   * @returns Object containing tools and agents
   */
  private async loadPlugin(pluginPath: string): Promise<{ tools: BaseTool[], agents: AgentData[] }> {
    const manifestPath = join(pluginPath, PLUGIN_FILES.MANIFEST);

    // Check if manifest exists
    try {
      await fs.access(manifestPath);
    } catch {
      logger.warn(
        `[PluginLoader] Skipping ${pluginPath}: No ${PLUGIN_FILES.MANIFEST} manifest found`
      );
      return { tools: [], agents: [] };
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
      return { tools: [], agents: [] };
    }

    // Validate required fields
    if (!manifest.name) {
      logger.error(
        `[PluginLoader] Invalid manifest in ${pluginPath}: Missing required field 'name'`
      );
      return { tools: [], agents: [] };
    }

    // Backward compatibility: convert old single-tool format to toolset
    if (!manifest.tools && manifest.command) {
      logger.info(
        `[PluginLoader] Converting legacy plugin '${manifest.name}' to toolset format`
      );
      manifest.tools = [
        {
          name: manifest.name,
          description: manifest.description,
          command: manifest.command,
          args: manifest.args,
          requiresConfirmation: manifest.requiresConfirmation,
          schema: manifest.schema,
        },
      ];
    }

    // Validate manifest
    const validation = this.validatePluginManifest(manifest);

    if (!validation.valid) {
      const errorMsg = `Invalid plugin manifest for '${manifest.name}':\n${validation.errors.join('\n')}`;
      logger.error(`[PluginLoader] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Log warnings (non-fatal)
    if (validation.warnings.length > 0) {
      validation.warnings.forEach(warning => {
        logger.warn(`[PluginLoader] Plugin '${manifest.name}': ${warning}`);
      });
    }

    logger.debug(`[PluginLoader] Manifest validation passed for '${manifest.name}'`);

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
          author: manifest.author,
          description: manifest.description,
          version: manifest.version,
          tools: manifest.tools || [],
          agents: manifest.agents || [],
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
            author: manifest.author,
            description: manifest.description,
            version: manifest.version,
            tools: manifest.tools || [],
            agents: manifest.agents || [],
          },
        });

        logger.debug(
          `[PluginLoader] Plugin '${manifest.name}' waiting for configuration - returning empty tools and agents arrays`
        );
        return { tools: [], agents: [] };
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
        return { tools: [], agents: [] };
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
        return { tools: [], agents: [] };
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

    // Load all agents in the plugin
    const agents = await this.loadPluginAgents(manifest, pluginPath);

    // Store loaded plugin info for background process management
    if (tools.length > 0 || agents.length > 0) {
      this.loadedPlugins.set(manifest.name, {
        manifest,
        pluginPath,
        config: pluginConfig,
      });
    }

    return { tools, agents };
  }

  /**
   * Load a single tool from its definition
   *
   * Creates either an ExecutableToolWrapper (for executable tools) or
   * BackgroundToolWrapper (for background_rpc tools) depending on the tool type.
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
    // Determine tool type (default to 'executable' for backward compatibility)
    const toolType = toolDef.type || 'executable';

    if (toolType === 'background_rpc') {
      // Validate required fields for background RPC tools
      if (!toolDef.method) {
        throw new Error(
          `Background RPC tool '${toolDef.name}' missing required 'method' field`
        );
      }
      if (!manifest.background?.communication?.path) {
        throw new Error(
          `Plugin '${manifest.name}' missing background.communication.path configuration`
        );
      }

      // Import and create BackgroundToolWrapper
      const { BackgroundToolWrapper } = await import('./BackgroundToolWrapper.js');

      return new BackgroundToolWrapper(
        toolDef,
        manifest,
        this.activityStream,
        this.socketClient,
        this.processManager,
        toolDef.timeout
      );
    } else {
      // Default: executable tool
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

  /**
   * Get all loaded plugins with their manifests
   *
   * @returns Array of loaded plugin information
   */
  getLoadedPlugins(): Array<{ name: string; manifest: PluginManifest; pluginPath: string; config?: any }> {
    const plugins: Array<{ name: string; manifest: PluginManifest; pluginPath: string; config?: any }> = [];

    for (const [name, info] of this.loadedPlugins.entries()) {
      plugins.push({
        name,
        manifest: info.manifest,
        pluginPath: info.pluginPath,
        config: info.config,
      });
    }

    return plugins;
  }

  /**
   * Load plugin agents from manifest and parse their definition files
   *
   * Reads agent markdown files from the plugin directory, parses frontmatter
   * and content, and returns fully-formed agent definitions with plugin metadata.
   *
   * @param manifest - Plugin manifest containing agent definitions
   * @param pluginPath - Path to the plugin directory
   * @returns Array of parsed agent data with plugin context
   */
  private async loadPluginAgents(manifest: PluginManifest, pluginPath: string): Promise<Array<AgentData & { _pluginName: string }>> {
    // Return early if no agents defined
    if (!manifest.agents || manifest.agents.length === 0) {
      return [];
    }

    const agents: Array<AgentData & { _pluginName: string }> = [];
    const seenAgentNames = new Set<string>();

    // Iterate through each agent definition
    for (const agentDef of manifest.agents) {
      // Check for duplicate agent names within this plugin
      if (seenAgentNames.has(agentDef.name)) {
        logger.warn(
          `[PluginLoader] Skipping duplicate agent name '${agentDef.name}' in plugin '${manifest.name}'. Keeping first occurrence.`
        );
        continue;
      }
      seenAgentNames.add(agentDef.name);
      try {
        // Validate agent definition has required fields
        if (!agentDef.name || !agentDef.system_prompt_file) {
          logger.warn(
            `[PluginLoader] Skipping invalid agent in plugin '${manifest.name}': missing name or system_prompt_file`
          );
          continue;
        }

        // Construct path to agent markdown file
        const agentFilePath = join(pluginPath, agentDef.system_prompt_file);

        // Read agent markdown file
        let fileContent: string;
        try {
          fileContent = await fs.readFile(agentFilePath, 'utf-8');
        } catch (error) {
          logger.warn(
            `[PluginLoader] Failed to read agent file '${agentDef.system_prompt_file}' for agent '${agentDef.name}' in plugin '${manifest.name}': ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          continue;
        }

        // Parse the agent file (frontmatter + content)
        const parsedAgent = this.parseAgentFile(fileContent, agentDef.name);

        if (!parsedAgent) {
          logger.warn(
            `[PluginLoader] Failed to parse agent file '${agentDef.system_prompt_file}' for agent '${agentDef.name}' in plugin '${manifest.name}'`
          );
          continue;
        }

        // Merge manifest values with parsed values (manifest takes precedence)
        const mergedAgent: AgentData & { _pluginName: string } = {
          // Start with parsed file values
          ...parsedAgent,
          // Override with manifest values (these take precedence)
          name: agentDef.name,
          description: agentDef.description || parsedAgent.description,
          model: agentDef.model || parsedAgent.model,
          temperature: agentDef.temperature !== undefined ? agentDef.temperature : parsedAgent.temperature,
          reasoning_effort: agentDef.reasoning_effort || parsedAgent.reasoning_effort,
          tools: agentDef.tools || parsedAgent.tools,
          usage_guidelines: agentDef.usage_guidelines || parsedAgent.usage_guidelines,
          visible_from_agents: agentDef.visible_from_agents !== undefined ? agentDef.visible_from_agents : parsedAgent.visible_from_agents,
          can_delegate_to_agents: agentDef.can_delegate_to_agents !== undefined ? agentDef.can_delegate_to_agents : parsedAgent.can_delegate_to_agents,
          can_see_agents: agentDef.can_see_agents !== undefined ? agentDef.can_see_agents : parsedAgent.can_see_agents,
          // Add plugin tracking metadata
          _pluginName: manifest.name,
        };

        agents.push(mergedAgent);

        logger.debug(
          `[PluginLoader] Successfully loaded agent '${agentDef.name}' from plugin '${manifest.name}'`
        );
      } catch (error) {
        // Log error but continue with other agents
        logger.warn(
          `[PluginLoader] Error loading agent '${agentDef.name}' from plugin '${manifest.name}': ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    if (agents.length > 0) {
      logger.debug(
        `[PluginLoader] Loaded ${agents.length} agent(s) from plugin '${manifest.name}': ${agents.map(a => a.name).join(', ')}`
      );
    }

    return agents;
  }

  /**
   * Parse agent markdown file (frontmatter + content)
   *
   * Reuses the same parsing logic as AgentManager to ensure consistency.
   * Expects markdown file with YAML frontmatter followed by system prompt content.
   *
   * @param content - Raw markdown file content
   * @param agentName - Agent name for fallback
   * @returns Parsed agent data or null if invalid
   */
  private parseAgentFile(content: string, agentName: string): AgentData | null {
    try {
      const extracted = extractFrontmatter(content);
      if (!extracted) {
        return null;
      }

      const { frontmatter, body } = extracted;
      const metadata = parseFrontmatterYAML(frontmatter);

      return {
        name: metadata.name || agentName,
        description: metadata.description || '',
        system_prompt: body.trim(),
        model: metadata.model,
        temperature: metadata.temperature ? parseFloat(metadata.temperature) : undefined,
        reasoning_effort: metadata.reasoning_effort,
        tools: metadata.tools, // Array of tool names or undefined
        usage_guidelines: metadata.usage_guidelines,
        requirements: metadata.requirements, // Agent requirements object
        created_at: metadata.created_at,
        updated_at: metadata.updated_at,
        visible_from_agents: metadata.visible_from_agents, // Agent visibility controls
        can_delegate_to_agents: metadata.can_delegate_to_agents,
        can_see_agents: metadata.can_see_agents,
      };
    } catch {
      return null;
    }
  }
}
