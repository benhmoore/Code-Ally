/**
 * PluginCommand - Manage plugins
 *
 * Handles plugin configuration and management with subcommand routing.
 */

import { Command } from './Command.js';
import type { Message } from '../../types/index.js';
import { ActivityEventType } from '../../types/index.js';
import type { ServiceRegistry } from '../../services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { PLUGINS_DIR } from '../../config/paths.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { PluginManifest } from '../../plugins/PluginLoader.js';
import { formatError } from '../../utils/errorUtils.js';
import { PathUtils } from '../../plugins/utils.js';
import type {
  PluginConfigManagerService,
  PluginLoaderService,
  ToolManagerService,
} from '../../plugins/interfaces.js';
import { PLUGIN_FILES } from '../../plugins/constants.js';

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
      const pluginPath = join(PLUGINS_DIR, pluginName);

      // Check if plugin directory exists
      try {
        await fs.access(pluginPath);
      } catch {
        return this.createError(
          `Plugin '${pluginName}' not found in ${PLUGINS_DIR}. Check the plugin name and try again.`
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
      const result = await pluginLoader.installFromPath(resolvedPath, PLUGINS_DIR);

      if (!result.success) {
        return this.createError(result.error || 'Failed to install plugin');
      }

      // Register tools with ToolManager
      const toolManager = serviceRegistry.get<ToolManagerService>('tool_manager');
      if (toolManager && result.tools && result.tools.length > 0) {
        toolManager.registerTools(result.tools);
      }

      // If this is an update with existing config, just show success message
      if (result.hadExistingConfig) {
        const successMessage = `✓ Plugin '${result.pluginName}' updated successfully with ${result.tools?.length || 0} tool(s)\nYour existing configuration has been preserved. To reconfigure, run:\n  /plugin config ${result.pluginName}`;
        return {
          handled: true,
          response: successMessage,
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
      const result = await pluginLoader.uninstall(pluginName, PLUGINS_DIR);

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

      let output = 'Installed Plugins:\n\n';

      for (const pluginName of installedPlugins) {
        const mode = activationManager.getActivationMode(pluginName) ?? 'always';
        const isActive = activationManager.isActive(pluginName);

        // Status indicator
        const status = isActive ? '● ' : '○ ';

        // Mode badge
        const modeBadge = mode === 'always' ? '[always]' : '[tagged]';

        // For now, just show plugin name without version/description
        // since we can't easily access manifest through the service interface
        output += `${status}${pluginName} ${modeBadge}\n`;
      }

      output += '\nUse /plugin active to see active plugins in this session\n';
      output += 'Use #plugin-name in messages to activate tagged plugins';

      return {
        handled: true,
        response: output,
      };
    } catch (error) {
      return this.createError(`Failed to list plugins: ${formatError(error)}`);
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

      let output = 'Active Plugins:\n\n';

      for (const pluginName of activePlugins) {
        const mode = activationManager.getActivationMode(pluginName);
        const modeBadge = mode === 'always' ? '[always]' : '[tagged]';
        output += `  ${pluginName} ${modeBadge}\n`;
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

      if (mode === 'always') {
        return {
          handled: true,
          response: `⚠ Cannot deactivate '${pluginName}' - it is set to "always" mode.\nReinstall the plugin to change its activation mode.`,
        };
      }

      const success = activationManager.deactivate(pluginName);

      if (success) {
        return {
          handled: true,
          response: `✓ Deactivated plugin: ${pluginName}`,
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
      response: `Plugin Management Commands:

  /plugin list                    List all installed plugins
  /plugin install <path|url>      Install a plugin
  /plugin uninstall <name>        Uninstall a plugin
  /plugin config <name>           Configure a plugin
  /plugin active                  List active plugins in this session
  /plugin activate <name>         Activate a plugin
  /plugin deactivate <name>       Deactivate a plugin

Use #plugin-name in messages to activate tagged plugins`,
    };
  }
}
