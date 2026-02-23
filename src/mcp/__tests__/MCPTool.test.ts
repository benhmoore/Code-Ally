/**
 * Tests for MCPTool - schema conversion and naming
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPTool } from '@mcp/MCPTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import type { MCPServerManager } from '@mcp/MCPServerManager.js';
import type { MCPToolDefinition } from '@mcp/types.js';

describe('MCPTool', () => {
  let activityStream: ActivityStream;
  let mockManager: MCPServerManager;

  beforeEach(() => {
    activityStream = new ActivityStream();
    mockManager = {
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }),
    } as unknown as MCPServerManager;
  });

  describe('naming', () => {
    it('generates correct kebab-case tool name', () => {
      const tool = createTool('filesystem', { name: 'readFile', description: 'Read a file', inputSchema: {} });
      expect(tool.name).toBe('mcp-filesystem-read-file');
    });

    it('handles snake_case tool names', () => {
      const tool = createTool('my_server', { name: 'list_files', description: 'List files', inputSchema: {} });
      expect(tool.name).toBe('mcp-my-server-list-files');
    });

    it('sets pluginName with mcp: prefix', () => {
      const tool = createTool('github', { name: 'search', description: 'Search', inputSchema: {} });
      expect(tool.pluginName).toBe('mcp:github');
    });

    it('generates human-readable displayName', () => {
      const tool = createTool('filesystem', { name: 'read-file', description: 'Read a file', inputSchema: {} });
      expect(tool.displayName).toBe('Filesystem / Read File');
    });
  });

  describe('getFunctionDefinition', () => {
    it('returns valid function definition with empty schema', () => {
      const tool = createTool('test', { name: 'simple', description: 'A simple tool', inputSchema: {} });
      const def = tool.getFunctionDefinition();

      expect(def.type).toBe('function');
      expect(def.function.name).toBe('mcp-test-simple');
      expect(def.function.description).toBe('A simple tool');
      expect(def.function.parameters.type).toBe('object');
      expect(def.function.parameters.properties).toEqual({});
    });

    it('converts string properties', () => {
      const tool = createTool('test', {
        name: 'tool',
        description: 'Test',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
          },
          required: ['path'],
        },
      });

      const def = tool.getFunctionDefinition();
      expect(def.function.parameters.properties['path']).toEqual({
        type: 'string',
        description: 'File path',
      });
      expect(def.function.parameters.required).toEqual(['path']);
    });

    it('converts nested object properties', () => {
      const tool = createTool('test', {
        name: 'tool',
        description: 'Test',
        inputSchema: {
          type: 'object',
          properties: {
            options: {
              type: 'object',
              description: 'Options',
              properties: {
                recursive: { type: 'boolean', description: 'Recurse' },
              },
              required: ['recursive'],
            },
          },
        },
      });

      const def = tool.getFunctionDefinition();
      const options = def.function.parameters.properties['options'];
      expect(options!.type).toBe('object');
      expect(options!.properties!['recursive']).toEqual({
        type: 'boolean',
        description: 'Recurse',
      });
      expect(options!.required).toEqual(['recursive']);
    });

    it('converts array properties with items', () => {
      const tool = createTool('test', {
        name: 'tool',
        description: 'Test',
        inputSchema: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              description: 'File paths',
              items: { type: 'string' },
            },
          },
        },
      });

      const def = tool.getFunctionDefinition();
      const paths = def.function.parameters.properties['paths'];
      expect(paths!.type).toBe('array');
      expect(paths!.items).toEqual({ type: 'string' });
    });

    it('converts enum properties', () => {
      const tool = createTool('test', {
        name: 'tool',
        description: 'Test',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['read', 'write', 'append'],
              description: 'File mode',
            },
          },
        },
      });

      const def = tool.getFunctionDefinition();
      const mode = def.function.parameters.properties['mode'];
      expect(mode!.enum).toEqual(['read', 'write', 'append']);
    });

    it('defaults unknown types to string', () => {
      const tool = createTool('test', {
        name: 'tool',
        description: 'Test',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: 'unknown_type' },
          },
        },
      });

      const def = tool.getFunctionDefinition();
      expect(def.function.parameters.properties['value']!.type).toBe('string');
    });
  });

  describe('executeImpl', () => {
    it('calls server manager with correct tool name and args', async () => {
      const tool = createTool('fs', { name: 'readFile', description: 'Read', inputSchema: {} });

      const result = await tool.execute({ path: '/test.txt', description: 'Reading a file' });

      expect(mockManager.ensureConnected).toHaveBeenCalledWith('fs');
      expect(mockManager.callTool).toHaveBeenCalledWith('fs', 'readFile', { path: '/test.txt' });
      expect(result.success).toBe(true);
    });

    it('strips description meta-parameter', async () => {
      const tool = createTool('fs', { name: 'read', description: 'Read', inputSchema: {} });

      await tool.execute({ path: '/test', description: 'Some description' });

      expect(mockManager.callTool).toHaveBeenCalledWith('fs', 'read', { path: '/test' });
    });

    it('handles error results from MCP server', async () => {
      (mockManager.callTool as any).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'File not found' }],
        isError: true,
      });

      const tool = createTool('fs', { name: 'read', description: 'Read', inputSchema: {} });
      const result = await tool.execute({ path: '/nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });

    it('handles connection errors', async () => {
      (mockManager.ensureConnected as any).mockRejectedValueOnce(new Error('Connection refused'));

      const tool = createTool('fs', { name: 'read', description: 'Read', inputSchema: {} });
      const result = await tool.execute({ path: '/test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    });
  });

  function createTool(serverName: string, def: MCPToolDefinition): MCPTool {
    return new MCPTool(serverName, def, true, mockManager, activityStream);
  }
});
