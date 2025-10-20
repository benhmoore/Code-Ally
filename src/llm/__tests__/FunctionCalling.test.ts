/**
 * Tests for FunctionCalling utilities
 */

import { describe, it, expect } from 'vitest';
import {
  convertToolSchemaToFunctionDefinition,
  parseToolCallArguments,
  validateFunctionArguments,
  extractToolCallData,
  createToolResultMessage,
  hasToolCalls,
  isValidToolCall,
  sanitizeToolCallArguments,
  type ToolSchema,
} from '../FunctionCalling.js';

describe('FunctionCalling', () => {
  describe('convertToolSchemaToFunctionDefinition', () => {
    it('should convert a simple tool schema', () => {
      const schema: ToolSchema = {
        name: 'bash',
        description: 'Execute bash commands',
        parameters: {
          command: {
            type: 'string',
            description: 'The command to execute',
            required: true,
          },
        },
      };

      const result = convertToolSchemaToFunctionDefinition(schema);

      expect(result.type).toBe('function');
      expect(result.function.name).toBe('bash');
      expect(result.function.description).toBe('Execute bash commands');
      expect(result.function.parameters.type).toBe('object');
      expect(result.function.parameters.properties).toHaveProperty('command');
      expect(result.function.parameters.required).toContain('command');
    });

    it('should handle optional parameters', () => {
      const schema: ToolSchema = {
        name: 'read',
        description: 'Read a file',
        parameters: {
          path: {
            type: 'string',
            description: 'File path',
            required: true,
          },
          encoding: {
            type: 'string',
            description: 'File encoding',
            required: false,
          },
        },
      };

      const result = convertToolSchemaToFunctionDefinition(schema);

      expect(result.function.parameters.required).toEqual(['path']);
      expect(result.function.parameters.properties).toHaveProperty('encoding');
    });

    it('should handle parameters with no required fields', () => {
      const schema: ToolSchema = {
        name: 'test',
        description: 'Test tool',
        parameters: {
          optional: {
            type: 'string',
            required: false,
          },
        },
      };

      const result = convertToolSchemaToFunctionDefinition(schema);

      expect(result.function.parameters.required).toBeUndefined();
    });
  });

  describe('parseToolCallArguments', () => {
    it('should parse JSON string arguments', () => {
      const args = '{"command": "ls -la"}';
      const result = parseToolCallArguments(args);

      expect(result).toEqual({ command: 'ls -la' });
    });

    it('should return object arguments as-is', () => {
      const args = { command: 'ls -la' };
      const result = parseToolCallArguments(args);

      expect(result).toEqual(args);
    });

    it('should return empty object for invalid JSON', () => {
      const args = '{invalid json}';
      const result = parseToolCallArguments(args);

      expect(result).toEqual({});
    });

    it('should handle null or undefined', () => {
      expect(parseToolCallArguments(null as any)).toEqual({});
      expect(parseToolCallArguments(undefined as any)).toEqual({});
    });
  });

  describe('validateFunctionArguments', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        command: { type: 'string' as const, description: 'Command' },
        timeout: { type: 'number' as const, description: 'Timeout' },
        verbose: { type: 'boolean' as const, description: 'Verbose' },
      },
      required: ['command'],
    };

    it('should validate correct arguments', () => {
      const args = { command: 'ls', timeout: 30, verbose: true };
      const result = validateFunctionArguments(args, schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const args = { timeout: 30 };
      const result = validateFunctionArguments(args, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required parameter: command');
    });

    it('should detect type mismatches', () => {
      const args = { command: 123 }; // Wrong type
      const result = validateFunctionArguments(args, schema);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('invalid type'))).toBe(true);
    });

    it('should allow extra fields', () => {
      const args = { command: 'ls', extraField: 'value' };
      const result = validateFunctionArguments(args, schema);

      expect(result.valid).toBe(true);
    });

    it('should handle schemas without required fields', () => {
      const schemaNoRequired = {
        type: 'object' as const,
        properties: {
          optional: { type: 'string' as const },
        },
      };

      const args = { optional: 'value' };
      const result = validateFunctionArguments(args, schemaNoRequired);

      expect(result.valid).toBe(true);
    });
  });

  describe('extractToolCallData', () => {
    it('should extract tool call data', () => {
      const toolCall = {
        id: 'call-123',
        type: 'function',
        function: {
          name: 'bash',
          arguments: { command: 'ls' },
        },
      };

      const result = extractToolCallData(toolCall);

      expect(result.id).toBe('call-123');
      expect(result.name).toBe('bash');
      expect(result.arguments).toEqual({ command: 'ls' });
    });

    it('should parse string arguments', () => {
      const toolCall = {
        id: 'call-123',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '{"command": "ls"}',
        },
      };

      const result = extractToolCallData(toolCall);

      expect(result.arguments).toEqual({ command: 'ls' });
    });

    it('should generate ID if missing', () => {
      const toolCall = {
        type: 'function',
        function: {
          name: 'bash',
          arguments: {},
        },
      };

      const result = extractToolCallData(toolCall);

      expect(result.id).toMatch(/^call-\d+$/);
    });

    it('should handle missing function object', () => {
      const toolCall = {
        id: 'call-123',
        type: 'function',
      };

      const result = extractToolCallData(toolCall);

      expect(result.name).toBe('');
      expect(result.arguments).toEqual({});
    });
  });

  describe('createToolResultMessage', () => {
    it('should create a tool result message with string result', () => {
      const result = createToolResultMessage('call-123', 'bash', 'Command output');

      expect(result.role).toBe('tool');
      expect(result.tool_call_id).toBe('call-123');
      expect(result.name).toBe('bash');
      expect(result.content).toBe('Command output');
    });

    it('should create a tool result message with object result', () => {
      const data = { success: true, output: 'test' };
      const result = createToolResultMessage('call-123', 'bash', data);

      expect(result.role).toBe('tool');
      expect(result.content).toBe(JSON.stringify(data, null, 2));
    });
  });

  describe('hasToolCalls', () => {
    it('should return true for messages with tool calls', () => {
      const message = {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-123',
            type: 'function',
            function: { name: 'bash', arguments: {} },
          },
        ],
      };

      expect(hasToolCalls(message)).toBe(true);
    });

    it('should return false for messages without tool calls', () => {
      const message = {
        role: 'assistant',
        content: 'Hello',
      };

      expect(hasToolCalls(message)).toBe(false);
    });

    it('should return false for empty tool calls array', () => {
      const message = {
        role: 'assistant',
        content: '',
        tool_calls: [],
      };

      expect(hasToolCalls(message)).toBe(false);
    });
  });

  describe('isValidToolCall', () => {
    it('should validate a correct tool call', () => {
      const toolCall = {
        id: 'call-123',
        type: 'function',
        function: {
          name: 'bash',
          arguments: {},
        },
      };

      expect(isValidToolCall(toolCall)).toBe(true);
    });

    it('should reject tool call without id', () => {
      const toolCall = {
        type: 'function',
        function: { name: 'bash', arguments: {} },
      };

      expect(isValidToolCall(toolCall)).toBe(false);
    });

    it('should reject tool call with wrong type', () => {
      const toolCall = {
        id: 'call-123',
        type: 'invalid',
        function: { name: 'bash', arguments: {} },
      };

      expect(isValidToolCall(toolCall)).toBe(false);
    });

    it('should reject tool call without function object', () => {
      const toolCall = {
        id: 'call-123',
        type: 'function',
      };

      expect(isValidToolCall(toolCall)).toBe(false);
    });

    it('should reject tool call without function name', () => {
      const toolCall = {
        id: 'call-123',
        type: 'function',
        function: { arguments: {} },
      };

      expect(isValidToolCall(toolCall)).toBe(false);
    });

    it('should handle null or undefined', () => {
      expect(isValidToolCall(null)).toBe(false);
      expect(isValidToolCall(undefined)).toBe(false);
    });
  });

  describe('sanitizeToolCallArguments', () => {
    it('should remove undefined values', () => {
      const args = {
        command: 'ls',
        timeout: undefined,
        verbose: true,
      };

      const result = sanitizeToolCallArguments(args);

      expect(result).toEqual({ command: 'ls', verbose: true });
      expect(result).not.toHaveProperty('timeout');
    });

    it('should remove null values', () => {
      const args = {
        command: 'ls',
        timeout: null,
        verbose: true,
      };

      const result = sanitizeToolCallArguments(args);

      expect(result).toEqual({ command: 'ls', verbose: true });
    });

    it('should preserve falsy values that are not null/undefined', () => {
      const args = {
        count: 0,
        verbose: false,
        message: '',
      };

      const result = sanitizeToolCallArguments(args);

      expect(result).toEqual(args);
    });

    it('should handle empty objects', () => {
      const result = sanitizeToolCallArguments({});

      expect(result).toEqual({});
    });
  });
});
