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
      return this.createError('Invalid plugin command. Use /plugin config <plugin-name>');
    }

    if (subcommand.toLowerCase() === 'config') {
      // /plugin config <plugin-name>
      const pluginName = parts.slice(1).join(' ').trim();
      return this.handlePluginConfig(pluginName, serviceRegistry);
    }

    if (subcommand.toLowerCase() === 'install') {
      // /plugin install <path>
      const pluginPath = parts.slice(1).join(' ').trim();
      return this.handlePluginInstall(pluginPath, serviceRegistry);
    }

    if (subcommand.toLowerCase() === 'uninstall') {
      // /plugin uninstall <plugin-name>
      const pluginName = parts.slice(1).join(' ').trim();
      return this.handlePluginUninstall(pluginName, serviceRegistry);
    }

    return this.createError('Unknown plugin subcommand. Use /plugin config|install|uninstall');
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

      // Check if plugin has a config schema
      if (!manifest.config) {
        return this.createError(
          `Plugin '${pluginName}' does not define a configuration schema. No configuration is needed.`
        );
      }

      // Load existing config if any
      const configManager = serviceRegistry.get<PluginConfigManagerService>('plugin_config_manager');
      let existingConfig: any = null;

      if (configManager) {
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

      // Emit PLUGIN_CONFIG_REQUEST event
      return this.emitActivityEvent(
        serviceRegistry,
        ActivityEventType.PLUGIN_CONFIG_REQUEST,
        {
          pluginName: manifest.name,
          pluginPath,
          schema: manifest.config,
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

      // Build success message
      let successMessage = '';
      if (result.tools && result.tools.length > 0) {
        successMessage = `✓ Plugin '${result.pluginName}' installed successfully with ${result.tools.length} tool(s)`;

        // If this was a reinstall with existing config, offer to reconfigure
        if (result.hadExistingConfig) {
          successMessage += `\nYour existing configuration has been preserved. To reconfigure, run:\n  /plugin config ${result.pluginName}`;
        }
      } else {
        successMessage = `✓ Plugin '${result.pluginName}' installed successfully`;

        // If config was preserved, let them know
        if (result.hadExistingConfig) {
          successMessage += ' (existing configuration preserved)';
        }

        successMessage += `. Use /plugin config ${result.pluginName} to configure it.`;
      }

      return {
        handled: true,
        response: successMessage,
      };
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
}
