/**
 * ConfigCommand - Manage configuration
 *
 * Handles configuration viewing, setting, and resetting with subcommand routing.
 */

import { Command } from './Command.js';
import type { Message } from '../../types/index.js';
import { ActivityEventType } from '../../types/index.js';
import type { ServiceRegistry } from '../../services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { ConfigManager } from '../../services/ConfigManager.js';
import { formatError } from '../../utils/errorUtils.js';

export class ConfigCommand extends Command {
  readonly name = '/config';
  readonly description = 'Manage configuration';

  // Use yellow output for set/reset responses
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

    // No args or "show" - show interactive config viewer
    if (!argString || subcommand?.toLowerCase() === 'show') {
      return this.handleConfigView(serviceRegistry);
    }

    if (!subcommand) {
      return this.createError('Invalid config command');
    }

    if (subcommand.toLowerCase() === 'reset') {
      return this.handleConfigReset(serviceRegistry);
    }

    if (subcommand.toLowerCase() === 'set') {
      // /config set key=value
      const kvString = parts.slice(1).join(' ');
      return this.handleConfigSet(kvString, serviceRegistry);
    }

    return this.createError('Invalid format. Use /config, /config set key=value, or /config reset');
  }

  private handleConfigView(serviceRegistry: ServiceRegistry): CommandResult {
    // Emit config view request event
    return this.emitActivityEvent(
      serviceRegistry,
      ActivityEventType.CONFIG_VIEW_REQUEST,
      {},
      'config_view'
    );
  }

  private async handleConfigSet(
    kvString: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const configManager = serviceRegistry.get<ConfigManager>('config_manager');

    if (!configManager) {
      return this.createError('Configuration manager not available');
    }

    const parts = kvString.split('=', 2);

    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return this.createError('Invalid format. Use /config set key=value');
    }

    const key = parts[0].trim();
    const valueString = parts[1].trim();

    // Check if key exists
    if (!configManager.hasKey(key)) {
      return this.createError(`Unknown configuration key: ${key}. Use /config show to see all options.`);
    }

    try {
      // Parse value based on type
      let value: any = valueString;

      // Try to parse as JSON first (handles booleans, numbers, etc.)
      try {
        value = JSON.parse(valueString);
      } catch {
        // Keep as string if not valid JSON
        value = valueString;
      }

      await configManager.setValue(key as any, value);

      return this.createResponse(`Configuration updated: ${key}=${JSON.stringify(value)}`);
    } catch (error) {
      return this.createError(`Error updating configuration: ${formatError(error)}`);
    }
  }

  private async handleConfigReset(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const configManager = serviceRegistry.get<ConfigManager>('config_manager');

    if (!configManager) {
      return this.createError('Configuration manager not available');
    }

    try {
      const changes = await configManager.reset();
      const changedKeys = Object.keys(changes);

      if (changedKeys.length === 0) {
        return this.createResponse('Configuration is already at default values.');
      }

      return this.createResponse(
        `Configuration reset to defaults. ${changedKeys.length} settings changed.`
      );
    } catch (error) {
      return this.createError(`Error resetting configuration: ${formatError(error)}`);
    }
  }
}
