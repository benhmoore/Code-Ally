/**
 * ConfigCommand - Manage configuration
 *
 * Handles configuration viewing, setting, and resetting with subcommand routing.
 */

import { Command } from './Command.js';
import type { Config, Message } from '@shared/index.js';
import { ActivityEventType } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { IntegrationStore } from '@services/IntegrationStore.js';
import { formatError } from '@utils/errorUtils.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';
import { CONFIG_CATEGORIES, formatConfigValue } from '@config/metadata.js';
import { DEFAULT_CONFIG, validateConfigValue } from '@config/defaults.js';
import { ANSI_COLORS } from '../../ui/constants/colors.js';
import { SEARCH_PROVIDER_INFO } from '../../types/integration.js';
import { applyRuntimeConfigUpdates } from '@services/RuntimeConfigSync.js';

// Fields stored in IntegrationStore instead of ConfigManager
const INTEGRATION_STORE_FIELDS = ['search_provider', 'search_api_key'] as const;
type IntegrationStoreField = typeof INTEGRATION_STORE_FIELDS[number];

export class ConfigCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/config',
    description: 'View or modify configuration',
    helpCategory: 'Core',
    subcommands: [
      { name: 'show', description: 'Show current configuration' },
      { name: 'setup', description: 'Configure provider, endpoint, credentials, and model' },
      { name: 'set', description: 'Set a config value', args: '<key>=<value>' },
      { name: 'reset', description: 'Reset one setting or all settings to defaults', args: '[key]' },
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

    if (subcommand.toLowerCase() === 'setup') {
      serviceRegistry.get('activity_stream')?.emit({
        id: `setup_${Date.now()}`, type: ActivityEventType.SETUP_WIZARD_REQUEST,
        timestamp: Date.now(), data: {},
      });
      return { handled: true };
    }

    if (subcommand.toLowerCase() === 'reset') {
      if (parts.length > 2) return this.createError('Use /config reset [key]');
      const key = parts[1];
      if (key) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) return this.createError(`Unknown config key '${key}'`);
        const value = DEFAULT_CONFIG[key as keyof Config];
        return this.handleConfigSet(`${key}=${JSON.stringify(value ?? null)}`, serviceRegistry);
      }
      return this.handleConfigReset(serviceRegistry);
    }

    if (subcommand.toLowerCase() === 'set') {
      // /config set key=value
      const kvString = parts.slice(1).join(' ');
      return this.handleConfigSet(kvString, serviceRegistry);
    }

    return this.createError('Invalid format. Use /config, /config setup, /config set key=value, or /config reset [key]');
  }

  private async handleConfigView(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const configManager = serviceRegistry.get('config_manager');

    if (!configManager) {
      return this.createError('Configuration manager not available');
    }

    const config = configManager.getConfig();

    // Include newly declared settings even before they have a display category.
    const categoryDefs = { ...CONFIG_CATEGORIES };
    const categorized = new Set(Object.values(categoryDefs).flat());
    categoryDefs.Other = (Object.keys(DEFAULT_CONFIG) as (keyof Config)[]).filter(key => !categorized.has(key));

    // Get search config from IntegrationStore
    const integrationStore = serviceRegistry.get('integration_store');
    const searchConfig = await this.getSearchConfig(integrationStore ?? undefined);


    // Find max key length and max value length for alignment
    const allKeys = Object.values(categoryDefs).flat();
    const maxKeyLen = Math.max(...allKeys.map(k => k.length));

    // Pre-compute all values to find max value length
    const allValues: { key: string; currentStr: string; defaultStr: string; isModified: boolean }[] = [];
    const displayValue = (key: string, value: unknown): string => {
      return formatConfigValue(key as keyof Config, value);
    };
    for (const keys of Object.values(categoryDefs)) {
      for (const key of keys) {
        let currentValue: any;
        const defaultValue = (DEFAULT_CONFIG as any)[key];

        // Handle IntegrationStore fields specially
        if (key === 'search_provider') {
          currentValue = searchConfig.provider;
        } else if (key === 'search_api_key') {
          // Mask API key - show only last 4 chars if set
          const apiKey = searchConfig.apiKey;
          currentValue = apiKey ? `****${apiKey.slice(-4)}` : null;
        } else {
          currentValue = (config as any)[key];
        }

        const currentStr = displayValue(key, currentValue);
        const defaultStr = displayValue(key, defaultValue);
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
    lines.push('Use `/config setup` for guided provider configuration');
    lines.push('Use `/config reset [key]` to restore one setting or all defaults');

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
   * Special handling:
   * - default_agent: shows available agents if no value provided
   * - search_provider: shows available providers if no value, routes to IntegrationStore
   * - search_api_key: routes to IntegrationStore with encryption
   */
  private async handleConfigSet(
    kvString: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const configManager = serviceRegistry.get('config_manager');

    if (!configManager) {
      return this.createError('Configuration manager not available');
    }

    const trimmed = kvString.trim();

    // Special handling for default_agent - show available agents if no value or just the key
    if (trimmed === 'default_agent' || trimmed === 'default_agent=') {
      return this.showAvailableAgents(serviceRegistry);
    }

    // Special handling for search_provider - show available providers if no value
    if (trimmed === 'search_provider' || trimmed === 'search_provider=') {
      return this.showAvailableSearchProviders();
    }

    // Parse key=value to check if it's an IntegrationStore field
    const parsed = configManager.parseKeyValue(kvString);
    if (parsed && INTEGRATION_STORE_FIELDS.includes(parsed.key as IntegrationStoreField)) {
      return this.handleIntegrationStoreSet(
        parsed.key as IntegrationStoreField,
        parsed.valueString,
        serviceRegistry
      );
    }

    if (parsed && (parsed.key === 'provider' || parsed.key === 'model' || parsed.key === 'endpoint')) {
      let parsedValue: unknown = parsed.valueString;
      try { parsedValue = JSON.parse(parsed.valueString); } catch { /* plain string */ }
      const validation = validateConfigValue(parsed.key, parsedValue);
      if (validation.valid) {
        const activeAgent = serviceRegistry.get('agent');
        const block = activeAgent?.getModelIdentityChangeBlock?.({
          [parsed.key]: validation.coercedValue,
        }) ?? serviceRegistry.get('agent_pool')?.getModelIdentityChangeBlock?.({ [parsed.key]: validation.coercedValue });
        if (block) return this.createError(block);
      }
    }

    try {
      const before = configManager.getConfig();
      const { key, oldValue, newValue } = await configManager.setFromString(kvString);
      const after = configManager.getConfig();
      const updates = Object.fromEntries(
        (Object.keys(after) as (keyof Config)[]).filter(field => !Object.is(before[field], after[field]))
          .map(field => [field, after[field]]),
      ) as Partial<Config>;

      applyRuntimeConfigUpdates(serviceRegistry, updates);

      // Notify UI of config change for immediate effect
      const activityStream = serviceRegistry.get('activity_stream');
      if (activityStream && typeof (activityStream as any).emit === 'function') {
        (activityStream as any).emit({
          id: `config_updated_${Date.now()}`,
          type: ActivityEventType.CONFIG_UPDATED,
          timestamp: Date.now(),
          data: updates,
        });
      }

      return this.createResponse(
        `Configuration updated: ${key}\n  Old value: ${formatConfigValue(key as keyof Config, oldValue)}\n  New value: ${formatConfigValue(key as keyof Config, newValue)}`
        + (updates.provider !== undefined ? `\nEndpoint: ${after.endpoint}\nUse /model to select a model from this provider. Provider credentials were cleared unless configured in setup.` : '')
      );
    } catch (error) {
      return this.createError(formatError(error));
    }
  }

  /**
   * Show available agents for default_agent configuration
   */
  private async showAvailableAgents(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const agentManager = serviceRegistry.get('agent_manager');

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

  /**
   * Get search configuration from IntegrationStore
   */
  private async getSearchConfig(integrationStore: IntegrationStore | undefined): Promise<{ provider: string; apiKey: string | null }> {
    if (!integrationStore) {
      return { provider: 'none', apiKey: null };
    }

    try {
      const settings = await integrationStore.getSettings();
      return {
        provider: settings.searchProvider,
        apiKey: settings.searchAPIKey,
      };
    } catch {
      return { provider: 'none', apiKey: null };
    }
  }

  /**
   * Show available search providers
   */
  private showAvailableSearchProviders(): CommandResult {
    const lines: string[] = [];
    lines.push('**Available search providers:**');
    lines.push('');

    for (const [type, info] of Object.entries(SEARCH_PROVIDER_INFO)) {
      const apiNote = info.requiresAPIKey ? ' (requires API key)' : '';
      lines.push(`\`${type}\` - ${info.displayName}: ${info.description}${apiNote}`);
      if (info.signupURL) {
        lines.push(`        Get API key: ${info.signupURL}`);
      }
    }

    lines.push('');
    lines.push('Usage: `/config set search_provider=<provider>`');
    lines.push('Then:  `/config set search_api_key=<your-key>`');

    return {
      handled: true,
      response: lines.join('\n'),
    };
  }

  /**
   * Handle setting IntegrationStore fields (search_provider, search_api_key)
   */
  private async handleIntegrationStoreSet(
    key: IntegrationStoreField,
    value: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const integrationStore = serviceRegistry.get('integration_store');

    if (!integrationStore) {
      return this.createError('Integration store not available');
    }

    try {
      const currentSettings = await integrationStore.getSettings();

      if (key === 'search_provider') {
        // Validate provider value
        const validation = validateConfigValue('search_provider', value);
        if (!validation.valid) {
          return this.createError(validation.error || 'Invalid search provider');
        }

        const oldValue = currentSettings.searchProvider;
        await integrationStore.setSearchProvider(validation.coercedValue);

        // If switching to a provider that requires API key and none set, remind user
        const providerInfo = SEARCH_PROVIDER_INFO[validation.coercedValue as keyof typeof SEARCH_PROVIDER_INFO];
        let note = '';
        if (providerInfo?.requiresAPIKey && !currentSettings.searchAPIKey) {
          note = `\n\nNote: ${providerInfo.displayName} requires an API key.`;
          note += `\nUse: /config set search_api_key=<your-key>`;
          if (providerInfo.signupURL) {
            note += `\nGet one at: ${providerInfo.signupURL}`;
          }
        }

        return this.createResponse(
          `Configuration updated: search_provider\n  Old value: "${oldValue}"\n  New value: "${validation.coercedValue}"${note}`
        );
      } else if (key === 'search_api_key') {
        // Handle API key - validate it's a string
        const validation = validateConfigValue('search_api_key', value);
        if (!validation.valid) {
          return this.createError(validation.error || 'Invalid API key');
        }

        const oldValue = currentSettings.searchAPIKey;
        const oldDisplay = oldValue ? `****${oldValue.slice(-4)}` : 'null';
        const newDisplay = validation.coercedValue ? `****${String(validation.coercedValue).slice(-4)}` : 'null';

        await integrationStore.setSearchAPIKey(validation.coercedValue);

        return this.createResponse(
          `Configuration updated: search_api_key\n  Old value: "${oldDisplay}"\n  New value: "${newDisplay}"`
        );
      }

      return this.createError(`Unknown integration field: ${key}`);
    } catch (error) {
      return this.createError(`Failed to update ${key}: ${formatError(error)}`);
    }
  }

  private async handleConfigReset(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const configManager = serviceRegistry.get('config_manager');

    if (!configManager) {
      return this.createError('Configuration manager not available');
    }

    try {
      const block = serviceRegistry.get('agent')?.getModelIdentityChangeBlock?.({
        provider: DEFAULT_CONFIG.provider,
        model: DEFAULT_CONFIG.model,
        endpoint: DEFAULT_CONFIG.endpoint,
      }) ?? serviceRegistry.get('agent_pool')?.getModelIdentityChangeBlock?.(DEFAULT_CONFIG);
      if (block) return this.createError(block);
      const changes = await configManager.reset();
      const changedKeys = Object.keys(changes);

      if (changedKeys.length === 0) {
        return this.createResponse('Configuration is already at default values.');
      }

      const currentConfig = configManager.getConfig();
      const updates = Object.fromEntries(
        changedKeys.map(key => [key, (currentConfig as any)[key]])
      ) as Partial<Config>;

      applyRuntimeConfigUpdates(serviceRegistry, updates);

      // Notify UI of all config changes for immediate effect
      const activityStream = serviceRegistry.get('activity_stream');
      if (activityStream && typeof (activityStream as any).emit === 'function') {
        (activityStream as any).emit({
          id: `config_updated_${Date.now()}`,
          type: ActivityEventType.CONFIG_UPDATED,
          timestamp: Date.now(),
          data: updates,
        });
      }

      return this.createResponse(
        `Configuration reset to defaults. ${changedKeys.length} settings changed.`
      );
    } catch (error) {
      return this.createError(`Error resetting configuration: ${formatError(error)}`);
    }
  }
}
