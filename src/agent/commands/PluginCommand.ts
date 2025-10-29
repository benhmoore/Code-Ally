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

    return this.createError('Unknown plugin subcommand. Use /plugin config <plugin-name>');
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
      const manifestPath = join(pluginPath, 'plugin.json');
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
      const configManager = serviceRegistry.get('plugin_config_manager');
      let existingConfig: any = null;

      if (configManager && typeof (configManager as any).loadConfig === 'function') {
        try {
          existingConfig = await (configManager as any).loadConfig(
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
}
