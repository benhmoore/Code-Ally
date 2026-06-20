/**
 * Tests for BaseTool
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BaseTool } from '@tools/BaseTool.js';
import { ToolResult, ActivityEvent, ActivityEventType } from '@shared/index.js';
import { ActivityStream } from '@services/ActivityStream.js';

// Mock tool implementation
class MockTool extends BaseTool {
  readonly name = 'mock-tool';
  readonly description = 'A mock tool for testing';
  readonly requiresConfirmation = false;

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    if (args.shouldFail) {
      return this.formatErrorResponse('Mock error', 'user_error', 'Try again');
    }

    return this.formatSuccessResponse({
      result: 'success',
      data: args.data || 'test',
    });
  }
}

// Tool that streams output, to exercise event routing during execution
class EmittingTool extends BaseTool {
  readonly name = 'emitting-tool';
  readonly description = 'A tool that emits an output chunk';
  readonly requiresConfirmation = false;

  protected async executeImpl(): Promise<ToolResult> {
    this.emitOutputChunk('streamed output');
    return this.formatSuccessResponse({ result: 'ok' });
  }
}

describe('BaseTool', () => {
  let activityStream: ActivityStream;
  let tool: MockTool;
  let emittedEvents: ActivityEvent[];

  beforeEach(() => {
    activityStream = new ActivityStream();
    tool = new MockTool(activityStream);
    emittedEvents = [];

    // Subscribe to all events
    activityStream.subscribe('*', (event) => {
      emittedEvents.push(event);
    });
  });

  describe('execute', () => {
    it('should execute successfully', async () => {
      const result = await tool.execute({ data: 'test' });
      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
    });

    it('should handle errors', async () => {
      const result = await tool.execute({ shouldFail: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Mock error');
    });
  });

  describe('activity stream isolation', () => {
    it('routes emitted events to the execution context stream, not the construction stream', async () => {
      // Tools are shared singletons constructed with the root stream. A sub-agent
      // supplies its scoped stream via the execution context; the tool's output
      // must follow it so a sub-agent's activity never leaks to the root stream.
      const rootStream = new ActivityStream();
      const scopedStream = rootStream.createScoped('agent-1');
      const rootEvents: ActivityEvent[] = [];
      const scopedEvents: ActivityEvent[] = [];
      rootStream.subscribe('*', (e) => rootEvents.push(e));
      scopedStream.subscribe('*', (e) => scopedEvents.push(e));

      const emittingTool = new EmittingTool(rootStream);
      await emittingTool.execute({}, 'call-1', undefined, false, false, {
        activityStream: scopedStream,
      });

      const isOutput = (e: ActivityEvent) => e.type === ActivityEventType.TOOL_OUTPUT_CHUNK;
      expect(scopedEvents.some(isOutput)).toBe(true);
      expect(rootEvents.some(isOutput)).toBe(false);
    });

    it('falls back to the construction stream when no execution context is provided', async () => {
      const rootStream = new ActivityStream();
      const rootEvents: ActivityEvent[] = [];
      rootStream.subscribe('*', (e) => rootEvents.push(e));

      const emittingTool = new EmittingTool(rootStream);
      await emittingTool.execute({}, 'call-1');

      expect(rootEvents.some((e) => e.type === ActivityEventType.TOOL_OUTPUT_CHUNK)).toBe(true);
    });
  });

  describe('formatErrorResponse', () => {
    it('should format error with tool name', async () => {
      await tool.execute({ shouldFail: true });

      const result = await tool.execute({ shouldFail: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain('mock-tool');
      expect(result.error).toContain('Mock error');
    });

    it('should include suggestion if provided', async () => {
      const result = await tool.execute({ shouldFail: true });
      expect(result.suggestion).toBe('Try again');
    });

    it('should include error type', async () => {
      const result = await tool.execute({ shouldFail: true });
      expect(result.error_type).toBe('user_error');
    });
  });

  describe('formatSuccessResponse', () => {
    it('should format success response', async () => {
      const result = await tool.execute({ data: 'test' });
      expect(result.success).toBe(true);
      expect(result.error).toBe('');
      expect(result.result).toBe('success');
      expect(result.data).toBe('test');
    });
  });

  describe('getResultPreview', () => {
    it('should return error preview for failed results', () => {
      const result: ToolResult = {
        success: false,
        error: 'Test error',
        suggestion: 'Try this',
      };

      const preview = tool.getResultPreview(result);
      expect(preview).toContain('Error: Test error');
      expect(preview).toContain('Suggestion: Try this');
    });

    it('should return content preview for successful results', () => {
      const result: ToolResult = {
        success: true,
        error: '',
        content: 'Line 1\nLine 2\nLine 3\nLine 4',
      };

      const preview = tool.getResultPreview(result, 3);
      expect(preview).toHaveLength(4); // 3 lines + "..."
      expect(preview[0]).toBe('Line 1');
      expect(preview[3]).toBe('...');
    });

    it('should skip internal-only results', () => {
      const result: ToolResult = {
        success: true,
        error: '',
        _internal_only: true,
        data: 'hidden',
      };

      const preview = tool.getResultPreview(result);
      expect(preview).toHaveLength(0);
    });
  });

  describe('captureParams', () => {
    it('should filter out undefined and null values', async () => {
      const result = await tool.execute({
        param1: 'value1',
        param2: undefined,
        param3: null,
        param4: 'value4',
        shouldFail: true,
      });

      // Check that error message includes defined params but not undefined/null
      expect(result.error).toContain('param1');
      expect(result.error).toContain('param4');
      expect(result.error).not.toContain('param2');
      expect(result.error).not.toContain('param3');
    });
  });
});
