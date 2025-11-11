/**
 * ConfigCommand - Manage configuration
 *
 * Handles configuration viewing, setting, and resetting with subcommand routing.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import { ActivityEventType } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { ConfigManager } from '@services/ConfigManager.js';
import { formatError } from '@utils/errorUtils.js';

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

    // Parse input supporting multiple formats:
    // 1. key=value
    // 2. key   = value (with spaces)
    // 3. key value (space-separated)
    const parsed = this.parseKeyValue(kvString);

    if (!parsed) {
      return this.createError('Invalid format. Use /config set key=value, key = value, or key value');
    }

    const { key, valueString } = parsed;

    // Check if key exists
    if (!configManager.hasKey(key)) {
      // Show current value of suggested config field
      const suggestions = this.getSimilarKeys(key, configManager.getKeys() as ReadonlyArray<string>);

      if (suggestions.length > 0) {
        let errorMsg = `Unknown configuration key: ${key}.`;

        // Show suggestions with current values
        errorMsg += '\n\nDid you mean one of these?';
        for (const suggestedKey of suggestions) {
          const currentValue = configManager.getValue(suggestedKey as any);
          errorMsg += `\n  ${suggestedKey} (current: ${JSON.stringify(currentValue)})`;
        }

        return this.createError(errorMsg);
      }

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

      const oldValue = configManager.getValue(key as any);
      await configManager.setValue(key as any, value);

      return this.createResponse(
        `Configuration updated: ${key}\n  Old value: ${JSON.stringify(oldValue)}\n  New value: ${JSON.stringify(value)}`
      );
    } catch (error) {
      return this.createError(`Error updating configuration: ${formatError(error)}`);
    }
  }

  /**
   * Parse key-value input supporting multiple formats
   */
  private parseKeyValue(input: string): { key: string; valueString: string } | null {
    if (!input || !input.trim()) {
      return null;
    }

    // Try format 1 & 2: key=value or key = value
    const equalsMatch = input.match(/^([^=]+)=(.+)$/);
    if (equalsMatch && equalsMatch[1] && equalsMatch[2]) {
      const key = equalsMatch[1].trim();
      const valueString = equalsMatch[2].trim();
      if (key && valueString) {
        return { key, valueString };
      }
    }

    // Try format 3: key value (space-separated)
    const spaceMatch = input.match(/^(\S+)\s+(.+)$/);
    if (spaceMatch && spaceMatch[1] && spaceMatch[2]) {
      const key = spaceMatch[1].trim();
      const valueString = spaceMatch[2].trim();
      if (key && valueString) {
        return { key, valueString };
      }
    }

    return null;
  }

  /**
   * Get similar keys for suggestions using simple string similarity
   */
  private getSimilarKeys(input: string, allKeys: ReadonlyArray<string>): string[] {
    const lowerInput = input.toLowerCase();

    // Find keys that start with the input or contain it
    const matches = allKeys.filter(key => {
      const lowerKey = key.toLowerCase();
      return lowerKey.startsWith(lowerInput) || lowerKey.includes(lowerInput);
    });

    // Sort by relevance (exact prefix match first, then contains)
    return matches
      .sort((a, b) => {
        const aStr = a.toLowerCase();
        const bStr = b.toLowerCase();
        const aStarts = aStr.startsWith(lowerInput);
        const bStarts = bStr.startsWith(lowerInput);

        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return aStr.localeCompare(bStr);
      })
      .slice(0, 3); // Limit to top 3 suggestions
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
