/**
 * Tests for MCPToolFactory
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPToolFactory } from '@mcp/MCPToolFactory.js';
import { MCPTool } from '@mcp/MCPTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import type { MCPServerManager } from '@mcp/MCPServerManager.js';
import type { MCPToolDefinition } from '@mcp/types.js';

describe('MCPToolFactory', () => {
  let activityStream: ActivityStream;
  let mockManager: MCPServerManager;

  beforeEach(() => {
    activityStream = new ActivityStream();
    mockManager = {
      ensureConnected: vi.fn(),
      callTool: vi.fn(),
    } as unknown as MCPServerManager;
  });

  it('creates MCPTool instances from definitions', () => {
    const definitions: MCPToolDefinition[] = [
      { name: 'read', description: 'Read a file', inputSchema: {} },
      { name: 'write', description: 'Write a file', inputSchema: {} },
    ];

    const tools = MCPToolFactory.createTools('fs', definitions, true, mockManager, activityStream);

    expect(tools).toHaveLength(2);
    expect(tools[0]).toBeInstanceOf(MCPTool);
    expect(tools[1]).toBeInstanceOf(MCPTool);
    expect(tools[0]!.name).toBe('mcp-fs-read');
    expect(tools[1]!.name).toBe('mcp-fs-write');
  });

  it('returns empty array for no definitions', () => {
    const tools = MCPToolFactory.createTools('fs', [], true, mockManager, activityStream);
    expect(tools).toHaveLength(0);
  });

  it('passes requiresConfirmation to all tools', () => {
    const definitions: MCPToolDefinition[] = [
      { name: 'read', description: 'Read', inputSchema: {} },
    ];

    const confirming = MCPToolFactory.createTools('fs', definitions, true, mockManager, activityStream);
    expect(confirming[0]!.requiresConfirmation).toBe(true);

    const nonConfirming = MCPToolFactory.createTools('fs', definitions, false, mockManager, activityStream);
    expect(nonConfirming[0]!.requiresConfirmation).toBe(false);
  });
});
