/**
 * LinkedPluginWatcher - Tracks and reloads linked plugins on file changes
 *
 * Monitors linked plugins (symlinked dev installations) for changes to plugin.json
 * and agent prompt files, automatically reloading when changes are detected.
 * Uses mtime comparison for efficient change detection.
 *
 * This service is designed for development workflows where plugins are being actively
 * modified. It only monitors active linked plugins to avoid unnecessary overhead.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../services/Logger.js';
import type { PluginLoaderService, ToolManagerService } from './interfaces.js';
import type { PluginActivationManager } from './PluginActivationManager.js';
import type { AgentManager } from '../services/AgentManager.js';
import type { AgentPoolService } from '../services/AgentPoolService.js';
import { getPluginsDir } from '../config/paths.js';

/**
 * LinkedPluginWatcher tracks mtime changes for linked plugins and triggers reloads
 */
export class LinkedPluginWatcher {
  private mtimeCache: Map<string, number> = new Map(); // pluginName -> mtime
  private reloadInProgress: boolean = false;

  constructor(
    private pluginLoader: PluginLoaderService,
    private pluginActivationManager: PluginActivationManager,
    private toolManager: ToolManagerService,
    private agentManager: AgentManager,
    private agentPoolService: AgentPoolService
  ) {}

  /**
   * Initialize the watcher by scanning all active linked plugins
   * and recording their initial mtimes
   */
  async initialize(): Promise<void> {
    logger.debug('[LinkedPluginWatcher] Initializing...');

    const activePlugins = this.pluginActivationManager.getActivePlugins();
    let linkedCount = 0;

    for (const pluginName of activePlugins) {
      const isLinked = await this.pluginLoader.isPluginLinked(pluginName);
      if (!isLinked) {
        continue;
      }

      const sourcePath = await this.pluginLoader.getLinkedPluginSource(pluginName);
      if (!sourcePath) {
        logger.warn(
          `[LinkedPluginWatcher] Plugin '${pluginName}' is linked but source path not found`
        );
        continue;
      }

      const mtime = await this.getPluginMtime(sourcePath);
      if (mtime > 0) {
        this.mtimeCache.set(pluginName, mtime);
        linkedCount++;
        logger.debug(
          `[LinkedPluginWatcher] Tracking linked plugin '${pluginName}' (mtime: ${mtime})`
        );
      }
    }

    logger.debug(
      `[LinkedPluginWatcher] Initialized, tracking ${linkedCount} linked plugin(s)`
    );
  }

  /**
   * Check all active linked plugins for changes and reload if needed
   *
   * @returns Array of plugin names that were successfully reloaded
   */
  async checkAndReloadChangedPlugins(): Promise<string[]> {
    // Prevent concurrent reload cycles
    if (this.reloadInProgress) {
      logger.debug('[LinkedPluginWatcher] Reload already in progress, skipping check');
      return [];
    }

    this.reloadInProgress = true;
    try {
      return await this.performReloadCheck();
    } finally {
      this.reloadInProgress = false;
    }
  }

  /**
   * Internal method to perform the actual reload check
   */
  private async performReloadCheck(): Promise<string[]> {
    const reloadedPlugins: string[] = [];
    const activePlugins = this.pluginActivationManager.getActivePlugins();

    for (const pluginName of activePlugins) {
      const isLinked = await this.pluginLoader.isPluginLinked(pluginName);
      if (!isLinked) {
        continue;
      }

      const sourcePath = await this.pluginLoader.getLinkedPluginSource(pluginName);
      if (!sourcePath) {
        continue;
      }

      const currentMtime = await this.getPluginMtime(sourcePath);
      const cachedMtime = this.mtimeCache.get(pluginName) || 0;

      if (currentMtime > cachedMtime) {
        logger.info(
          `[LinkedPluginWatcher] Detected change in linked plugin '${pluginName}', reloading...`
        );

        const pluginPath = join(getPluginsDir(), pluginName);
        const success = await this.reloadPlugin(pluginName, pluginPath);

        if (success) {
          this.mtimeCache.set(pluginName, currentMtime);
          reloadedPlugins.push(pluginName);
          logger.info(`[LinkedPluginWatcher] Successfully reloaded plugin '${pluginName}'`);
        }
      }
    }

    return reloadedPlugins;
  }

