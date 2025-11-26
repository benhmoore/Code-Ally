/**
 * ConfigCommand - Manage configuration
 *
 * Handles configuration viewing, setting, and resetting with subcommand routing.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { ConfigManager } from '@services/ConfigManager.js';
import { formatError } from '@utils/errorUtils.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';
import { DEFAULT_CONFIG } from '@config/defaults.js';
import { ANSI_COLORS } from '../../ui/constants/colors.js';

export class ConfigCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/config',
    description: 'View or modify configuration',
    helpCategory: 'Core',
    subcommands: [
      { name: 'set', description: 'Set a config value', args: '<key>=<value>' },
      { name: 'reset', description: 'Reset to defaults' },
    ],
  };

  static {
    CommandRegistry.register(ConfigCommand.metadata);
  }

  readonly name = ConfigCommand.metadata.name;
  readonly description = ConfigCommand.metadata.description;
  protected readonly useYellowOutput = ConfigCommand.metadata.useYellowOutput ?? false;

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
    const configManager = serviceRegistry.get<ConfigManager>('config_manager');

    if (!configManager) {
      return this.createError('Configuration manager not available');
    }

    const config = configManager.getConfig();

    // Category definitions matching ConfigViewer
    const categoryDefs = {
      'LLM Model Settings': ['model', 'service_model', 'explore_model', 'plan_model', 'endpoint', 'context_size', 'temperature', 'max_tokens', 'reasoning_effort'],
      'Agent Settings': ['default_agent'],
      'Execution Settings': ['bash_timeout', 'auto_confirm', 'parallel_tools'],
      'File System Settings': ['temp_directory'],
      'UI Preferences': ['theme', 'compact_threshold', 'show_context_in_prompt', 'show_thinking_in_chat', 'show_system_prompt_in_chat', 'show_full_tool_output', 'show_tool_parameters_in_chat', 'enable_idle_messages', 'enable_session_title_generation'],
      'Diff Display': ['diff_display_enabled', 'diff_display_max_file_size', 'diff_display_context_lines', 'diff_display_theme', 'diff_display_color_removed', 'diff_display_color_added', 'diff_display_color_modified'],
      'Tool Result Truncation': ['tool_result_max_context_percent', 'tool_result_min_tokens'],
    };


    // Find max key length and max value length for alignment
    const allKeys = Object.values(categoryDefs).flat();
    const maxKeyLen = Math.max(...allKeys.map(k => k.length));

    // Pre-compute all values to find max value length
    const allValues: { key: string; currentStr: string; defaultStr: string; isModified: boolean }[] = [];
    for (const keys of Object.values(categoryDefs)) {
      for (const key of keys) {
        const currentValue = (config as any)[key];
        const defaultValue = (DEFAULT_CONFIG as any)[key];
        const currentStr = JSON.stringify(currentValue);
        const defaultStr = JSON.stringify(defaultValue);
        const isModified = currentStr !== defaultStr;
        allValues.push({ key, currentStr, defaultStr, isModified });
      }
    }
    const maxValueLen = Math.max(...allValues.map(v => v.currentStr.length));

    // Helper to escape URLs in values (wrap in backticks to prevent link rendering)
    const escapeValue = (val: string): string => {
      // If value contains :// it's likely a URL, wrap in backticks
      if (val.includes('://')) {
        return `\`${val}\``;
      }
      return val;
    };

    // Build markdown output
    const lines: string[] = [];
    lines.push('# Configuration');
    lines.push('');

    let valueIdx = 0;
    for (const [categoryName, keys] of Object.entries(categoryDefs)) {
      lines.push(`**${categoryName}**`);

      for (const key of keys) {
        const entry = allValues[valueIdx++]!;
        const { currentStr, defaultStr, isModified } = entry;
        const paddedKey = key.padEnd(maxKeyLen);
        const paddedValue = currentStr.padEnd(maxValueLen);

        let line: string;
        if (isModified) {
          // Highlight modified values in orange
          line = `\`${paddedKey}\`  ${ANSI_COLORS.WARNING}${escapeValue(paddedValue)}${ANSI_COLORS.RESET}  (default: ${escapeValue(defaultStr)})`;
        } else {
          line = `\`${paddedKey}\`  ${escapeValue(paddedValue)}  (default)`;
        }

        lines.push(line);
      }

      lines.push('');
    }

    // Footer
    lines.push('---');
    lines.push('');
    lines.push('Use `/config set key=value` to change settings');
    lines.push('Use `/config reset` to restore all defaults');

    return {
      handled: true,
      response: lines.join('\n'),
    };
  }

  /**
   * Handle /config set key=value command
   *
   * Uses ConfigManager.setFromString() to parse input, validate key,
   * parse value, and update configuration.
   *
   * Special handling for default_agent: shows available agents if no value provided.
   */
  private async handleConfigSet(
    kvString: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const configManager = serviceRegistry.get<ConfigManager>('config_manager');

    if (!configManager) {
      return this.createError('Configuration manager not available');
    }

    // Special handling for default_agent - show available agents if no value or just the key
    const trimmed = kvString.trim();
    if (trimmed === 'default_agent' || trimmed === 'default_agent=') {
      return this.showAvailableAgents(serviceRegistry);
    }

    try {
      const { key, oldValue, newValue } = await configManager.setFromString(kvString);

      return this.createResponse(
        `Configuration updated: ${key}\n  Old value: ${JSON.stringify(oldValue)}\n  New value: ${JSON.stringify(newValue)}`
      );
    } catch (error) {
      return this.createError(formatError(error));
    }
  }

  /**
   * Show available agents for default_agent configuration
   */
  private async showAvailableAgents(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const { AgentManager } = await import('@services/AgentManager.js');
    const agentManager = serviceRegistry.get<InstanceType<typeof AgentManager>>('agent_manager');

    if (!agentManager) {
      return this.createError('Agent manager not available');
    }

    try {
      const agents = await agentManager.listAgents(undefined, { includeInactivePlugins: true });

      const lines: string[] = [];
      lines.push('**Available agents for default_agent:**');
      lines.push('');
      lines.push('`ally` - Main Ally agent (default)');

      for (const agent of agents) {
        const inactive = agent.isInactive ? ' (plugin inactive)' : '';
        lines.push(`\`${agent.name}\` - ${agent.description || 'No description'}${inactive}`);
      }

      lines.push('');
      lines.push('Usage: `/config set default_agent=<agent-name>`');

      return {
        handled: true,
        response: lines.join('\n'),
      };
    } catch (error) {
      return this.createError(`Failed to list agents: ${formatError(error)}`);
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
