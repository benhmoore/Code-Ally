/**
 * Tests for ToolManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolManager } from '../../tools/ToolManager.js';
import { BaseTool } from '../../tools/BaseTool.js';
import { ToolResult } from '../../types/index.js';
import { ActivityStream } from '../../services/ActivityStream.js';

// Mock tool implementation
class TestTool extends BaseTool {
  readonly name = 'test_tool';
  readonly description = 'A test tool';
  readonly requiresConfirmation = false;

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

describe('ToolManager', () => {
  let activityStream: ActivityStream;
  let tool: TestTool;
  let toolManager: ToolManager;

  beforeEach(() => {
    activityStream = new ActivityStream();
    tool = new TestTool(activityStream);
    toolManager = new ToolManager([tool], activityStream);
  });

  describe('getTool', () => {
    it('should retrieve registered tool by name', () => {
      const retrieved = toolManager.getTool('test_tool');
      expect(retrieved).toBe(tool);
    });

    it('should return undefined for unknown tool', () => {
      const retrieved = toolManager.getTool('unknown_tool');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getAllTools', () => {
    it('should return all registered tools', () => {
      const tools = toolManager.getAllTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]).toBe(tool);
    });
  });

  describe('getFunctionDefinitions', () => {
    it('should generate function definitions for all tools', () => {
      const defs = toolManager.getFunctionDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].type).toBe('function');
      expect(defs[0].function.name).toBe('test_tool');
      expect(defs[0].function.description).toBe('A test tool');
    });
  });

  describe('executeTool', () => {
    it('should execute tool with valid arguments', async () => {
      const result = await toolManager.executeTool('test_tool', {
        required_param: 'test_value',
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
      // First call
      await toolManager.executeTool('test_tool', { required_param: 'test' });

      // Second identical call in same turn
      const result = await toolManager.executeTool('test_tool', {
        required_param: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Redundant tool call');
    });

    it('should allow same call after clearing turn', async () => {
      // First call
      await toolManager.executeTool('test_tool', { required_param: 'test' });

      // Clear turn
      toolManager.clearCurrentTurn();

      // Second identical call after clearing
      const result = await toolManager.executeTool('test_tool', {
        required_param: 'test',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('file tracking', () => {
    it('should track read files', async () => {
      // Simulate read tool call
      await toolManager.executeTool('read', {
        file_paths: ['test.txt'],
      });

      expect(toolManager.hasFileBeenRead('test.txt')).toBe(true);
    });

    it('should track write files', async () => {
      // Simulate write tool call
      await toolManager.executeTool('write', {
        file_path: 'output.txt',
        content: 'test',
      });

      expect(toolManager.hasFileBeenRead('output.txt')).toBe(true);
    });

    it('should return timestamp for read files', async () => {
      await toolManager.executeTool('read', {
        file_paths: ['test.txt'],
      });

      const timestamp = toolManager.getFileReadTimestamp('test.txt');
      expect(timestamp).toBeDefined();
      expect(typeof timestamp).toBe('number');
    });
  });

  describe('clearState', () => {
    it('should clear all tracked state', async () => {
      // Execute some tool calls
      await toolManager.executeTool('test_tool', { required_param: 'test1' });
      await toolManager.executeTool('test_tool', { required_param: 'test2' });

      // Clear state
      toolManager.clearState();

      // Should allow previously redundant calls
      const result = await toolManager.executeTool('test_tool', {
        required_param: 'test1',
      });
      expect(result.success).toBe(true);
    });
  });
});
