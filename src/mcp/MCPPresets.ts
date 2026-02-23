/**
 * Popular MCP server presets for guided setup
 *
 * Shared between SetupWizardView and /mcp add command.
 */

import type { MCPServerConfig } from './MCPConfig.js';

export interface MCPPreset {
  /** Display name shown in wizard */
  displayName: string;
  /** Brief description */
  description: string;
  /** Pre-filled config (user may need to supply a path or env var) */
  config: MCPServerConfig;
  /** If true, prompt user for a directory path (e.g., filesystem root) */
  needsPath?: boolean;
  /** Placeholder hint for path input */
  pathHint?: string;
  /** If true, prompt user for an env var value (e.g., API token) */
  needsEnvKey?: string;
  /** Placeholder hint for env input */
  envHint?: string;
}

export const MCP_PRESETS: Record<string, MCPPreset> = {
  github: {
    displayName: 'GitHub',
    description: 'Manage repos, issues, and PRs — not available as a built-in tool',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      enabled: true,
      requiresConfirmation: false,
      autoStart: false,
    },
    needsEnvKey: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    envHint: 'ghp_...',
  },
  memory: {
    displayName: 'Memory',
    description: 'Persistent key-value store that survives across conversations',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      enabled: true,
      requiresConfirmation: false,
      autoStart: true,
    },
  },
};

/** Ordered list of preset keys for display */
export const MCP_PRESET_ORDER = ['github', 'memory'] as const;

/**
 * Build a finalized MCPServerConfig from a preset, optionally
 * injecting a user-supplied path (appended to args) or env var.
 */
export function buildConfigFromPreset(
  preset: MCPPreset,
  path?: string,
  envValue?: string
): MCPServerConfig {
  const config = { ...preset.config, args: [...(preset.config.args ?? [])] };

  if (preset.needsPath && path) {
    config.args!.push(path);
  }

  if (preset.needsEnvKey && envValue) {
    config.env = { ...config.env, [preset.needsEnvKey]: envValue };
  }

  return config;
}
