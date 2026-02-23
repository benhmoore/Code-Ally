/**
 * MCPServerManager - Core lifecycle manager for MCP servers
 *
 * Singleton service implementing IService for automatic cleanup.
 * Manages MCP server connections, tool discovery, and tool execution
 * using the official MCP SDK.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '@services/Logger.js';
import { getMCPConfigFile } from '@config/paths.js';
import type { IService } from '@shared/index.js';
import type { ActivityStream } from '@services/ActivityStream.js';
import type { MCPConfig, MCPServerConfig } from './MCPConfig.js';
import { applyConfigDefaults } from './MCPConfig.js';
import { MCPError } from './MCPError.js';
import { MCPServerStatus } from './types.js';
import type { MCPToolDefinition, MCPToolResult, MCPServerStatusInfo } from './types.js';
import { MCPToolFactory } from './MCPToolFactory.js';
import type { BaseTool } from '@tools/BaseTool.js';

const CONNECTION_TIMEOUT_MS = 30_000;

export class MCPServerManager implements IService {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport | SSEClientTransport> = new Map();
  private statuses: Map<string, MCPServerStatusInfo> = new Map();
  private discoveredTools: Map<string, MCPToolDefinition[]> = new Map();
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private activityStream: ActivityStream;

  constructor(activityStream: ActivityStream) {
    this.activityStream = activityStream;
  }

  async initialize(): Promise<void> {
    // No-op — loadConfig() and startAutoStartServers() are called explicitly from cli.ts
  }

  async cleanup(): Promise<void> {
    await this.stopAllServers();
  }

  /**
   * Load MCP configuration from profile-level and optional project-level files.
   * Project config overrides profile config for same-named servers.
   */
  async loadConfig(projectDir?: string): Promise<void> {
    const profileConfig = await this.readConfigFile(getMCPConfigFile());
    let projectConfig: MCPConfig | null = null;

    if (projectDir) {
      const projectConfigPath = join(projectDir, '.ally', 'mcp-config.json');
      projectConfig = await this.readConfigFile(projectConfigPath);
    }

    // Merge: project overrides profile for same-named servers
    const merged: Record<string, MCPServerConfig> = {
      ...(profileConfig?.servers ?? {}),
      ...(projectConfig?.servers ?? {}),
    };

    this.serverConfigs.clear();
    for (const [name, config] of Object.entries(merged)) {
      this.serverConfigs.set(name, config);
    }

    const count = this.serverConfigs.size;
    if (count > 0) {
      logger.debug(`[MCP] Loaded ${count} server config(s)`);
    }
  }

  /**
   * Start all servers that have autoStart: true and are enabled.
   * Returns all discovered MCP tools as BaseTool instances.
   */
  async startAutoStartServers(): Promise<BaseTool[]> {
    const allTools: BaseTool[] = [];

    for (const [name, rawConfig] of this.serverConfigs.entries()) {
      const config = applyConfigDefaults(rawConfig);
      if (!config.enabled || !config.autoStart) continue;

      try {
        const tools = await this.startServer(name);
        allTools.push(...tools);
      } catch (error) {
        logger.error(`[MCP] Failed to auto-start server '${name}':`, error);
        // Continue with other servers — don't let one failure block startup
      }
    }

    return allTools;
  }

  /**
   * Start a server by name: create transport, connect, discover tools.
   * Returns BaseTool instances for all discovered tools.
   */
  async startServer(name: string): Promise<BaseTool[]> {
    const rawConfig = this.serverConfigs.get(name);
    if (!rawConfig) {
      throw new MCPError('SERVER_NOT_FOUND', `No configuration found for server '${name}'`, name);
    }

    const config = applyConfigDefaults(rawConfig);
    if (this.clients.has(name)) {
      throw new MCPError('ALREADY_CONNECTED', `Server '${name}' is already connected`, name);
    }

    this.statuses.set(name, { status: MCPServerStatus.CONNECTING });

    try {
      const transport = this.createTransport(name, config);
      this.transports.set(name, transport);

      const client = new Client(
        { name: 'code-ally', version: '0.3.0' },
        { capabilities: {} }
      );

      // Connect with timeout
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new MCPError('TIMEOUT', `Connection to '${name}' timed out after ${CONNECTION_TIMEOUT_MS}ms`, name)), CONNECTION_TIMEOUT_MS)
        ),
      ]);

      this.clients.set(name, client);

      // Discover tools
      const toolsResult = await client.request(
        { method: 'tools/list' },
        ListToolsResultSchema
      );

      const definitions: MCPToolDefinition[] = (toolsResult.tools ?? []).map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, any>) ?? {},
      }));

      this.discoveredTools.set(name, definitions);
      this.statuses.set(name, {
        status: MCPServerStatus.CONNECTED,
        toolCount: definitions.length,
      });

      logger.debug(`[MCP] Server '${name}' connected with ${definitions.length} tool(s)`);

      // Create BaseTool wrappers
      return MCPToolFactory.createTools(
        name,
        definitions,
        config.requiresConfirmation,
        this,
        this.activityStream
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statuses.set(name, { status: MCPServerStatus.ERROR, error: message });

      // Clean up partial connection
      await this.cleanupServer(name);

      if (error instanceof MCPError) throw error;
      throw new MCPError('CONNECTION_FAILED', `Failed to connect to '${name}': ${message}`, name);
    }
  }

  /**
   * Stop a server and clean up resources
   */
  async stopServer(name: string): Promise<void> {
    if (!this.serverConfigs.has(name)) {
      throw new MCPError('SERVER_NOT_FOUND', `No configuration found for server '${name}'`, name);
    }

    await this.cleanupServer(name);
    this.statuses.set(name, { status: MCPServerStatus.DISCONNECTED });
    logger.debug(`[MCP] Server '${name}' stopped`);
  }

  /**
   * Ensure a server is connected (lazy start on first tool call)
   */
  async ensureConnected(name: string): Promise<void> {
    if (this.clients.has(name)) return;
    await this.startServer(name);
  }

  /**
   * Call a tool on a connected server
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new MCPError('SERVER_NOT_FOUND', `Server '${serverName}' is not connected`, serverName);
    }

    try {
      const result = await client.request(
        {
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        },
        CallToolResultSchema
      );

      return {
        content: (result.content ?? []) as MCPToolResult['content'],
        isError: result.isError ?? false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MCPError('TOOL_CALL_FAILED', `Tool '${toolName}' on '${serverName}' failed: ${message}`, serverName);
    }
  }

  /**
   * Get the names of all discovered tools for a server
   */
  getDiscoveredTools(serverName: string): MCPToolDefinition[] {
    return this.discoveredTools.get(serverName) ?? [];
  }

  /**
   * Get status info for a specific server
   */
  getServerStatus(name: string): MCPServerStatusInfo {
    return this.statuses.get(name) ?? { status: MCPServerStatus.DISCONNECTED };
  }

  /**
   * Get all configured server names
   */
  getConfiguredServers(): string[] {
    return Array.from(this.serverConfigs.keys());
  }

  getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Get the config for a specific server
   */
  getServerConfig(name: string): MCPServerConfig | undefined {
    return this.serverConfigs.get(name);
  }

  /**
   * Add or update a server configuration and save to profile config
   */
  async addServerConfig(name: string, config: MCPServerConfig): Promise<void> {
    this.serverConfigs.set(name, config);
    await this.saveProfileConfig();
  }

  /**
   * Remove a server configuration and save to profile config
   */
  async removeServerConfig(name: string): Promise<void> {
    if (this.clients.has(name)) {
      await this.stopServer(name);
    }
    this.serverConfigs.delete(name);
    this.statuses.delete(name);
    this.discoveredTools.delete(name);
    await this.saveProfileConfig();
  }

  // ===========================
  // Private helpers
  // ===========================

  private createTransport(name: string, config: MCPServerConfig): StdioClientTransport | SSEClientTransport {
    if (config.transport === 'stdio') {
      if (!config.command) {
        throw new MCPError('TRANSPORT_ERROR', `Server '${name}' has transport 'stdio' but no command specified`, name);
      }
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
        stderr: 'pipe',
      });

      // Forward piped stderr to logger instead of inheriting to terminal
      const stderrStream = transport.stderr;
      if (stderrStream) {
        stderrStream.on('data', (chunk: Buffer) => {
          const line = chunk.toString().trimEnd();
          if (line) logger.debug(`[MCP:${name}] ${line}`);
        });
      }

      return transport;
    }

    if (config.transport === 'sse') {
      if (!config.url) {
        throw new MCPError('TRANSPORT_ERROR', `Server '${name}' has transport 'sse' but no url specified`, name);
      }
      return new SSEClientTransport(new URL(config.url));
    }

    throw new MCPError('TRANSPORT_ERROR', `Unknown transport type for server '${name}'`, name);
  }

  private async cleanupServer(name: string): Promise<void> {
    const transport = this.transports.get(name);
    if (transport) {
      try {
        await transport.close();
      } catch (error) {
        logger.warn(`[MCP] Error closing transport for '${name}':`, error);
      }
      this.transports.delete(name);
    }

    this.clients.delete(name);
    this.discoveredTools.delete(name);
  }

  private async stopAllServers(): Promise<void> {
    const names = Array.from(this.clients.keys());
    await Promise.allSettled(
      names.map(name => this.stopServer(name))
    );
  }

  private async readConfigFile(path: string): Promise<MCPConfig | null> {
    try {
      const content = await fs.readFile(path, 'utf-8');
      return JSON.parse(content) as MCPConfig;
    } catch {
      return null;
    }
  }

  private async saveProfileConfig(): Promise<void> {
    const configPath = getMCPConfigFile();
    const config: MCPConfig = {
      servers: Object.fromEntries(this.serverConfigs),
    };
    try {
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
      logger.error(`[MCP] Failed to save config to ${configPath}:`, error);
    }
  }
}
