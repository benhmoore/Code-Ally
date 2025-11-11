/**
 * Tests for ToolValidator - Enhanced argument validation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolValidator, ValidationResult } from '../ToolValidator.js';
import { BaseTool } from '../BaseTool.js';
import { ToolResult, FunctionDefinition } from '@shared/index.js';
import { ActivityStream } from '@services/ActivityStream.js';

// Mock tool for testing
class MockTool extends BaseTool {
  readonly name = 'mock';
  readonly description = 'Mock tool for testing';
  readonly requiresConfirmation = false;

  protected async executeImpl(_args: any): Promise<ToolResult> {
    return { success: true, error: '' };
  }
}

describe('ToolValidator', () => {
  let validator: ToolValidator;
  let mockTool: MockTool;
  let activityStream: ActivityStream;

  beforeEach(() => {
    validator = new ToolValidator();
    activityStream = new ActivityStream();
    mockTool = new MockTool(activityStream);
  });

  describe('ReadTool validation', () => {
    const readFunctionDef: FunctionDefinition = {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read files',
        parameters: {
          type: 'object',
          properties: {
            file_paths: { type: 'array' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
          },
          required: ['file_paths'],
        },
      },
    };

    it('should reject negative limit', () => {
      mockTool.name = 'read';
      const result = validator.validateArguments(mockTool, readFunctionDef, {
        file_paths: ['test.txt'],
        limit: -5,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('limit must be a non-negative number');
      expect(result.suggestion).toContain('limit=100');
    });

    it('should accept negative offset', () => {
      mockTool.name = 'read';
      const result = validator.validateArguments(mockTool, readFunctionDef, {
        file_paths: ['test.txt'],
        offset: -20,
      });

      expect(result.valid).toBe(true);
    });

    it('should accept valid limit and offset', () => {
      mockTool.name = 'read';
      const result = validator.validateArguments(mockTool, readFunctionDef, {
        file_paths: ['test.txt'],
        limit: 100,
        offset: 50,
      });

      expect(result.valid).toBe(true);
    });

    it('should accept limit=0 (all lines)', () => {
      mockTool.name = 'read';
      const result = validator.validateArguments(mockTool, readFunctionDef, {
        file_paths: ['test.txt'],
        limit: 0,
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('BashTool validation', () => {
    const bashFunctionDef: FunctionDefinition = {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Execute bash commands',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeout: { type: 'integer' },
          },
          required: ['command'],
        },
      },
    };

    it('should reject zero timeout', () => {
      mockTool.name = 'bash';
      const result = validator.validateArguments(mockTool, bashFunctionDef, {
        command: 'ls',
        timeout: 0,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('timeout must be a positive number');
    });

    it('should reject negative timeout', () => {
      mockTool.name = 'bash';
      const result = validator.validateArguments(mockTool, bashFunctionDef, {
        command: 'ls',
        timeout: -10,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('timeout must be a positive number');
    });

    it('should reject timeout > 600 seconds', () => {
      mockTool.name = 'bash';
      const result = validator.validateArguments(mockTool, bashFunctionDef, {
        command: 'ls',
        timeout: 700,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('timeout cannot exceed 600 seconds');
    });

    it('should reject empty command', () => {
      mockTool.name = 'bash';
      const result = validator.validateArguments(mockTool, bashFunctionDef, {
        command: '',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('command cannot be empty');
    });

    it('should reject extremely long commands', () => {
      mockTool.name = 'bash';
      const result = validator.validateArguments(mockTool, bashFunctionDef, {
        command: 'a'.repeat(20000),
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('command is too long');
    });

    it('should accept valid timeout', () => {
      mockTool.name = 'bash';
      const result = validator.validateArguments(mockTool, bashFunctionDef, {
        command: 'ls -la',
        timeout: 30,
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('GrepTool validation', () => {
    const grepFunctionDef: FunctionDefinition = {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search files',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            '-A': { type: 'number' },
            '-B': { type: 'number' },
            '-C': { type: 'number' },
          },
          required: ['pattern'],
        },
      },
    };

    it('should reject invalid regex pattern', () => {
      mockTool.name = 'grep';
      const result = validator.validateArguments(mockTool, grepFunctionDef, {
        pattern: '[invalid(',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid regex pattern');
      expect(result.suggestion).toContain('escape special characters');
    });

    it('should reject negative context lines', () => {
      mockTool.name = 'grep';
      const result = validator.validateArguments(mockTool, grepFunctionDef, {
        pattern: 'test',
        '-A': -1,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('-A must be a non-negative number');
    });

    it('should reject context lines > 20', () => {
      mockTool.name = 'grep';
      const result = validator.validateArguments(mockTool, grepFunctionDef, {
        pattern: 'test',
        '-C': 25,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('-C cannot exceed 20');
    });

    it('should accept valid regex and context', () => {
      mockTool.name = 'grep';
      const result = validator.validateArguments(mockTool, grepFunctionDef, {
        pattern: 'class.*Test',
        '-A': 3,
        '-B': 3,
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('LineEditTool validation', () => {
    const lineEditFunctionDef: FunctionDefinition = {
      type: 'function',
      function: {
        name: 'line_edit',
        description: 'Edit files by line',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            operation: { type: 'string' },
            line_number: { type: 'integer' },
            content: { type: 'string' },
            num_lines: { type: 'integer' },
          },
          required: ['file_path', 'operation', 'line_number'],
        },
      },
    };

    it('should reject line_number < 1', () => {
      mockTool.name = 'line_edit';
      const result = validator.validateArguments(mockTool, lineEditFunctionDef, {
        file_path: 'test.txt',
        operation: 'replace',
        line_number: 0,
        content: 'new content',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('line_number must be >= 1');
      expect(result.suggestion).toContain('1-indexed');
    });

    it('should reject unreasonably large line_number', () => {
      mockTool.name = 'line_edit';
      const result = validator.validateArguments(mockTool, lineEditFunctionDef, {
        file_path: 'test.txt',
        operation: 'replace',
        line_number: 2000000,
        content: 'new content',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('unreasonably large');
    });

    it('should reject negative num_lines for delete', () => {
      mockTool.name = 'line_edit';
      const result = validator.validateArguments(mockTool, lineEditFunctionDef, {
        file_path: 'test.txt',
        operation: 'delete',
        line_number: 5,
        num_lines: -1,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('num_lines must be >= 1');
    });

    it('should accept valid line edit', () => {
      mockTool.name = 'line_edit';
      const result = validator.validateArguments(mockTool, lineEditFunctionDef, {
        file_path: 'test.txt',
        operation: 'replace',
        line_number: 10,
        content: 'new content',
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('AgentTool validation', () => {
    const agentFunctionDef: FunctionDefinition = {
      type: 'function',
      function: {
        name: 'agent',
        description: 'Delegate to agent',
        parameters: {
          type: 'object',
          properties: {
            task_prompt: { type: 'string' },
            agent_name: { type: 'string' },
          },
          required: ['task_prompt'],
        },
      },
    };

    it('should reject empty task_prompt', () => {
      mockTool.name = 'agent';
      const result = validator.validateArguments(mockTool, agentFunctionDef, {
        task_prompt: '   ',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('task_prompt cannot be empty');
    });

    it('should reject extremely long task_prompt', () => {
      mockTool.name = 'agent';
      const result = validator.validateArguments(mockTool, agentFunctionDef, {
        task_prompt: 'a'.repeat(60000),
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('task_prompt is too long');
    });

    it('should accept valid task_prompt', () => {
      mockTool.name = 'agent';
      const result = validator.validateArguments(mockTool, agentFunctionDef, {
        task_prompt: 'Analyze this code and suggest improvements',
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('Type validation', () => {
    const typeFunctionDef: FunctionDefinition = {
      type: 'function',
      function: {
        name: 'test',
        description: 'Test tool',
        parameters: {
          type: 'object',
          properties: {
            string_param: { type: 'string' },
            number_param: { type: 'number' },
            boolean_param: { type: 'boolean' },
            array_param: { type: 'array' },
          },
          required: ['string_param'],
        },
      },
    };

    it('should reject wrong type for string parameter', () => {
      mockTool.name = 'test';
      const result = validator.validateArguments(mockTool, typeFunctionDef, {
        string_param: 123,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid type');
      expect(result.error).toContain('string_param');
    });

    it('should reject wrong type for number parameter', () => {
      mockTool.name = 'test';
      const result = validator.validateArguments(mockTool, typeFunctionDef, {
        string_param: 'test',
        number_param: 'not a number',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid type');
      expect(result.error).toContain('number_param');
    });

    it('should accept correct types', () => {
      mockTool.name = 'test';
      const result = validator.validateArguments(mockTool, typeFunctionDef, {
        string_param: 'hello',
        number_param: 42,
        boolean_param: true,
        array_param: [1, 2, 3],
      });

      expect(result.valid).toBe(true);
    });
  });
});
