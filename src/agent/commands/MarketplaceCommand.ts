/**
 * MarketplaceCommand - Manage plugin marketplaces and installed plugins
 *
 * Handles marketplace registration, plugin installation/removal, and plugin state.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { formatError } from '@utils/errorUtils.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';
import type { MarketplaceManager } from '@marketplace/MarketplaceManager.js';
import type { PluginManager } from '@marketplace/PluginManager.js';
import type { MCPServerManager } from '@mcp/MCPServerManager.js';
import type { MCPServerConfig } from '@mcp/MCPConfig.js';
import type { ToolManagerService } from '@marketplace/types.js';
import type { SkillManager } from '@services/SkillManager.js';
import { toKebabCase } from '@utils/namingValidation.js';

export class MarketplaceCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/marketplace',
    description: 'Manage plugin marketplaces',
    helpCategory: 'Marketplace',
    subcommands: [
      { name: 'list', description: 'List known marketplaces and their plugins' },
      { name: 'add', description: 'Register a marketplace source', args: '<path-or-repo>' },
      { name: 'remove', description: 'Unregister a marketplace', args: '<name>' },
      { name: 'sync', description: 'Refresh marketplace(s) from source', args: '[name]' },
      { name: 'install', description: 'Install a plugin', args: '<name> or <marketplace/name>' },
      { name: 'uninstall', description: 'Uninstall a plugin', args: '<name>' },
      { name: 'update', description: 'Update one or all plugins', args: '[name]' },
      { name: 'status', description: 'Show installed plugins with status' },
      { name: 'enable', description: 'Enable a plugin', args: '<name>' },
      { name: 'disable', description: 'Disable a plugin', args: '<name>' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(MarketplaceCommand.metadata);
  }

  readonly name = MarketplaceCommand.metadata.name;
  readonly description = MarketplaceCommand.metadata.description;
  protected readonly useYellowOutput = MarketplaceCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const argString = args.join(' ').trim();
    const parts = argString.split(/\s+/);
    const subcommand = parts[0];

    if (!subcommand) {
      return this.showHelp();
    }

    switch (subcommand.toLowerCase()) {
      case 'list':
        return this.listMarketplaces(serviceRegistry);
      case 'add':
        return this.addMarketplace(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'remove':
        return this.removeMarketplace(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'sync':
        return this.syncMarketplace(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'install':
        return this.installPlugin(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'uninstall':
        return this.uninstallPlugin(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'update':
        return this.updatePlugin(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'status':
        return this.showStatus(serviceRegistry);
      case 'enable':
        return this.togglePlugin(parts.slice(1).join(' ').trim(), true, serviceRegistry);
      case 'disable':
        return this.togglePlugin(parts.slice(1).join(' ').trim(), false, serviceRegistry);
      default:
        return this.showHelp();
    }
  }

  // ===========================================================================
  // Subcommands
  // ===========================================================================

  private showHelp(): CommandResult {
    const lines = [
      '**Plugin Marketplace**',
      '',
      '`/marketplace list`                List known marketplaces and plugins',
      '`/marketplace add <path>`          Register a local directory as a marketplace',
      '`/marketplace add github:<repo>`   Register a GitHub repo as a marketplace',
      '`/marketplace remove <name>`       Unregister a marketplace',
      '`/marketplace sync [name]`         Refresh marketplace(s) from source',
      '`/marketplace install <plugin>`    Install a plugin (or marketplace/plugin)',
      '`/marketplace uninstall <plugin>`  Uninstall a plugin',
      '`/marketplace update [plugin]`     Update a plugin (or all)',
      '`/marketplace status`              Show installed plugins with status',
      '`/marketplace enable <plugin>`     Enable a plugin',
      '`/marketplace disable <plugin>`    Disable a plugin',
    ];
    return this.createResponse(lines.join('\n'));
  }

  private async listMarketplaces(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const mm = serviceRegistry.get<MarketplaceManager>('marketplace_manager');
    if (!mm) return this.createError('Marketplace manager not available');

    const marketplaces = await mm.listMarketplaces();

    if (marketplaces.length === 0) {
      return this.createResponse(
        'No marketplaces registered. Use `/marketplace add <path>` to add one.'
      );
    }

    const lines: string[] = ['**Known Marketplaces**', ''];

    for (const mkt of marketplaces) {
      const sourceLabel =
        mkt.source.type === 'directory'
          ? mkt.source.path || 'unknown'
          : `github:${mkt.source.repo}`;
      lines.push(`**${mkt.name}** (${sourceLabel})`);
      lines.push(`  ${mkt.description} | Owner: ${mkt.owner}`);

      if (mkt.plugins.length > 0) {
        for (const p of mkt.plugins) {
          lines.push(`  - ${p.name} v${p.version} — ${p.description}`);
        }
      } else {
        lines.push('  (no plugins)');
      }
      lines.push('');
    }

    return this.createResponse(lines.join('\n'));
  }

  private async addMarketplace(
    input: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!input) {
      return this.createError('Usage: /marketplace add <path> or /marketplace add github:<owner/repo>');
    }

    const mm = serviceRegistry.get<MarketplaceManager>('marketplace_manager');
    if (!mm) return this.createError('Marketplace manager not available');

    try {
      let source: { type: 'directory' | 'github'; path?: string; repo?: string };
      if (input.startsWith('github:')) {
        source = { type: 'github', repo: input.slice(7) };
      } else {
        source = { type: 'directory', path: input };
      }

      const name = await mm.addMarketplace(source);
      return this.createResponse(`Marketplace '${name}' added successfully.`);
    } catch (error) {
      return this.createError(formatError(error));
    }
  }

  private async removeMarketplace(
    name: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!name) return this.createError('Usage: /marketplace remove <name>');

    const mm = serviceRegistry.get<MarketplaceManager>('marketplace_manager');
    if (!mm) return this.createError('Marketplace manager not available');

    try {
      await mm.removeMarketplace(name);
      return this.createResponse(`Marketplace '${name}' removed.`);
    } catch (error) {
      return this.createError(formatError(error));
    }
  }

  private async syncMarketplace(
    name: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const mm = serviceRegistry.get<MarketplaceManager>('marketplace_manager');
    if (!mm) return this.createError('Marketplace manager not available');

    try {
      if (name) {
        await mm.syncMarketplace(name);
        return this.createResponse(`Marketplace '${name}' synced.`);
      } else {
        await mm.syncAll();
        return this.createResponse('All marketplaces synced.');
      }
    } catch (error) {
      return this.createError(formatError(error));
    }
  }

  private async installPlugin(
    input: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!input) {
      return this.createError('Usage: /marketplace install <plugin> or /marketplace install <marketplace>/<plugin>');
    }

    const mm = serviceRegistry.get<MarketplaceManager>('marketplace_manager');
    const pm = serviceRegistry.get<PluginManager>('plugin_manager');
    if (!mm || !pm) return this.createError('Marketplace system not available');

    let marketplace: string;
    let pluginName: string;

    if (input.includes('/')) {
      const parts = input.split('/', 2);
      marketplace = parts[0] ?? '';
      pluginName = parts[1] ?? '';
    } else {
      // Auto-detect marketplace
      const available = await mm.listAvailablePlugins();
      const matches = available.filter(p => p.name === input);

      if (matches.length === 0) {
        return this.createError(`Plugin '${input}' not found in any marketplace`);
      }
      if (matches.length > 1) {
        const names = matches.map(m => `${m.marketplace}/${m.name}`).join(', ');
        return this.createError(
          `Plugin '${input}' found in multiple marketplaces: ${names}. Specify as marketplace/plugin.`
        );
      }

      marketplace = matches[0]!.marketplace;
      pluginName = input;
    }

    const result = await pm.install(marketplace, pluginName);
    if (!result.success) {
      return this.createError(result.error || 'Installation failed');
    }

    // Start MCP servers for the new plugin
    const lines: string[] = [`Installed **${pluginName}** v${result.version} from ${marketplace}.`];

    if (result.mcpConfig) {
      const mcpManager = serviceRegistry.get<MCPServerManager>('mcp_server_manager');
      const toolManager = serviceRegistry.get<ToolManagerService>('tool_manager');

      if (mcpManager) {
        // Convert PluginMCPConfig to MCPServerConfig format
        const serverConfigs: Record<string, MCPServerConfig> = {};
        for (const [key, entry] of Object.entries(result.mcpConfig)) {
          serverConfigs[key] = {
            transport: 'stdio',
            command: entry.command,
            args: entry.args,
            env: entry.env,
            enabled: true,
            autoStart: true,
            requiresConfirmation: true,
          };
        }

        mcpManager.addPluginServers(pluginName, serverConfigs);

        // Start the servers
        for (const serverKey of Object.keys(result.mcpConfig)) {
          try {
            const tools = await mcpManager.startServer(serverKey);
            if (toolManager && tools.length > 0) {
              toolManager.registerTools(tools);
            }
            lines.push(`  MCP server '${serverKey}' started with ${tools.length} tool(s)`);
          } catch (error) {
            lines.push(`  MCP server '${serverKey}' failed to start: ${formatError(error)}`);
          }
        }
      }
    }

    // Load skills
    const skillManager = serviceRegistry.get<SkillManager>('skill_manager');
    if (skillManager) {
      try {
        await skillManager.loadPluginSkills(result.installPath, pluginName);
        lines.push('  Skills loaded');
      } catch {
        // Skills are optional
      }
    }

    return this.createResponse(lines.join('\n'));
  }

  private async uninstallPlugin(
    input: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!input) return this.createError('Usage: /marketplace uninstall <name>');

    const pm = serviceRegistry.get<PluginManager>('plugin_manager');
    if (!pm) return this.createError('Plugin manager not available');

    // Stop MCP servers first
    const mcpManager = serviceRegistry.get<MCPServerManager>('mcp_server_manager');
    const toolManager = serviceRegistry.get<ToolManagerService>('tool_manager');
    if (mcpManager) {
      const removed = await mcpManager.removePluginServers(input);
      if (toolManager) {
        for (const entry of removed) {
          // Unregister all tools from this server
          for (const tool of entry.tools) {
            const toolName = `mcp-${toKebabCase(entry.serverKey)}-${toKebabCase(tool.name)}`;
            toolManager.unregisterTool(toolName);
          }
        }
      }
    }

    // Remove skills
    const skillManager = serviceRegistry.get<SkillManager>('skill_manager');
    if (skillManager) {
      await skillManager.removePluginSkills(input);
    }

    const result = await pm.uninstall(input);
    if (!result.success) {
      return this.createError(result.error || 'Uninstall failed');
    }

    return this.createResponse(`Plugin '${result.pluginName}' uninstalled.`);
  }

  private async updatePlugin(
    input: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const pm = serviceRegistry.get<PluginManager>('plugin_manager');
    if (!pm) return this.createError('Plugin manager not available');

    if (input) {
      const result = await pm.update(input);
      if (!result.success) {
        return this.createError(result.error || 'Update failed');
      }
      return this.createResponse(`Plugin '${result.pluginName}' updated to v${result.version}.`);
    }

    // Update all
    const plugins = pm.getInstalledPlugins();
    const lines: string[] = [];
    for (const plugin of plugins) {
      const result = await pm.update(plugin.pluginKey);
      if (result.success) {
        lines.push(`${result.pluginName}: updated to v${result.version}`);
      } else {
        lines.push(`${plugin.pluginName}: ${result.error || 'failed'}`);
      }
    }

    return this.createResponse(
      lines.length > 0 ? lines.join('\n') : 'No plugins installed.'
    );
  }

  private async showStatus(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const pm = serviceRegistry.get<PluginManager>('plugin_manager');
    if (!pm) return this.createError('Plugin manager not available');

    const mcpManager = serviceRegistry.get<MCPServerManager>('mcp_server_manager');
    const plugins = pm.getInstalledPlugins();

    if (plugins.length === 0) {
      return this.createResponse(
        'No plugins installed. Use `/marketplace install <name>` to install one.'
      );
    }

    const lines: string[] = ['**Installed Plugins**', ''];

    for (const plugin of plugins) {
      const status = plugin.enabled ? 'enabled' : 'disabled';
      lines.push(`**${plugin.pluginName}** v${plugin.version} [${status}]`);
      lines.push(`  Marketplace: ${plugin.marketplace} | Installed: ${plugin.installedAt.split('T')[0]}`);

      // Show MCP server status
      if (mcpManager) {
        for (const serverName of mcpManager.getConfiguredServers()) {
          if (mcpManager.getServerPluginOwner(serverName) === plugin.pluginName) {
            const serverStatus = mcpManager.getServerStatus(serverName);
            const toolCount = serverStatus.toolCount ?? 0;
            lines.push(`  MCP: ${serverName} (${serverStatus.status}, ${toolCount} tools)`);
          }
        }
      }
      lines.push('');
    }

    return this.createResponse(lines.join('\n'));
  }

  private async togglePlugin(
    input: string,
    enabled: boolean,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!input) return this.createError(`Usage: /marketplace ${enabled ? 'enable' : 'disable'} <name>`);

    const pm = serviceRegistry.get<PluginManager>('plugin_manager');
    if (!pm) return this.createError('Plugin manager not available');

    const success = await pm.setEnabled(input, enabled);
    if (!success) {
      return this.createError(`Plugin '${input}' not found`);
    }

    const action = enabled ? 'enabled' : 'disabled';
    return this.createResponse(`Plugin '${input}' ${action}. Restart to apply.`);
  }
}
