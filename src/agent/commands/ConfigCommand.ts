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
import { formatConfigValue } from '@config/metadata.js';
import { DEFAULT_CONFIG, validateConfigValue } from '@config/defaults.js';
import { presentConfiguration } from '@config/configPresentation.js';
import { SEARCH_PROVIDER_INFO } from '../../types/integration.js';
import { readSearchConfiguration, updateSearchConfiguration } from '@services/SearchConfiguration.js';
import { applyRuntimeConfigUpdates } from '@services/RuntimeConfigSync.js';

// Fields stored in IntegrationStore instead of ConfigManager
const INTEGRATION_STORE_FIELDS = ['search_provider', 'search_api_key'] as const;
type IntegrationStoreField = (typeof INTEGRATION_STORE_FIELDS)[number];

export class ConfigCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/config',
    description: 'View or modify configuration',
    helpCategory: 'Core',
    subcommands: [
      {
        name: 'show',
        description: 'Inspect a setting, category, changed values, or all settings',
        args: '[key|category|changed|all]',
      },
      { name: 'setup', description: 'Configure provider, endpoint, credentials, and model' },
      { name: 'set', description: 'Set a config value', args: '<key>=<value>' },
      { name: 'reset', description: 'Reset app settings or one named setting to defaults', args: '[key]' },
    ],
  };

  static {
    CommandRegistry.register(ConfigCommand.metadata);
  }

  readonly name = ConfigCommand.metadata.name;
  readonly description = ConfigCommand.metadata.description;
  protected readonly useYellowOutput = ConfigCommand.metadata.useYellowOutput ?? false;

  async execute(args: string[], _messages: Message[], serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    // Parse subcommands
    const parts = argString.split(/\s+/);
    const subcommand = parts[0];

    // No args or "show" - show interactive config viewer
    if (!argString || subcommand?.toLowerCase() === 'show') {
      return this.handleConfigView(serviceRegistry, argString ? parts.slice(1).join(' ') || 'all' : undefined);
    }

    if (!subcommand) {
      return this.createError('Invalid config command');
    }

    if (subcommand.toLowerCase() === 'setup') {
      serviceRegistry.get('activity_stream')?.emit({
        id: `setup_${Date.now()}`,
        type: ActivityEventType.SETUP_WIZARD_REQUEST,
        timestamp: Date.now(),
        data: {},
      });
      return { handled: true };
    }

    if (subcommand.toLowerCase() === 'reset') {
      if (parts.length > 2) return this.createError('Use /config reset [key]');
      const key = parts[1];
      if (key) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key))
          return this.createError(`Unknown config key '${key}'`);
        const setting = key as keyof Config;
        if (INTEGRATION_STORE_FIELDS.includes(setting as IntegrationStoreField)) {
          return this.handleIntegrationStoreSet(
            setting as IntegrationStoreField,
            JSON.stringify(DEFAULT_CONFIG[setting]),
            serviceRegistry
          );
        }
        const block = this.identityChangeBlock(serviceRegistry, { [setting]: DEFAULT_CONFIG[setting] });
        if (block) return this.createError(block);
        const manager = serviceRegistry.get('config_manager');
        if (!manager) return this.createError('Configuration manager not available');
        return this.persistConfigChange(serviceRegistry, () => manager.resetField(setting));
      }
      return this.handleConfigReset(serviceRegistry);
    }

    if (subcommand.toLowerCase() === 'set') {
      // /config set key=value
      const kvString = parts.slice(1).join(' ');
      return this.handleConfigSet(kvString, serviceRegistry);
    }

    return this.createError(
      'Invalid format. Use /config, /config setup, /config set key=value, or /config reset [key]'
    );
  }

  private async handleConfigView(serviceRegistry: ServiceRegistry, query?: string): Promise<CommandResult> {
    const manager = serviceRegistry.get('config_manager');
    if (!manager) return this.createError('Configuration manager not available');
    const search = await this.getSearchConfig(serviceRegistry.get('integration_store') ?? undefined);
    const config = { ...manager.getConfig(), search_provider: search.provider, search_api_key: search.apiKey };
    const content = presentConfiguration(config, query);
    return content
      ? { handled: true, response: content }
      : this.createError(
          `No setting or category matches '${query}'. Use /config show all or /config show context_size.`
        );
  }

  private identityChangeBlock(registry: ServiceRegistry, updates: Partial<Config>): string | null {
    return (
      registry.get('agent')?.getModelIdentityChangeBlock(updates) ??
      registry.get('agent_pool')?.getModelIdentityChangeBlock(updates) ??
      null
    );
  }

  /** Persist once, refresh runtime once, then notify the frontend of committed settings. */
  private async persistConfigChange(
    registry: ServiceRegistry,
    write: () => Promise<{ key: string; oldValue: unknown; newValue: unknown }>
  ): Promise<CommandResult> {
    const manager = registry.get('config_manager');
    if (!manager) return this.createError('Configuration manager not available');
    let committed: Partial<Config> | undefined;
    try {
      const before = manager.getConfig();
      const { key, oldValue, newValue } = await write();
      const after = manager.getConfig();
      const updates = Object.fromEntries(
        (Object.keys(after) as (keyof Config)[])
          .filter(field => !Object.is(before[field], after[field]))
          .map(field => [field, after[field]])
      ) as Partial<Config>;
      // Retrying a saved-but-unapplied value must reapply the requested key.
      Object.assign(updates, { [key]: after[key as keyof Config] });
      if (key === 'provider') Object.assign(updates, { endpoint: after.endpoint, api_key: after.api_key });
      committed = updates;
      applyRuntimeConfigUpdates(registry, updates);
      registry.get('activity_stream')?.emit({
        id: `config_updated_${Date.now()}`,
        type: ActivityEventType.CONFIG_UPDATED,
        timestamp: Date.now(),
        data: updates,
      });
      const phase =
        key === 'default_agent' || key === 'setup_completed'
          ? 'Saved to profile. Takes effect at the next launch.'
          : 'Saved to profile and applied to subsequent work.';
      return this.createResponse(
        `Configuration updated: ${key}\n${phase}\n  Previous: ${formatConfigValue(key as keyof Config, oldValue)}\n  Current: ${formatConfigValue(key as keyof Config, newValue)}` +
          (updates.provider !== undefined
            ? `\nEndpoint: ${after.endpoint}\nChoose a model with /model. Configure credentials with /config setup.`
            : '') +
          (key === 'context_size' && Number(newValue) < 32768
            ? '\nFor everyday coding, use context_size=32768 or larger. This smaller window is useful for stress testing.'
            : '')
      );
    } catch (error) {
      if (committed) {
        registry.get('activity_stream')?.emit({
          id: `config_updated_${Date.now()}`,
          type: ActivityEventType.CONFIG_UPDATED,
          timestamp: Date.now(),
          data: committed,
        });
        return this.createError(
          `Settings saved, but could not be applied: ${formatError(error)}\nRestart Ally to use the saved settings, or retry the change.`
        );
      }
      return this.createError(formatError(error));
    }
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
  private async handleConfigSet(kvString: string, serviceRegistry: ServiceRegistry): Promise<CommandResult> {
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
      return this.handleIntegrationStoreSet(parsed.key as IntegrationStoreField, parsed.valueString, serviceRegistry);
    }

    if (parsed && (parsed.key === 'provider' || parsed.key === 'model' || parsed.key === 'endpoint')) {
      let parsedValue: unknown = parsed.valueString;
      try {
        parsedValue = JSON.parse(parsed.valueString);
      } catch {
        /* plain string */
      }
      const validation = validateConfigValue(parsed.key, parsedValue);
      if (validation.valid) {
        const block = this.identityChangeBlock(serviceRegistry, { [parsed.key]: validation.coercedValue });
        if (block) return this.createError(block);
      }
    }

    if (!parsed && configManager.hasKey(trimmed)) return this.handleConfigView(serviceRegistry, trimmed);
    return this.persistConfigChange(serviceRegistry, () => configManager.setFromString(kvString));
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
  private async getSearchConfig(
    integrationStore: IntegrationStore | undefined
  ): Promise<{ provider: Config['search_provider']; apiKey: string | null }> {
    if (!integrationStore) {
      return { provider: 'none', apiKey: null };
    }

    try {
      const settings = await readSearchConfiguration(integrationStore);
      return { provider: settings.search_provider, apiKey: settings.search_api_key };
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
      let parsedValue: unknown = value;
      try {
        parsedValue = JSON.parse(value);
      } catch {
        /* Plain text value. */
      }

      if (key === 'search_provider') {
        // Validate provider value
        const validation = validateConfigValue('search_provider', parsedValue);
        if (!validation.valid) {
          return this.createError(validation.error || 'Invalid search provider');
        }

        const oldValue = currentSettings.searchProvider;
        await updateSearchConfiguration(integrationStore, 'search_provider', validation.coercedValue);

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
          `Configuration updated: search_provider\nSaved securely and applied to subsequent searches.\n  Old value: "${oldValue}"\n  New value: "${validation.coercedValue}"${note}`
        );
      } else if (key === 'search_api_key') {
        // Handle API key - validate it's a string
        const validation = validateConfigValue('search_api_key', parsedValue);
        if (!validation.valid) {
          return this.createError(validation.error || 'Invalid API key');
        }

        const oldValue = currentSettings.searchAPIKey;
        const oldDisplay = oldValue ? `****${oldValue.slice(-4)}` : 'null';
        const newDisplay = validation.coercedValue ? `****${String(validation.coercedValue).slice(-4)}` : 'null';

        await updateSearchConfiguration(integrationStore, 'search_api_key', validation.coercedValue);

        return this.createResponse(
          `Configuration updated: search_api_key\nSaved securely and applied to subsequent searches.\n  Old value: "${oldDisplay}"\n  New value: "${newDisplay}"`
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

    let committed: Partial<Config> | undefined;
    try {
      const block =
        serviceRegistry.get('agent')?.getModelIdentityChangeBlock({
          provider: DEFAULT_CONFIG.provider,
          model: DEFAULT_CONFIG.model,
          endpoint: DEFAULT_CONFIG.endpoint,
        }) ?? serviceRegistry.get('agent_pool')?.getModelIdentityChangeBlock(DEFAULT_CONFIG);
      if (block) return this.createError(block);
      const changes = await configManager.reset();
      const changedKeys = Object.keys(changes);

      const currentConfig = configManager.getConfig();
      // Reset is also an activation retry when defaults were saved earlier.
      const updates: Partial<Config> = { ...currentConfig };

      committed = updates;
      applyRuntimeConfigUpdates(serviceRegistry, updates);

      // Notify UI of all config changes for immediate effect
      serviceRegistry.get('activity_stream')?.emit({
        id: `config_updated_${Date.now()}`,
        type: ActivityEventType.CONFIG_UPDATED,
        timestamp: Date.now(),
        data: updates,
      });

      return this.createResponse(
        `Configuration reset to defaults. ${changedKeys.length} settings changed. Saved to profile; live settings refreshed.\nSearch integration settings are retained; reset them by name with /config reset search_provider or /config reset search_api_key.\nUse /config to review.`
      );
    } catch (error) {
      if (committed) {
        serviceRegistry.get('activity_stream')?.emit({
          id: `config_updated_${Date.now()}`,
          type: ActivityEventType.CONFIG_UPDATED,
          timestamp: Date.now(),
          data: committed,
        });
        return this.createError(
          `Defaults saved, but could not be applied: ${formatError(error)}\nRestart Ally to use the saved defaults.`
        );
      }
      return this.createError(`Error resetting configuration: ${formatError(error)}`);
    }
  }
}
