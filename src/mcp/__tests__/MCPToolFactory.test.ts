/**
 * Tests for MCPToolFactory
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPToolFactory } from '@mcp/MCPToolFactory.js';
import { MCPTool } from '@mcp/MCPTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import type { MCPServerManager } from '@mcp/MCPServerManager.js';
import type { MCPToolDefinition } from '@mcp/types.js';
import { ToolCapability } from '@tools/ToolCapability.js';

const CONFIRMING = [ToolCapability.Network, ToolCapability.RemoteEffect] as const;
const NON_CONFIRMING = [ToolCapability.Network] as const;

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

    const tools = MCPToolFactory.createTools('fs', definitions, CONFIRMING, mockManager, activityStream);

    expect(tools).toHaveLength(2);
    expect(tools[0]).toBeInstanceOf(MCPTool);
    expect(tools[1]).toBeInstanceOf(MCPTool);
    expect(tools[0]!.name).toBe('mcp-fs-read');
    expect(tools[1]!.name).toBe('mcp-fs-write');
  });

  it('returns empty array for no definitions', () => {
    const tools = MCPToolFactory.createTools('fs', [], CONFIRMING, mockManager, activityStream);
    expect(tools).toHaveLength(0);
  });

  it('passes the server capabilities through to every tool', () => {
    const definitions: MCPToolDefinition[] = [
      { name: 'read', description: 'Read', inputSchema: {} },
      { name: 'write', description: 'Write', inputSchema: {} },
    ];

    const confirming = MCPToolFactory.createTools('fs', definitions, CONFIRMING, mockManager, activityStream);
    expect(confirming).toHaveLength(2);
    for (const tool of confirming) {
      expect(tool.capabilities).toContain(ToolCapability.Network);
      expect(tool.capabilities).toContain(ToolCapability.RemoteEffect);
      expect(tool.requiresConfirmation({})).toBe(true);
    }

    const nonConfirming = MCPToolFactory.createTools('fs', definitions, NON_CONFIRMING, mockManager, activityStream);
    expect(nonConfirming).toHaveLength(2);
    for (const tool of nonConfirming) {
      expect(tool.capabilities).toContain(ToolCapability.Network);
      expect(tool.capabilities).not.toContain(ToolCapability.RemoteEffect);
      expect(tool.requiresConfirmation({})).toBe(false);
    }
  });
});
