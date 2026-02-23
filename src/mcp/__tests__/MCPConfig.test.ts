/**
 * Tests for MCP configuration
 */

import { describe, it, expect } from 'vitest';
import { applyConfigDefaults } from '@mcp/MCPConfig.js';
import type { MCPServerConfig } from '@mcp/MCPConfig.js';

describe('applyConfigDefaults', () => {
  it('applies default values for missing optional fields', () => {
    const config: MCPServerConfig = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
    };

    const result = applyConfigDefaults(config);

    expect(result.enabled).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.autoStart).toBe(false);
  });

  it('preserves explicit values', () => {
    const config: MCPServerConfig = {
      transport: 'stdio',
      command: 'npx',
      enabled: false,
      requiresConfirmation: false,
      autoStart: true,
    };

    const result = applyConfigDefaults(config);

    expect(result.enabled).toBe(false);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.autoStart).toBe(true);
  });

  it('preserves transport-specific fields', () => {
    const stdioConfig: MCPServerConfig = {
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { KEY: 'value' },
    };

    const sseConfig: MCPServerConfig = {
      transport: 'sse',
      url: 'https://example.com/sse',
      headers: { Authorization: 'Bearer token' },
    };

    const stdioResult = applyConfigDefaults(stdioConfig);
    expect(stdioResult.command).toBe('node');
    expect(stdioResult.args).toEqual(['server.js']);
    expect(stdioResult.env).toEqual({ KEY: 'value' });

    const sseResult = applyConfigDefaults(sseConfig);
    expect(sseResult.url).toBe('https://example.com/sse');
    expect(sseResult.headers).toEqual({ Authorization: 'Bearer token' });
  });
});
