/**
 * MCPCommand - Manage MCP (Model Context Protocol) servers
 *
 * Handles MCP server lifecycle management with subcommand routing.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { formatError } from '@utils/errorUtils.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';
import type { MCPServerManager } from '@mcp/MCPServerManager.js';
import { MCPServerStatus } from '@mcp/types.js';
import type { MCPServerConfig } from '@mcp/MCPConfig.js';
import { applyConfigDefaults } from '@mcp/MCPConfig.js';
import { MCP_PRESETS, MCP_PRESET_ORDER, buildConfigFromPreset } from '@mcp/MCPPresets.js';
import type { ToolManagerService } from '@plugins/interfaces.js';
import { toKebabCase } from '@utils/namingValidation.js';

export class MCPCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/mcp',
    description: 'Manage MCP servers',
    helpCategory: 'MCP',
    subcommands: [
      { name: 'list', description: 'List configured servers with status' },
      { name: 'status', description: 'Detailed connection status' },
      { name: 'start', description: 'Connect and discover tools', args: '<name>' },
      { name: 'stop', description: 'Disconnect server', args: '<name>' },
      { name: 'restart', description: 'Restart server', args: '<name>' },
      { name: 'add', description: 'Add a server (presets: filesystem, github, memory, fetch)', args: '[name]' },
      { name: 'remove', description: 'Remove server and config', args: '<name>' },
      { name: 'tools', description: 'List discovered tools', args: '[name]' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(MCPCommand.metadata);
  }

  readonly name = MCPCommand.metadata.name;
  readonly description = MCPCommand.metadata.description;
  protected readonly useYellowOutput = MCPCommand.metadata.useYellowOutput ?? false;

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
        return this.listServers(serviceRegistry);
      case 'status':
        return this.showStatus(serviceRegistry);
      case 'start':
        return this.startServer(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'stop':
        return this.stopServer(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'restart':
        return this.restartServer(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'add':
        return this.addServer(parts.slice(1), serviceRegistry);
      case 'remove':
        return this.removeServer(parts.slice(1).join(' ').trim(), serviceRegistry);
      case 'tools':
        return this.listTools(parts.slice(1).join(' ').trim(), serviceRegistry);
      default:
        return this.showHelp();
    }
  }

  private getManager(serviceRegistry: ServiceRegistry): MCPServerManager | null {
    return serviceRegistry.get<MCPServerManager>('mcp_server_manager');
  }

  private async listServers(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const manager = this.getManager(serviceRegistry);
    if (!manager) return this.createError('MCP server management not available');

    const servers = manager.getConfiguredServers();
    if (servers.length === 0) {
      return this.createResponse('No MCP servers configured. Use `/mcp add <name>` to add one.');
    }

    let output = '## MCP Servers\n\n';
    output += '| Status | Name | Transport | Tools | Auto-Start |\n';
    output += '|--------|------|-----------|-------|------------|\n';

    for (const name of servers) {
      const status = manager.getServerStatus(name);
      const config = manager.getServerConfig(name);
      const defaults = config ? applyConfigDefaults(config) : null;

      const statusIcon = this.statusIcon(status.status);
      const transport = config?.transport ?? '?';
      const toolCount = status.toolCount !== undefined ? String(status.toolCount) : '-';
      const autoStart = defaults?.autoStart ? 'yes' : 'no';

      output += `| ${statusIcon} | ${name} | ${transport} | ${toolCount} | ${autoStart} |\n`;
    }

    return { handled: true, response: output };
  }

  private async showStatus(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const manager = this.getManager(serviceRegistry);
    if (!manager) return this.createError('MCP server management not available');

    const servers = manager.getConfiguredServers();
    if (servers.length === 0) {
      return this.createResponse('No MCP servers configured.');
    }

    let output = '## MCP Server Status\n\n';

    for (const name of servers) {
      const status = manager.getServerStatus(name);
      const config = manager.getServerConfig(name);

      output += `**${name}** ${this.statusIcon(status.status)} ${status.status}\n`;

      if (config) {
        if (config.transport === 'stdio' && config.command) {
          output += `  Command: \`${config.command} ${(config.args ?? []).join(' ')}\`\n`;
        } else if (config.transport === 'sse' && config.url) {
          output += `  URL: ${config.url}\n`;
        }
      }

      if (status.toolCount !== undefined) {
        output += `  Tools: ${status.toolCount}\n`;
      }
      if (status.error) {
        output += `  Error: ${status.error}\n`;
      }
      output += '\n';
    }

    return { handled: true, response: output };
  }

  private async startServer(
    name: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!name) {
      return this.createError('Server name required. Use `/mcp start <name>`');
    }

    const manager = this.getManager(serviceRegistry);
    if (!manager) return this.createError('MCP server management not available');

    try {
      const tools = await manager.startServer(name);

      // Register discovered tools with ToolManager
      const toolManager = serviceRegistry.get<ToolManagerService>('tool_manager');
      if (toolManager && tools.length > 0) {
        for (const tool of tools) {
          toolManager.registerTool(tool);
        }
      }

      // Register with PluginActivationManager so tools pass activation filtering
      this.registerMcpSource(name, serviceRegistry);

      return this.createResponse(
        `Connected to '${name}' — ${tools.length} tool(s) discovered and registered`
      );
    } catch (error) {
      return this.createError(`Failed to start '${name}': ${formatError(error)}`);
    }
  }

  private async stopServer(
    name: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!name) {
      return this.createError('Server name required. Use `/mcp stop <name>`');
    }

    const manager = this.getManager(serviceRegistry);
    if (!manager) return this.createError('MCP server management not available');

    try {
      this.unregisterServerTools(manager, name, serviceRegistry);
      this.unregisterMcpSource(name, serviceRegistry);
      await manager.stopServer(name);
      return this.createResponse(`Disconnected from '${name}'`);
    } catch (error) {
      return this.createError(`Failed to stop '${name}': ${formatError(error)}`);
    }
  }

  private async restartServer(
    name: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!name) {
      return this.createError('Server name required. Use `/mcp restart <name>`');
    }

    const manager = this.getManager(serviceRegistry);
    if (!manager) return this.createError('MCP server management not available');

    try {
      // Stop if connected
      const status = manager.getServerStatus(name);
      if (status.status === MCPServerStatus.CONNECTED || status.status === MCPServerStatus.ERROR) {
        this.unregisterServerTools(manager, name, serviceRegistry);
        this.unregisterMcpSource(name, serviceRegistry);
        await manager.stopServer(name);
      }

      // Start fresh
      const tools = await manager.startServer(name);

      // Register new tools
      const toolManager = serviceRegistry.get<ToolManagerService>('tool_manager');
      if (toolManager && tools.length > 0) {
        for (const tool of tools) {
          toolManager.registerTool(tool);
        }
      }

      this.registerMcpSource(name, serviceRegistry);

      return this.createResponse(
        `Restarted '${name}' — ${tools.length} tool(s) discovered`
      );
    } catch (error) {
      return this.createError(`Failed to restart '${name}': ${formatError(error)}`);
    }
  }

  private async addServer(
    args: string[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const name = args[0];

    // No args: show available presets
    if (!name) {
      return this.showPresets();
    }

    const manager = this.getManager(serviceRegistry);
    if (!manager) return this.createError('MCP server management not available');

    // Check if name matches a preset
    const preset = MCP_PRESETS[name];
    if (preset) {
      const extraArg = args[1];

      // Preset requires input but none provided — show usage
      if (preset.needsPath && !extraArg) {
        return this.createError(
          `The '${name}' server requires a directory path.\n` +
          `Usage: \`/mcp add ${name} /path/to/directory\``
        );
      }
      if (preset.needsEnvKey && !extraArg) {
        return this.createError(
          `The '${name}' server requires a ${preset.needsEnvKey}.\n` +
          `Usage: \`/mcp add ${name} <${preset.envHint || 'value'}>\``
        );
      }

      const path = preset.needsPath ? extraArg : undefined;
      const envValue = preset.needsEnvKey ? extraArg : undefined;
      const config = buildConfigFromPreset(preset, path, envValue);

      try {
        await manager.addServerConfig(name, config);
        const autoNote = config.autoStart ? ' (auto-start enabled)' : '';
        let response = `Added MCP server '${name}'${autoNote}`;
        if (config.autoStart) {
          response += `\nIt will connect automatically on next startup. To connect now: \`/mcp start ${name}\``;
        } else {
          response += `\nUse \`/mcp start ${name}\` to connect.`;
        }
        return this.createResponse(response);
      } catch (error) {
        return this.createError(`Failed to add server: ${formatError(error)}`);
      }
    }

    // Not a preset — parse key=value pairs for custom config
    const config: MCPServerConfig = { transport: 'stdio' };
    for (const arg of args.slice(1)) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx === -1) continue;
      const key = arg.slice(0, eqIdx);
      const value = arg.slice(eqIdx + 1);

      switch (key) {
        case 'transport':
          if (value === 'stdio' || value === 'sse') config.transport = value;
          break;
        case 'command':
          config.command = value;
          break;
        case 'url':
          config.url = value;
          break;
        case 'autoStart':
          config.autoStart = value === 'true';
          break;
        case 'requiresConfirmation':
          config.requiresConfirmation = value === 'true';
          break;
        case 'enabled':
          config.enabled = value === 'true';
          break;
      }
    }

    // Require at minimum a command or url
    if (!config.command && !config.url) {
      return this.createError(
        `Custom server '${name}' needs at least a command or url.\n` +
        `Usage: \`/mcp add ${name} command=npx args=-y,@scope/server\``
      );
    }

    try {
      await manager.addServerConfig(name, config);
      let response = `Added MCP server '${name}' (${config.transport})`;
      if (config.command) response += ` — command: ${config.command}`;
      if (config.url) response += ` — url: ${config.url}`;
      response += `\nUse \`/mcp start ${name}\` to connect.`;
      return this.createResponse(response);
    } catch (error) {
      return this.createError(`Failed to add server: ${formatError(error)}`);
    }
  }

  private showPresets(): CommandResult {
    let output = '## Add MCP Server\n\n';
    output += '**Quick setup from presets:**\n\n';

    for (const key of MCP_PRESET_ORDER) {
      const preset = MCP_PRESETS[key];
      if (!preset) continue;

      let example = `/mcp add ${key}`;
      if (preset.needsPath) example += ` ${preset.pathHint || '/path'}`;
      else if (preset.needsEnvKey) example += ` ${preset.envHint || '<value>'}`;

      output += `\`${example}\`\n`;
      output += `  ${preset.description}\n\n`;
    }

    output += '**Custom server:**\n';
    output += '`/mcp add <name> command=<cmd> args=<a1>,<a2>`\n';

    return { handled: true, response: output };
  }

  private async removeServer(
    name: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (!name) {
      return this.createError('Server name required. Use `/mcp remove <name>`');
    }

    const manager = this.getManager(serviceRegistry);
    if (!manager) return this.createError('MCP server management not available');

    try {
      this.unregisterServerTools(manager, name, serviceRegistry);
      this.unregisterMcpSource(name, serviceRegistry);
      await manager.removeServerConfig(name);
      return this.createResponse(`Removed MCP server '${name}'`);
    } catch (error) {
      return this.createError(`Failed to remove server: ${formatError(error)}`);
    }
  }

  private async listTools(
    name: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const manager = this.getManager(serviceRegistry);
    if (!manager) return this.createError('MCP server management not available');

    const servers = name ? [name] : manager.getConfiguredServers();
    let output = '## MCP Tools\n\n';
    let totalTools = 0;

    for (const serverName of servers) {
      const status = manager.getServerStatus(serverName);
      if (status.status !== MCPServerStatus.CONNECTED) {
        output += `**${serverName}** — not connected\n\n`;
        continue;
      }

      const tools = manager.getDiscoveredTools(serverName);
      if (tools.length === 0) {
        output += `**${serverName}** — no tools\n\n`;
        continue;
      }

      output += `**${serverName}** (${tools.length} tools)\n\n`;
      output += '| Tool | Description |\n';
      output += '|------|-------------|\n';

      for (const tool of tools) {
        output += `| ${tool.name} | ${tool.description} |\n`;
        totalTools++;
      }
      output += '\n';
    }

    if (totalTools === 0 && !name) {
      output += 'No tools discovered. Start a server with `/mcp start <name>` first.\n';
    }

    return { handled: true, response: output };
  }

  /**
   * Helper to unregister all tools for a given MCP server
   */
  private unregisterServerTools(
    manager: MCPServerManager,
    serverName: string,
    serviceRegistry: ServiceRegistry
  ): void {
    const tools = manager.getDiscoveredTools(serverName);
    const toolManager = serviceRegistry.get<ToolManagerService>('tool_manager');
    if (toolManager && tools.length > 0) {
      for (const tool of tools) {
        const toolName = `mcp-${toKebabCase(serverName)}-${toKebabCase(tool.name)}`;
        toolManager.unregisterTool(toolName);
      }
    }
  }

  private registerMcpSource(serverName: string, serviceRegistry: ServiceRegistry): void {
    try {
      const activation = serviceRegistry.getPluginActivationManager();
      activation.registerExternalSource(`mcp:${serverName}`);
    } catch { /* PluginActivationManager not registered — non-critical */ }
  }

  private unregisterMcpSource(serverName: string, serviceRegistry: ServiceRegistry): void {
    try {
      const activation = serviceRegistry.getPluginActivationManager();
      activation.unregisterExternalSource(`mcp:${serverName}`);
    } catch { /* PluginActivationManager not registered — non-critical */ }
  }

  private statusIcon(status: MCPServerStatus): string {
    switch (status) {
      case MCPServerStatus.CONNECTED: return '●';
      case MCPServerStatus.CONNECTING: return '◐';
      case MCPServerStatus.ERROR: return '✗';
      case MCPServerStatus.DISCONNECTED: return '○';
    }
  }

  private showHelp(): CommandResult {
    const meta = MCPCommand.metadata;
    const lines = meta.subcommands!.map(sub => {
      const cmd = sub.args
        ? `${meta.name} ${sub.name} ${sub.args}`
        : `${meta.name} ${sub.name}`;
      return `\`${cmd}\`  ${sub.description}`;
    });

    return {
      handled: true,
      response: `**${meta.description}**\n${lines.join('\n')}`,
    };
  }
}
