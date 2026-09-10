/**
 * Tests for ToolValidator - Enhanced argument validation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolValidator, ValidationResult } from '../ToolValidator.js';
import { BaseTool } from '../BaseTool.js';
import { ReadTool } from '../ReadTool.js';
import { BashTool } from '../BashTool.js';
import { GrepTool } from '../GrepTool.js';
import { AgentTool } from '../AgentTool.js';
import { ToolResult, FunctionDefinition, ParameterSchema } from '@shared/index.js';
import { ActivityStream } from '@services/ActivityStream.js';

// Mock tool for testing basic functionality
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
  let activityStream: ActivityStream;
  let readTool: ReadTool;
  let bashTool: BashTool;
  let grepTool: GrepTool;
  let agentTool: AgentTool;

  beforeEach(() => {
    validator = new ToolValidator();
    activityStream = new ActivityStream();
    readTool = new ReadTool(activityStream);
    bashTool = new BashTool(activityStream);
    grepTool = new GrepTool(activityStream);
    agentTool = new AgentTool(activityStream);
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
            file_path: { type: 'string' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
          },
          required: ['file_path'],
        },
      },
    };

    it('should reject negative limit', () => {
      const result = validator.validateArguments(readTool, readFunctionDef, {
        file_path: 'test.txt',
        limit: -5,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('limit must be a non-negative number');
      expect(result.suggestion).toContain('limit=100');
    });

    it('should accept negative offset', () => {
      const result = validator.validateArguments(readTool, readFunctionDef, {
        file_path: 'test.txt',
        offset: -20,
      });

      expect(result.valid).toBe(true);
    });

    it('should accept valid limit and offset', () => {
      const result = validator.validateArguments(readTool, readFunctionDef, {
        file_path: 'test.txt',
        limit: 100,
        offset: 50,
      });

      expect(result.valid).toBe(true);
    });

    it('should accept limit=0 (all lines)', () => {
      const result = validator.validateArguments(readTool, readFunctionDef, {
        file_path: 'test.txt',
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
      const result = validator.validateArguments(bashTool, bashFunctionDef, {
        command: 'ls',
        timeout: 0,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('timeout must be a positive number');
    });

    it('should reject negative timeout', () => {
      const result = validator.validateArguments(bashTool, bashFunctionDef, {
        command: 'ls',
        timeout: -10,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('timeout must be a positive number');
    });

    it('should reject timeout > 600 seconds', () => {
      const result = validator.validateArguments(bashTool, bashFunctionDef, {
        command: 'ls',
        timeout: 700,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('timeout cannot exceed 600 seconds');
    });

    it('should reject empty command', () => {
      const result = validator.validateArguments(bashTool, bashFunctionDef, {
        command: '',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('command cannot be empty');
    });

    it('should reject extremely long commands', () => {
      const result = validator.validateArguments(bashTool, bashFunctionDef, {
        command: 'a'.repeat(20000),
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('command is too long');
    });

    it('should accept valid timeout', () => {
      const result = validator.validateArguments(bashTool, bashFunctionDef, {
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
            after_context: { type: 'number' },
            before_context: { type: 'number' },
            context: { type: 'number' },
          },
          required: ['pattern'],
        },
      },
    };

    it('should accept regex patterns (validation deferred to ripgrep)', () => {
      // GrepTool defers regex validation to ripgrep since JS RegExp and
      // Rust regex have different syntax rules (see GrepTool.validateArgs)
      const result = validator.validateArguments(grepTool, grepFunctionDef, {
        pattern: '[invalid(',
      });

      expect(result.valid).toBe(true);
    });

    it('should reject negative context lines', () => {
      const result = validator.validateArguments(grepTool, grepFunctionDef, {
        pattern: 'test',
        after_context: -1,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('after_context must be a non-negative number');
    });

    it('should reject context lines > 20', () => {
      const result = validator.validateArguments(grepTool, grepFunctionDef, {
        pattern: 'test',
        context: 25,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('context cannot exceed 20');
    });

    it('should accept valid regex and context', () => {
      const result = validator.validateArguments(grepTool, grepFunctionDef, {
        pattern: 'class.*Test',
        after_context: 3,
        before_context: 3,
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
            agent: { type: 'string' },
          },
          required: ['task_prompt'],
        },
      },
    };

    it('should reject empty task_prompt', () => {
      const result = validator.validateArguments(agentTool, agentFunctionDef, {
        task_prompt: '   ',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('task_prompt cannot be empty');
    });

    it('should reject extremely long task_prompt', () => {
      const result = validator.validateArguments(agentTool, agentFunctionDef, {
        task_prompt: 'a'.repeat(60000),
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('task_prompt is too long');
    });

    it('should accept valid task_prompt', () => {
      const result = validator.validateArguments(agentTool, agentFunctionDef, {
        task_prompt: 'Analyze this code and suggest improvements',
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('Type validation', () => {
    let mockTool: MockTool;

    beforeEach(() => {
      mockTool = new MockTool(activityStream);
    });

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
      const result = validator.validateArguments(mockTool, typeFunctionDef, {
        string_param: 123,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid type');
      expect(result.error).toContain('string_param');
    });

    it('should reject wrong type for number parameter', () => {
      const result = validator.validateArguments(mockTool, typeFunctionDef, {
        string_param: 'test',
        number_param: 'not a number',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid type');
      expect(result.error).toContain('number_param');
    });

    it('should accept correct types', () => {
      const result = validator.validateArguments(mockTool, typeFunctionDef, {
        string_param: 'hello',
        number_param: 42,
        boolean_param: true,
        array_param: [1, 2, 3],
      });

      expect(result.valid).toBe(true);
    });
  });

  describe('Schema validation', () => {
    const schema: ParameterSchema = {
      type: 'object',
      required: ['results'],
      additionalProperties: false,
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            required: ['fingerprint', 'outcome'],
            properties: {
              fingerprint: { type: 'string' },
              outcome: { enum: ['fixed', 'dismissed'] },
              attempts: { type: 'integer' },
              score: { type: 'number' },
            },
          },
        },
      },
    };

    function check(value: unknown) {
      return validator.validateValue(value, schema);
    }

    it('accepts a value that satisfies the whole schema', () => {
      expect(check({
        results: [{ fingerprint: 'a1', outcome: 'fixed', attempts: 2, score: 0.5 }],
      })).toEqual({ valid: true });
    });

    it('names the path of a missing required property', () => {
      const result = check({ results: [{ outcome: 'fixed' }] });

      expect(result.valid).toBe(false);
      expect(result.error).toBe('$.results[0].fingerprint: required property is missing');
    });

    it('names the path of a value outside an enum', () => {
      const result = check({ results: [{ fingerprint: 'a1', outcome: 'pending' }] });

      expect(result.error).toBe('$.results[0].outcome: expected one of fixed, dismissed, got "pending"');
    });

    it('separates integer from number', () => {
      const base = { fingerprint: 'a1', outcome: 'fixed' };

      expect(check({ results: [{ ...base, score: 1.5 }] }).valid).toBe(true);
      expect(check({ results: [{ ...base, attempts: 1.5 }] }).error)
        .toBe('$.results[0].attempts: expected integer, got 1.5');
    });

    it('rejects an item whose type is wrong', () => {
      expect(check({ results: [{ fingerprint: 7, outcome: 'fixed' }] }).error)
        .toBe('$.results[0].fingerprint: expected string, got number');
      expect(check({ results: 'none' }).error).toBe('$.results: expected array, got string');
      expect(check({ results: [[]] }).error).toBe('$.results[0]: expected object, got array');
    });

    it('rejects an undeclared property when additionalProperties is false', () => {
      const result = check({ results: [], notes: 'extra' });

      expect(result.error).toBe('$.notes: property is not allowed by the schema');
    });

    it('allows an undeclared property by default', () => {
      const open: ParameterSchema = { type: 'object', properties: { a: { type: 'string' } } };

      expect(validator.validateValue({ a: 'x', b: 1 }, open)).toEqual({ valid: true });
    });
  });
});
