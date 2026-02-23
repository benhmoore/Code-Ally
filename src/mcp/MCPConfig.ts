/**
 * MCP server configuration model
 *
 * Format matches Task Ally for cross-app portability.
 * Configuration is loaded from profile-level and project-level files,
 * with project config overriding profile config for same-named servers.
 */

export interface MCPConfig {
  servers: Record<string, MCPServerConfig>;
}

export interface MCPServerConfig {
  /** Transport type: stdio for local processes, sse for remote servers */
  transport: 'stdio' | 'sse';
  /** Command to execute (stdio only) */
  command?: string;
  /** Command arguments (stdio only) */
  args?: string[];
  /** Environment variables for the process (stdio only) */
  env?: Record<string, string>;
  /** Server URL (sse only) */
  url?: string;
  /** HTTP headers (sse only) */
  headers?: Record<string, string>;
  /** Whether this server is enabled (default: true) */
  enabled?: boolean;
  /** Whether tool calls require user confirmation (default: true) */
  requiresConfirmation?: boolean;
  /** Whether to auto-start on session init (default: false) */
  autoStart?: boolean;
}

/**
 * Apply defaults to a server config
 */
export function applyConfigDefaults(config: MCPServerConfig): Required<Pick<MCPServerConfig, 'enabled' | 'requiresConfirmation' | 'autoStart'>> & MCPServerConfig {
  return {
    ...config,
    enabled: config.enabled ?? true,
    requiresConfirmation: config.requiresConfirmation ?? true,
    autoStart: config.autoStart ?? false,
  };
}
