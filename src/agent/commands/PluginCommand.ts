/**
 * PluginCommand - Manage plugins
 *
 * Handles plugin configuration and management with subcommand routing.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import { ActivityEventType } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { getPluginsDir } from '@config/paths.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { PluginManifest } from '@plugins/PluginLoader.js';
import { formatError } from '@utils/errorUtils.js';
import { PathUtils } from '@plugins/utils.js';
import type {
  PluginConfigManagerService,
  PluginLoaderService,
  ToolManagerService,
  LoadedPluginInfo,
} from '@plugins/interfaces.js';
import { PLUGIN_FILES } from '@plugins/constants.js';
import { logger } from '@services/Logger.js';

export class PluginCommand extends Command {
  readonly name = '/plugin';
  readonly description = 'Manage plugins';

  // Use yellow output for status messages
  protected readonly useYellowOutput = true;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    // Parse subcommands
    const parts = argString.split(/\s+/);
    const subcommand = parts[0];

    if (!subcommand) {
      return this.showHelp();
    }

    switch (subcommand.toLowerCase()) {
      case 'list':
        return this.listPlugins(serviceRegistry);
      case 'show':
        // /plugin show <plugin-name>
        return this.showPluginDetails(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'config':
        // /plugin config <plugin-name>
        return this.handlePluginConfig(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'install':
        // /plugin install <path>
        return this.handlePluginInstall(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'uninstall':
        // /plugin uninstall <plugin-name>
        return this.handlePluginUninstall(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'active':
        return this.listActivePlugins(serviceRegistry);
      case 'activate':
        return this.activatePlugin(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'deactivate':
        return this.deactivatePlugin(parts.slice(1).join(' ').trim(), serviceRegistry);
      default:
        return this.showHelp();
    }
  }

  /**
   * Handle plugin configuration request
   */
  private async handlePluginConfig(
    pluginName: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!pluginName) {
      return this.createError('Plugin name required. Use /plugin config <plugin-name>');
    }

    try {
      // Look up plugin directory
      const pluginsDir = getPluginsDir();
      const pluginPath = join(pluginsDir, pluginName);

      // Check if plugin directory exists
      try {
        await fs.access(pluginPath);
      } catch {
        return this.createError(
          `Plugin '${pluginName}' not found in ${pluginsDir}. Check the plugin name and try again.`
        );
      }

      // Read plugin manifest
      const manifestPath = join(pluginPath, PLUGIN_FILES.MANIFEST);
      let manifest: PluginManifest;

      try {
        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(manifestContent);
      } catch (error) {
        return this.createError(
          `Failed to read plugin manifest for '${pluginName}': ${formatError(error)}`
        );
      }

      // Load existing config if any (even if no config schema)
      const configManager = serviceRegistry.get<PluginConfigManagerService>('plugin_config_manager');
      let existingConfig: any = null;

      if (configManager && manifest.config) {
        try {
          existingConfig = await configManager.loadConfig(
            pluginName,
            pluginPath,
            manifest.config
          );
        } catch (error) {
          // Config doesn't exist or failed to load - that's okay, we'll create a new one
          existingConfig = null;
        }
      }

      // Create config schema - either extend existing or create minimal one for activation mode
      const baseSchema = manifest.config || { schema: { properties: {} } };
      const configSchema = {
        ...baseSchema,
        schema: {
          ...baseSchema.schema,
          properties: {
            ...baseSchema.schema?.properties,
            activationMode: {
              type: 'choice' as const,
              description: 'When should this plugin be active?',
              choices: [
                {
                  label: 'Always',
                  value: 'always',
                  description: 'Tools always available in every conversation'
                },
                {
                  label: 'Only when tagged',
                  value: 'tagged',
                  description: 'Tools only available when you use #' + pluginName
                }
              ],
              default: manifest.activationMode || 'always'
            }
          }
        }
      };

      // Add activation mode to existing config if present
      if (existingConfig && !existingConfig.activationMode) {
        existingConfig.activationMode = manifest.activationMode || 'always';
      }

      // Emit PLUGIN_CONFIG_REQUEST event
      return this.emitActivityEvent(
        serviceRegistry,
        ActivityEventType.PLUGIN_CONFIG_REQUEST,
        {
          pluginName: manifest.name,
          pluginPath,
          schema: configSchema,
          existingConfig,
          author: manifest.author,
          description: manifest.description,
          version: manifest.version,
          tools: manifest.tools || [],
          agents: manifest.agents || [],
        },
        'plugin_config'
      );
    } catch (error) {
      return this.createError(`Failed to configure plugin '${pluginName}': ${formatError(error)}`);
    }
  }

  /**
   * Handle plugin installation from local path
   */
  private async handlePluginInstall(
    pluginPath: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!pluginPath) {
      return this.createError('Plugin path required. Use /plugin install <path>');
    }

    try {
      // Resolve path (handle relative paths, ~, etc.)
      const resolvedPath = PathUtils.resolvePath(pluginPath);

      // Get PluginLoader from registry
      const pluginLoader = serviceRegistry.get<PluginLoaderService>('plugin_loader');
      if (!pluginLoader) {
        return this.createError('PluginLoader not available');
      }

      // Install the plugin
      const result = await pluginLoader.installFromPath(resolvedPath, getPluginsDir());

      if (!result.success) {
        return this.createError(result.error || 'Failed to install plugin');
      }

      // Register tools with ToolManager
      const toolManager = serviceRegistry.get<ToolManagerService>('tool_manager');
      if (toolManager && result.tools && result.tools.length > 0) {
        toolManager.registerTools(result.tools);
      }

      // Refresh PluginActivationManager to make the plugin immediately available
      try {
        const activationManager = serviceRegistry.getPluginActivationManager();
        await activationManager.refresh();
        logger.debug(`[PluginCommand] Refreshed PluginActivationManager after installing '${result.pluginName}'`);
      } catch (error) {
        logger.error(
          `[PluginCommand] Failed to refresh PluginActivationManager: ${formatError(error)}`
        );
        // Continue - not a fatal error
      }

      // Start background process if plugin has background daemon enabled
      if (result.pluginName) {
        const loadedPlugins = pluginLoader.getLoadedPlugins();
        const pluginInfo = loadedPlugins.find((p: LoadedPluginInfo) => p.name === result.pluginName);

        if (pluginInfo?.manifest.background?.enabled) {
          try {
            await pluginLoader.startPluginBackground(result.pluginName);
            logger.info(`[PluginCommand] Started background process for '${result.pluginName}'`);
          } catch (error) {
            // Log error but don't fail the install - plugin is still usable
            logger.error(
              `[PluginCommand] Failed to start background process for '${result.pluginName}': ${formatError(error)}`
            );
            logger.warn(
              `[PluginCommand] Plugin '${result.pluginName}' installed but background process failed to start. Some features may not work until the daemon is started.`
            );
          }
        }
      }

      // If this is an update with existing config, just show success message
      if (result.hadExistingConfig) {
        const toolsCount = result.tools?.length || 0;
        const agentsCount = result.agents?.length || 0;
        const toolsText = `${toolsCount} tool${toolsCount === 1 ? '' : 's'}`;
        const agentsText = agentsCount > 0 ? ` and ${agentsCount} agent${agentsCount === 1 ? '' : 's'}` : '';

        return {
          handled: true,
          response: [
            `✓ Plugin '${result.pluginName}' updated successfully with ${toolsText}${agentsText}`,
            '',
            `Your existing configuration has been preserved.`,
            `To reconfigure, run: /plugin config ${result.pluginName}`,
          ].join('\n'),
        };
      }

      // For fresh installs, always trigger config wizard to ask about activation mode
      return this.handlePluginConfig(result.pluginName!, serviceRegistry);
    } catch (error) {
      return this.createError(`Failed to install plugin: ${formatError(error)}`);
    }
  }

  /**
   * Handle plugin uninstall
   */
  private async handlePluginUninstall(
    pluginName: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!pluginName) {
      return this.createError('Plugin name required. Use /plugin uninstall <plugin-name>');
    }

    try {
      // Get PluginLoader from registry
      const pluginLoader = serviceRegistry.get<PluginLoaderService>('plugin_loader');
      if (!pluginLoader) {
        return this.createError('PluginLoader not available');
      }

      // Uninstall the plugin
      const result = await pluginLoader.uninstall(pluginName, getPluginsDir());

      if (!result.success) {
        return this.createError(result.error || 'Failed to uninstall plugin');
      }

      // Return success message
      return {
        handled: true,
        response: `✓ Plugin '${pluginName}' uninstalled successfully`,
      };
    } catch (error) {
      return this.createError(`Failed to uninstall plugin: ${formatError(error)}`);
    }
  }

  /**
   * List all installed plugins with activation status
   */
  private async listPlugins(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    try {
      // Get activation manager which has access to plugin info
      let activationManager;
      try {
        activationManager = serviceRegistry.getPluginActivationManager();
      } catch {
        return this.createError('Plugin system not initialized');
      }

      const installedPlugins = activationManager.getInstalledPlugins();

      if (installedPlugins.length === 0) {
        return {
          handled: true,
          response: 'No plugins installed. Use /plugin install <path> to install plugins.',
        };
      }

      // Get plugin loader to access manifests
      const pluginLoader = serviceRegistry.get<PluginLoaderService>('plugin_loader');
      if (!pluginLoader) {
        return this.createError('PluginLoader not available');
      }

      const loadedPlugins = pluginLoader.getLoadedPlugins();

      let output = '## Installed Plugins\n\n';
      output += `| Status | Name | Version | Mode | Description | Tools | Agents |\n`;
      output += `|--------|------|---------|------|-------------|-------|--------|\n`;

      for (const pluginName of installedPlugins) {
        const mode = activationManager.getActivationMode(pluginName) ?? 'always';
        const isActive = activationManager.isActive(pluginName);
        const pluginInfo = loadedPlugins.find((p: LoadedPluginInfo) => p.name === pluginName);

        // Status indicator
        const status = isActive ? '●' : '○';

        // Mode
        const modeStr = mode === 'always' ? 'always' : 'tagged';

        if (pluginInfo) {
          const version = pluginInfo.manifest.version || '';
          const description = pluginInfo.manifest.description || '';
          const toolsCount = pluginInfo.manifest.tools?.length || 0;
          const agentsCount = pluginInfo.manifest.agents?.length || 0;
          const toolsStr = toolsCount > 0 ? `${toolsCount}` : '-';
          const agentsStr = agentsCount > 0 ? `${agentsCount}` : '-';

          output += `| ${status} | ${pluginName} | ${version} | ${modeStr} | ${description} | ${toolsStr} | ${agentsStr} |\n`;
        } else {
          output += `| ${status} | ${pluginName} | | ${modeStr} | | - | - |\n`;
        }
      }

      output += '\n---\n\n';
      output += '**Commands:**\n';
      output += '- `/plugin show <name>` for detailed information\n';
      output += '- `/plugin active` to see active plugins in this session\n';
      output += '- `+plugin-name` to activate or `-plugin-name` to deactivate';

      return {
        handled: true,
        response: output,
      };
    } catch (error) {
      return this.createError(`Failed to list plugins: ${formatError(error)}`);
    }
  }

  /**
   * Show detailed information about a specific plugin
   */
  private async showPluginDetails(
    pluginName: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!pluginName) {
      return this.createError('Plugin name required. Use /plugin show <plugin-name>');
    }

    try {
      // Get activation manager
      let activationManager;
      try {
        activationManager = serviceRegistry.getPluginActivationManager();
      } catch {
        return this.createError('Plugin system not initialized');
      }

      // Get plugin loader
      const pluginLoader = serviceRegistry.get<PluginLoaderService>('plugin_loader');
      if (!pluginLoader) {
        return this.createError('PluginLoader not available');
      }

      const loadedPlugins = pluginLoader.getLoadedPlugins();
      const pluginInfo = loadedPlugins.find((p: LoadedPluginInfo) => p.name === pluginName);

      if (!pluginInfo) {
        return this.createError(
          `Plugin '${pluginName}' not found. Use /plugin list to see installed plugins.`
        );
      }

      const mode = activationManager.getActivationMode(pluginName) ?? 'always';
      const isActive = activationManager.isActive(pluginName);
      const manifest = pluginInfo.manifest;

      let output = '';

      // Header
      output += `Plugin: ${pluginName}\n`;
      if (manifest.version) {
        output += `Version: ${manifest.version}\n`;
      }
      if (manifest.author) {
        output += `Author: ${manifest.author}\n`;
      }

      output += `Status: ${isActive ? 'Active ●' : 'Inactive ○'}\n`;
      output += `Activation Mode: ${mode}\n\n`;

      // Description
      if (manifest.description) {
        output += `${manifest.description}\n\n`;
      }

      // Tools
      if (manifest.tools && manifest.tools.length > 0) {
        output += `## Tools (${manifest.tools.length})\n\n`;
        output += `| Name | Description | Notes |\n`;
        output += `|------|-------------|-------|\n`;
        for (const tool of manifest.tools) {
          const name = tool.name;
          const description = tool.description || '';
          const notes: string[] = [];
          if (tool.requiresConfirmation) {
            notes.push('Requires confirmation');
          }
          if (tool.visible_to && tool.visible_to.length > 0) {
            notes.push(`Visible to: ${tool.visible_to.join(', ')}`);
          }
          const notesStr = notes.join(', ');
          output += `| ${name} | ${description} | ${notesStr} |\n`;
        }
        output += '\n';
      }

      // Agents
      if (manifest.agents && manifest.agents.length > 0) {
        output += `## Agents (${manifest.agents.length})\n\n`;
        output += `| Name | Description | Tools | Model |\n`;
        output += `|------|-------------|-------|-------|\n`;
        for (const agent of manifest.agents) {
          const name = agent.name;
          const description = agent.description || '';
          const tools = agent.tools && agent.tools.length > 0 ? agent.tools.join(', ') : '';
          const model = agent.model || '';
          output += `| ${name} | ${description} | ${tools} | ${model} |\n`;
        }
        output += '\n';
      }

      // Background daemon info
      if (manifest.background?.enabled) {
        output += `Background Daemon: ${manifest.background.enabled ? 'Enabled' : 'Disabled'}\n`;
        if (manifest.background.events && manifest.background.events.length > 0) {
          output += `  Event Subscriptions: ${manifest.background.events.join(', ')}\n`;
        }
        output += '\n';
      }

      // Configuration
      if (manifest.config?.schema?.properties) {
        const configKeys = Object.keys(manifest.config.schema.properties);
        output += `Configuration: ${configKeys.length} parameter(s)\n`;
        output += `Use /plugin config ${pluginName} to configure\n`;
      }

      return {
        handled: true,
        response: output,
      };
    } catch (error) {
      return this.createError(`Failed to show plugin details: ${formatError(error)}`);
    }
  }

  /**
   * List currently active plugins
   */
  private async listActivePlugins(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    try {
      const activationManager = serviceRegistry.getPluginActivationManager();
      const activePlugins = activationManager.getActivePlugins();

      if (activePlugins.length === 0) {
        return {
          handled: true,
          response: 'No plugins currently active in this session.',
        };
      }

      let output = '**Active Plugins**\n\n';
      output += '| Plugin | Mode |\n';
      output += '|--------|------|\n';

      for (const pluginName of activePlugins) {
        const mode = activationManager.getActivationMode(pluginName);
        const modeBadge = mode === 'always' ? 'always' : 'tagged';
        output += `| ${pluginName} | ${modeBadge} |\n`;
      }

      return {
        handled: true,
        response: output,
      };
    } catch (error) {
      return this.createError(`Failed to list active plugins: ${formatError(error)}`);
    }
  }

  /**
   * Manually activate a plugin
   */
  private async activatePlugin(
    pluginName: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!pluginName) {
      return this.createError('Plugin name required. Use /plugin activate <plugin-name>');
    }

    try {
      const activationManager = serviceRegistry.getPluginActivationManager();
      const success = activationManager.activate(pluginName);

      if (success) {
        return {
          handled: true,
          response: `✓ Activated plugin: ${pluginName}`,
        };
      } else {
        return this.createError(
          `Plugin '${pluginName}' not found. Use /plugin list to see installed plugins.`
        );
      }
    } catch (error) {
      return this.createError(`Failed to activate plugin: ${formatError(error)}`);
    }
  }

  /**
   * Manually deactivate a plugin (only "tagged" mode plugins)
   */
  private async deactivatePlugin(
    pluginName: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!pluginName) {
      return this.createError('Plugin name required. Use /plugin deactivate <plugin-name>');
    }

    try {
      const activationManager = serviceRegistry.getPluginActivationManager();
      const mode = activationManager.getActivationMode(pluginName);

      if (!mode) {
        return this.createError(
          `Plugin '${pluginName}' not found. Use /plugin list to see installed plugins.`
        );
      }

      const success = activationManager.deactivate(pluginName);

      if (success) {
        const modeNote = mode === 'always' ? ' (will reactivate in new conversations)' : '';
        return {
          handled: true,
          response: `✓ Deactivated plugin: ${pluginName}${modeNote}`,
        };
      } else {
        return this.createError(`Failed to deactivate plugin: ${pluginName}`);
      }
    } catch (error) {
      return this.createError(`Failed to deactivate plugin: ${formatError(error)}`);
    }
  }

  /**
   * Show help for plugin commands
   */
  private showHelp(): CommandResult {
    return {
      handled: true,
      response: `**Plugin Management**
\`/plugin list\`  List all installed plugins
\`/plugin show <name>\`  Show detailed plugin information
\`/plugin active\`  List active plugins in this session
\`/plugin config <name>\`  Configure a plugin

**Installation**
\`/plugin install <path>\`  Install a plugin
\`/plugin uninstall <name>\`  Uninstall a plugin

**Activation**
\`/plugin activate <name>\`  Activate a plugin
\`/plugin deactivate <name>\`  Deactivate a plugin
\`+plugin-name\`  Quick activate in message
\`-plugin-name\`  Quick deactivate in message`,
    };
  }
}
