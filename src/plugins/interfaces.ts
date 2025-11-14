/**
 * Plugin service interfaces
 *
 * Type-safe interfaces for plugin-related services registered in ServiceRegistry.
 */

import type { BaseTool } from '../tools/BaseTool.js';
import type { PluginConfigSchema, PluginManifest } from './PluginLoader.js';
import type { AgentRequirements } from '../agent/RequirementTracker.js';

/**
 * Agent definition within a plugin
 *
 * Defines a specialized agent that can be spawned with custom configuration,
 * system prompts, and tool restrictions. Agents enable plugins to provide
 * domain-specific conversational interfaces.
 */
export interface AgentDefinition {
  /** Unique agent name (will be used as identifier) */
  name: string;

  /** Human-readable description of what the agent does */
  description: string;

  /** Path to system prompt file, relative to plugin directory */
  system_prompt_file: string;

  /** Optional list of tool names this agent can access (restricts available tools) */
  tools?: string[];

  /** Optional custom model identifier (e.g., 'claude-3-5-sonnet-20241022') */
  model?: string;

  /** Optional custom temperature setting (0.0 to 1.0) */
  temperature?: number;

  /** Optional reasoning effort level (e.g., 'low', 'medium', 'high') */
  reasoning_effort?: string;

  /** Optional guidance on when/how to use this agent */
  usage_guidelines?: string;

  /** Optional tool call requirements for this agent */
  requirements?: AgentRequirements;

  /**
   * List of agent names that can call this agent.
   * - If undefined: agent is visible to all agents (default)
   * - If empty array []: agent is visible to none (only main assistant can use it)
   * - If ["agent1", "agent2"]: only these agents can call this agent
   *
   * @example
   * visible_from_agents: ["explore", "plan"] // Only explore and plan agents can use this
   * visible_from_agents: [] // Only main assistant can use this
   * visible_from_agents: undefined // All agents can use this (default)
   */
  visible_from_agents?: string[];

  /**
   * Whether this agent can delegate to sub-agents.
   * - If undefined: defaults to true (can delegate)
   * - If false: agent cannot spawn sub-agents
   * - If true: agent can spawn sub-agents
   *
   * Useful for restricting delegation chains to prevent infinite recursion
   * or to enforce that certain agents work in isolation.
   *
   * @example
   * can_delegate_to_agents: false // Agent works alone, no delegation
   * can_delegate_to_agents: true // Agent can spawn sub-agents (default)
   */
  can_delegate_to_agents?: boolean;

  /**
   * Whether this agent can see other agents in its tool list.
   * - If undefined: defaults to true (can see agents)
   * - If false: agent cannot see agent/explore/plan tools
   * - If true: agent can see and use agent tools
   *
   * Controls visibility of agent-related tools in the agent's context.
   * When false, the agent operates in isolation without awareness of other agents.
   *
   * @example
   * can_see_agents: false // Agent doesn't see agent/explore/plan tools
   * can_see_agents: true // Agent can see and use agent tools (default)
   */
  can_see_agents?: boolean;
}

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
  agents?: any[]; // AgentData[] - imported separately to avoid circular dependency
  error?: string;
  hadExistingConfig?: boolean;
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
  agents: any[]; // AgentData[] - imported separately to avoid circular dependency
  pluginCount: number;
}

/**
 * Loaded plugin information
 */
export interface LoadedPluginInfo {
  name: string;
  manifest: PluginManifest;
  pluginPath: string;
  config?: any;
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

  /**
   * Get all loaded plugins with their manifests
   */
  getLoadedPlugins(): LoadedPluginInfo[];

  /**
   * Start background process for a single plugin
   */
  startPluginBackground(pluginName: string): Promise<void>;

  /**
   * Start background processes for all enabled plugins
   */
  startBackgroundPlugins(): Promise<void>;
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
