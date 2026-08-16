/**
 * Tests for BaseTool
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BaseTool } from '@tools/BaseTool.js';
import { ToolResult, ActivityEvent, ActivityEventType, FunctionDefinition } from '@shared/index.js';
import { ActivityStream } from '@services/ActivityStream.js';

// Mock tool implementation
class MockTool extends BaseTool {
  readonly name = 'mock-tool';
  readonly description = 'A mock tool for testing';
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
            data: { type: 'string', description: 'Arbitrary payload echoed back' },
            shouldFail: { type: 'boolean', description: 'Force the mock to fail' },
            param1: { type: 'string', description: 'First captured parameter' },
            param2: { type: 'string', description: 'Second captured parameter' },
            param3: { type: 'string', description: 'Third captured parameter' },
            param4: { type: 'string', description: 'Fourth captured parameter' },
          },
        },
      },
    };
  }

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
  readonly capabilities = [] as const;

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
    this.emitOutputChunk('streamed output');
    return this.formatSuccessResponse({ result: 'ok' });
  }
}

class ConcurrentTool extends BaseTool {
  readonly name = 'concurrent-tool';
  readonly description = 'Exercises overlapping invocations';
  readonly capabilities = [] as const;
  private started = 0;
  private release!: () => void;
  private readonly bothStarted = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Identifies the invocation' },
          },
          required: ['label'],
        },
      },
    };
  }

  protected async executeImpl(args: { label: string }): Promise<ToolResult> {
    this.captureParams(args);
    this.started += 1;
    if (this.started === 2) this.release();
    await this.bothStarted;
    this.emitOutputChunk(args.label);
    return this.formatErrorResponse(`failed-${args.label}`, 'user_error');
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
    it('keeps call IDs, streams, and error parameters isolated across overlapping calls', async () => {
      const rootStream = new ActivityStream();
      const firstStream = rootStream.createScoped('first');
      const secondStream = rootStream.createScoped('second');
      const firstEvents: ActivityEvent[] = [];
      const secondEvents: ActivityEvent[] = [];
      firstStream.subscribe('*', (event) => firstEvents.push(event));
      secondStream.subscribe('*', (event) => secondEvents.push(event));
      const concurrentTool = new ConcurrentTool(rootStream);

      const [first, second] = await Promise.all([
        concurrentTool.execute({ label: 'first' }, 'call-first', undefined, false, false, {
          activityStream: firstStream,
        }),
        concurrentTool.execute({ label: 'second' }, 'call-second', undefined, false, false, {
          activityStream: secondStream,
        }),
      ]);

      expect(first.error_details?.parameters).toEqual({ label: 'first' });
      expect(second.error_details?.parameters).toEqual({ label: 'second' });
      expect(firstEvents.map((event) => event.id)).toContain('call-first');
      expect(firstEvents.map((event) => event.id)).not.toContain('call-second');
      expect(secondEvents.map((event) => event.id)).toContain('call-second');
      expect(secondEvents.map((event) => event.id)).not.toContain('call-first');
    });

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