  /**
   * Get the latest mtime across plugin.json, agent prompt files, and tool command files
   */
  private async getPluginMtime(pluginPath: string): Promise<number> {
    const filesToCheck = [join(pluginPath, 'plugin.json')];

    // Read manifest to find agent prompt files and tool command files
    try {
      const manifestContent = await fs.readFile(join(pluginPath, 'plugin.json'), 'utf-8');
      const manifest = JSON.parse(manifestContent);

      // Add agent prompt files
      for (const agent of manifest.agents || []) {
        if (agent.system_prompt_file) {
          filesToCheck.push(join(pluginPath, agent.system_prompt_file));
        }
      }

      // Add tool command files (e.g., Python scripts, Node.js files)
      for (const tool of manifest.tools || []) {
        if (tool.command) {
          filesToCheck.push(join(pluginPath, tool.command));
        }
      }
    } catch { /* manifest unreadable - just check manifest mtime */ }

    const mtimes = await Promise.all(
      filesToCheck.map(async (f) => {
        try {
          return (await fs.stat(f)).mtimeMs;
        } catch {
          return 0;
        }
      })
    );

    return Math.max(0, ...mtimes);
  }

  /**
   * Reload a plugin by unregistering old tools/agents and registering new ones
   *
   * @param pluginName - Name of the plugin to reload
   * @param pluginPath - Path to the plugin directory (in plugins dir, not source)
   * @returns True if reload succeeded, false otherwise
   */
  private async reloadPlugin(pluginName: string, pluginPath: string): Promise<boolean> {
    let oldToolCount = 0;
    let oldAgentCount = 0;
    let newToolCount = 0;
    let newAgentCount = 0;
    let errorDetails = '';

    try {
      // Evict any pooled agents for this plugin FIRST
      // This ensures no stale agents with old system prompts can be reused
      const evictedCount = this.agentPoolService.evictPluginAgents(pluginName);
      if (evictedCount > 0) {
        logger.debug(
          `[LinkedPluginWatcher] Evicted ${evictedCount} pooled agent(s) for plugin '${pluginName}'`
        );
      }

      // Get current plugin state before reloading
      const loadedPlugins = this.pluginLoader.getLoadedPlugins();
      const oldPluginInfo = loadedPlugins.find(p => p.name === pluginName);

      if (!oldPluginInfo) {
        errorDetails = 'Plugin not found in loaded plugins';
        logger.warn(
          `[LinkedPluginWatcher] Plugin '${pluginName}' not found in loaded plugins`
        );
        return false;
      }

      // Collect old tool names and agent names to unregister
      const oldToolNames = oldPluginInfo.manifest.tools.map(t => t.name);
      const oldAgentNames = oldPluginInfo.manifest.agents?.map(a => a.name) || [];
      oldToolCount = oldToolNames.length;
      oldAgentCount = oldAgentNames.length;

      // Unregister old tools BEFORE reloading to avoid stale state
      for (const toolName of oldToolNames) {
        this.toolManager.unregisterTool(toolName);
        logger.debug(`[LinkedPluginWatcher] Unregistered old tool '${toolName}'`);
      }

      // Unregister old agents
      for (const agentName of oldAgentNames) {
        this.agentManager.unregisterPluginAgent(agentName);
        logger.debug(`[LinkedPluginWatcher] Unregistered old agent '${agentName}'`);
      }

      // Reload the plugin to get fresh tools and agents
      const { tools: newTools, agents: newAgents } = await this.pluginLoader.reloadPlugin(pluginName, pluginPath);
      newToolCount = newTools.length;
      newAgentCount = newAgents.length;

      // Register new tools
      if (newTools.length > 0) {
        this.toolManager.registerTools(newTools);
        logger.debug(
          `[LinkedPluginWatcher] Registered ${newTools.length} new tool(s) from '${pluginName}'`
        );
      }

      // Register new agents
      if (newAgents.length > 0) {
        this.agentManager.registerPluginAgents(newAgents);
        logger.debug(
          `[LinkedPluginWatcher] Registered ${newAgents.length} new agent(s) from '${pluginName}'`
        );
      }

      // Log structured success info
      logger.info(
        `[LinkedPluginWatcher] Reloaded '${pluginName}': ${oldToolCount} tool(s) → ${newToolCount} tool(s), ${oldAgentCount} agent(s) → ${newAgentCount} agent(s)`
      );

      return true;
    } catch (error) {
      errorDetails = error instanceof Error ? error.message : String(error);
      logger.error(
        `[LinkedPluginWatcher] Failed to reload plugin '${pluginName}': ${errorDetails}`
      );
      logger.debug(
        `[LinkedPluginWatcher] Reload context: had ${oldToolCount} tool(s) and ${oldAgentCount} agent(s), attempted to load ${newToolCount} tool(s) and ${newAgentCount} agent(s)`
      );
      return false;
    }
  }
}
