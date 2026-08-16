/**
 * Tests for ToolManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolManager } from '@tools/ToolManager.js';
import { BaseTool } from '@tools/BaseTool.js';
import { ToolResult, FunctionDefinition } from '@shared/index.js';
import { ActivityStream } from '@services/ActivityStream.js';

class TestTool extends BaseTool {
  readonly name = 'test-tool';
  readonly description = 'A test tool';
  readonly capabilities = [] as const;

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            required_param: { type: 'string', description: 'The value echoed back' },
          },
          required: ['required_param'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    if (!args.required_param) {
      return this.formatErrorResponse(
        'required_param is required',
        'validation_error'
      );
    }

    return this.formatSuccessResponse({
      result: args.required_param,
    });
  }
}

class ReadTool extends BaseTool {
  readonly name = 'read';
  readonly description = 'Read files';
  readonly capabilities = [] as const;

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            file_paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Paths the mock pretends to read',
            },
          },
          required: ['file_paths'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    return this.formatSuccessResponse({
      content: 'file content',
      files_read: args.file_paths?.length || 0,
    });
  }
}

class WriteTool extends BaseTool {
  readonly name = 'write';
  readonly description = 'Write files';
  readonly capabilities = [] as const;

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Path the mock pretends to write' },
          },
          required: ['file_path'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    return this.formatSuccessResponse({
      file_path: args.file_path,
    });
  }
}

describe('ToolManager', () => {
  let activityStream: ActivityStream;
  let tool: TestTool;
  let readTool: ReadTool;
  let writeTool: WriteTool;
  let toolManager: ToolManager;

  beforeEach(() => {
    activityStream = new ActivityStream();
    tool = new TestTool(activityStream);
    readTool = new ReadTool(activityStream);
    writeTool = new WriteTool(activityStream);
    toolManager = new ToolManager([tool, readTool, writeTool]);
  });

  describe('getTool', () => {
    it('should retrieve registered tool by name', () => {
      const retrieved = toolManager.getTool('test-tool');
      expect(retrieved).toBe(tool);
    });

    it('should return undefined for unknown tool', () => {
      const retrieved = toolManager.getTool('unknown-tool');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getAllTools', () => {
    it('should return all registered tools', () => {
      const tools = toolManager.getAllTools();
      expect(tools).toHaveLength(3);
      expect(tools).toContain(tool);
      expect(tools).toContain(readTool);
      expect(tools).toContain(writeTool);
    });
  });

  describe('getFunctionDefinitions', () => {
    it('should generate function definitions for all tools', () => {
      const defs = toolManager.getFunctionDefinitions();
      expect(defs).toHaveLength(3);
      expect(defs[0].type).toBe('function');
      expect(defs[0].function.name).toBe('test-tool');
      expect(defs[0].function.description).toBe('A test tool');
    });
  });

  describe('executeTool', () => {
    it('should execute tool with valid arguments', async () => {
      const result = await toolManager.executeTool('test-tool', {
        required_param: 'test_value',
        description: 'Test execution',
      });

      expect(result.success).toBe(true);
      expect(result.result).toBe('test_value');
    });

    it('should return error for unknown tool', async () => {
      const result = await toolManager.executeTool('unknown_tool', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
      expect(result.error_type).toBe('validation_error');
    });

    it('should detect redundant calls in same turn', async () => {
      await toolManager.executeTool('read', { file_paths: ['test.txt'], description: 'Read test file' });

      const result = await toolManager.executeTool('read', {
        file_paths: ['test.txt'],
        description: 'Read test file',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Redundant tool call');
    });

    it('should allow same call after clearing turn with warning', async () => {
      await toolManager.executeTool('read', { file_paths: ['test.txt'], description: 'Read test file' });

      toolManager.clearCurrentTurn();

      const result = await toolManager.executeTool('read', {
        file_paths: ['test.txt'],
        description: 'Read test file',
      });

      expect(result.success).toBe(true);
      expect(result.warning).toContain('previously made');
    });

    it('should include turn information in cross-turn warnings', async () => {
      await toolManager.executeTool('read', { file_paths: ['data.json'], description: 'Read data file' });

      toolManager.clearCurrentTurn();

      const result = await toolManager.executeTool('read', {
        file_paths: ['data.json'],
        description: 'Read data file',
      });

      expect(result.success).toBe(true);
      expect(result.warning).toContain('turn 0');
      expect(result.warning).toContain('1 turn ago');
    });
  });

  describe('mainAgentOnly tools', () => {
    class MainOnlyTool extends BaseTool {
      readonly name = 'main-only';
      readonly description = 'Main agent only';
      readonly capabilities = [] as const;
      readonly mainAgentOnly = true;
      getFunctionDefinition(): FunctionDefinition {
        return {
          type: 'function',
          function: {
            name: this.name,
            description: this.description,
            parameters: { type: 'object', properties: {} },
          },
        };
      }
      protected async executeImpl(): Promise<ToolResult> {
        return this.formatSuccessResponse({ ok: true });
      }
    }

    let mainOnlyManager: ToolManager;

    beforeEach(() => {
      mainOnlyManager = new ToolManager([new MainOnlyTool(activityStream), readTool]);
    });

    it('reports main-agent-only tool names for the Agent to exclude', () => {
      expect(mainOnlyManager.getMainAgentOnlyToolNames()).toEqual(['main-only']);
    });

    it('is NOT filtered by agent name (the main agent is itself named, e.g. "ally")', () => {
      // Restriction is enforced at the Agent boundary via excludeTools, not by name here.
      const asAlly = mainOnlyManager.getFunctionDefinitions(undefined, 'ally').map(d => d.function.name);
      expect(asAlly).toContain('main-only');
    });

    it('is hidden once excluded (the delegated-agent path)', () => {
      const excluded = mainOnlyManager.getMainAgentOnlyToolNames();
      const names = mainOnlyManager.getFunctionDefinitions(excluded, 'explore').map(d => d.function.name);
      expect(names).not.toContain('main-only');
      expect(names).toContain('read'); // unrelated tools still visible
    });
  });

  describe('clearState', () => {
    it('should clear all tracked state', async () => {
      // Execute some tool calls
      await toolManager.executeTool('test-tool', { required_param: 'test1', description: 'Test 1' });
      await toolManager.executeTool('test-tool', { required_param: 'test2', description: 'Test 2' });

      // Clear state
      toolManager.clearState();

      // Should allow previously redundant calls
      const result = await toolManager.executeTool('test-tool', {
        required_param: 'test1',
        description: 'Test 1',
      });
      expect(result.success).toBe(true);
    });
  });
});
