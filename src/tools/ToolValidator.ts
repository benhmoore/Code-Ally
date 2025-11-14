/**
 * ToolValidator - Validates tool arguments against schemas
 *
 * Provides lightweight validation of tool arguments with enhanced error messages.
 * Includes value range validation, logical constraints, and tool-specific rules.
 */

import { FunctionDefinition, ParameterSchema, ErrorType } from '../types/index.js';
import { BaseTool } from './BaseTool.js';
import { isPathWithinCwd } from '../security/PathSecurity.js';
import { resolvePath } from '../utils/pathUtils.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  error_type?: ErrorType;
  suggestion?: string;
}

/**
 * Tool-specific validation rule
 */
type ToolValidationRule = (args: Record<string, any>) => ValidationResult;

export class ToolValidator {
  /**
   * Tool-specific validation rules
   * Maps tool name to validation function
   */
  private static readonly VALIDATION_RULES: Map<string, ToolValidationRule> = new Map([
    ['read', ToolValidator.validateReadArgs],
    ['bash', ToolValidator.validateBashArgs],
    ['grep', ToolValidator.validateGrepArgs],
    ['write', ToolValidator.validateWriteArgs],
    ['edit', ToolValidator.validateEditArgs],
    ['line-edit', ToolValidator.validateLineEditArgs],
    ['agent', ToolValidator.validateAgentArgs],
  ]);

  /**
   * Validate tool arguments against the tool's function definition
   *
   * @param tool - The tool to validate arguments for
   * @param functionDef - The function definition containing parameter schema
   * @param args - The arguments provided by the LLM
   * @returns Validation result
   */
  validateArguments(
    tool: BaseTool,
    functionDef: FunctionDefinition,
    args: Record<string, any>
  ): ValidationResult {
    const params = functionDef.function.parameters;
    const required = params.required || [];

    // Apply tool-specific validation rules FIRST (they may catch semantic issues)
    const toolRule = ToolValidator.VALIDATION_RULES.get(tool.name);
    if (toolRule) {
      const result = toolRule(args);
      if (!result.valid) {
        return result;
      }
    }

    // Check for required parameters
    for (const requiredParam of required) {
      if (!(requiredParam in args) || args[requiredParam] === undefined) {
        const example = this.generateExample(tool.name, params.properties, required);
        return {
          valid: false,
          error: `Missing required parameter '${requiredParam}' for ${tool.name}`,
          error_type: 'validation_error',
          suggestion: `Example: ${example}`,
        };
      }
    }

    // Type validation for provided parameters
    for (const [paramName, paramValue] of Object.entries(args)) {
      const paramSchema = params.properties[paramName];
      if (!paramSchema) {
        // Unknown parameter - warn but allow
        continue;
      }

      const typeValid = this.validateType(paramValue, paramSchema);
      if (!typeValid.valid) {
        return {
          valid: false,
          error: `Invalid type for parameter '${paramName}' in ${tool.name}: ${typeValid.error}`,
          error_type: 'validation_error',
          suggestion: `Expected ${paramSchema.type}, got ${typeof paramValue}`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validate ReadTool arguments
   */
  private static validateReadArgs(args: Record<string, any>): ValidationResult {
    // Validate limit parameter
    if (args.limit !== undefined && args.limit !== null) {
      const limit = Number(args.limit);
      if (isNaN(limit) || limit < 0) {
        return {
          valid: false,
          error: 'limit must be a non-negative number',
          error_type: 'validation_error',
          suggestion: 'Example: limit=100 (or 0 for all lines)',
        };
      }
    }

    // Validate offset parameter
    if (args.offset !== undefined && args.offset !== null) {
      const offset = Number(args.offset);
      if (isNaN(offset)) {
        return {
          valid: false,
          error: 'offset must be a number (positive: 1-based line number, negative: count from end)',
          error_type: 'validation_error',
          suggestion: 'Example: offset=1 (starts at line 1) or offset=-20 (last 20 lines with limit=20)',
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validate BashTool arguments
   */
  private static validateBashArgs(args: Record<string, any>): ValidationResult {
    // Validate timeout parameter
    if (args.timeout !== undefined && args.timeout !== null) {
      const timeout = Number(args.timeout);
      if (isNaN(timeout) || timeout <= 0) {
        return {
          valid: false,
          error: 'timeout must be a positive number (in seconds)',
          error_type: 'validation_error',
          suggestion: 'Example: timeout=30 (30 seconds)',
        };
      }
      if (timeout > 600) {
        return {
          valid: false,
          error: 'timeout cannot exceed 600 seconds (10 minutes)',
          error_type: 'validation_error',
          suggestion: 'Maximum timeout is 600 seconds',
        };
      }
    }

    // Validate command length
    if (args.command !== undefined && args.command !== null && typeof args.command === 'string') {
      if (args.command.length === 0) {
        return {
          valid: false,
          error: 'command cannot be empty',
          error_type: 'validation_error',
          suggestion: 'Example: command="ls -la"',
        };
      }
      if (args.command.length > 10000) {
        return {
          valid: false,
          error: 'command is too long (max 10000 characters)',
          error_type: 'validation_error',
          suggestion: 'Consider breaking into smaller commands or using a script file',
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validate GrepTool arguments
   */
  private static validateGrepArgs(args: Record<string, any>): ValidationResult {
    // Validate regex pattern syntax
    if (args.pattern && typeof args.pattern === 'string') {
      try {
        const flags = args['-i'] || args.case_insensitive ? 'i' : '';
        new RegExp(args.pattern, flags);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Invalid regex';
        return {
          valid: false,
          error: `Invalid regex pattern: ${errorMsg}`,
          error_type: 'validation_error',
          suggestion: 'Use simpler patterns or escape special characters like . * + ? [ ] ( ) { } | \\',
        };
      }
    }

    // Validate context line parameters
    const contextParams = ['-A', '-B', '-C'];
    for (const param of contextParams) {
      if (args[param] !== undefined && args[param] !== null) {
        const value = Number(args[param]);
        if (isNaN(value) || value < 0) {
          return {
            valid: false,
            error: `${param} must be a non-negative number`,
            error_type: 'validation_error',
            suggestion: `Example: ${param}=3 (show 3 context lines)`,
          };
        }
        if (value > 20) {
          return {
            valid: false,
            error: `${param} cannot exceed 20 (max context lines)`,
            error_type: 'validation_error',
            suggestion: 'Maximum context is 20 lines',
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Validate WriteTool arguments
   */
  private static validateWriteArgs(args: Record<string, any>): ValidationResult {
    return ToolValidator.validatePathWithinCwd(args.file_path);
  }

  /**
   * Validate EditTool arguments
   */
  private static validateEditArgs(args: Record<string, any>): ValidationResult {
    return ToolValidator.validatePathWithinCwd(args.file_path);
  }

  /**
   * Validate LineEditTool arguments
   */
  private static validateLineEditArgs(args: Record<string, any>): ValidationResult {
    // Validate path
    const pathResult = ToolValidator.validatePathWithinCwd(args.file_path);
    if (!pathResult.valid) {
      return pathResult;
    }

    // Validate line_number parameter
    if (args.line_number !== undefined && args.line_number !== null) {
      const lineNumber = Number(args.line_number);
      if (isNaN(lineNumber) || lineNumber < 1) {
        return {
          valid: false,
          error: 'line_number must be >= 1 (line numbers are 1-indexed)',
          error_type: 'validation_error',
          suggestion: 'Line numbers are 1-indexed. Example: line_number=10',
        };
      }
      if (lineNumber > 1000000) {
        return {
          valid: false,
          error: 'line_number is unreasonably large (max 1000000)',
          error_type: 'validation_error',
          suggestion: 'Check that line_number is correct',
        };
      }
    }

    // Validate num_lines for delete operation
    if (args.operation === 'delete' && args.num_lines !== undefined && args.num_lines !== null) {
      const numLines = Number(args.num_lines);
      if (isNaN(numLines) || numLines < 1) {
        return {
          valid: false,
          error: 'num_lines must be >= 1 for delete operation',
          error_type: 'validation_error',
          suggestion: 'Example: num_lines=5 (delete 5 lines)',
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validate AgentTool arguments
   */
  private static validateAgentArgs(args: Record<string, any>): ValidationResult {
    // Validate task_prompt is non-empty
    if (args.task_prompt && typeof args.task_prompt === 'string') {
      if (args.task_prompt.trim().length === 0) {
        return {
          valid: false,
          error: 'task_prompt cannot be empty',
          error_type: 'validation_error',
          suggestion: 'Provide a clear task description for the agent',
        };
      }
      if (args.task_prompt.length > 50000) {
        return {
          valid: false,
          error: 'task_prompt is too long (max 50000 characters)',
          error_type: 'validation_error',
          suggestion: 'Break down into smaller tasks or provide a more concise prompt',
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validate that a file path is within the current working directory
   */
  private static validatePathWithinCwd(
    filePath: any
  ): ValidationResult {
    if (!filePath || typeof filePath !== 'string') {
      return { valid: true }; // Let other validation catch this
    }

    try {
      const absolutePath = resolvePath(filePath);
      if (!isPathWithinCwd(absolutePath)) {
        return {
          valid: false,
          error: 'Path is outside the current working directory',
          error_type: 'security_error',
          suggestion: 'File paths must be within the current working directory. Use relative paths like "src/file.ts"',
        };
      }
    } catch (error) {
      // Path resolution failed - let the tool handle it
      return { valid: true };
    }

    return { valid: true };
  }

  /**
   * Validate a value against a parameter schema
   */
  private validateType(
    value: any,
    schema: ParameterSchema
  ): { valid: boolean; error?: string } {
    // Handle null/undefined
    if (value === null || value === undefined) {
      return { valid: false, error: 'Value is null or undefined' };
    }

    switch (schema.type) {
      case 'string':
        if (typeof value !== 'string') {
          return { valid: false, error: `Expected string, got ${typeof value}` };
        }
        return { valid: true };

      case 'number':
      case 'integer':
        if (typeof value !== 'number') {
          return { valid: false, error: `Expected number, got ${typeof value}` };
        }
        if (schema.type === 'integer' && !Number.isInteger(value)) {
          return { valid: false, error: 'Expected integer, got float' };
        }
        return { valid: true };

      case 'boolean':
        if (typeof value !== 'boolean') {
          return { valid: false, error: `Expected boolean, got ${typeof value}` };
        }
        return { valid: true };

      case 'array':
        if (!Array.isArray(value)) {
          return { valid: false, error: `Expected array, got ${typeof value}` };
        }
        // Optionally validate array items if schema.items is defined
        if (schema.items) {
          for (let i = 0; i < value.length; i++) {
            const itemValid = this.validateType(value[i], schema.items);
            if (!itemValid.valid) {
              return {
                valid: false,
                error: `Array item ${i}: ${itemValid.error}`,
              };
            }
          }
        }
        return { valid: true };

      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) {
          return { valid: false, error: `Expected object, got ${typeof value}` };
        }
        // Optionally validate object properties if schema.properties is defined
        if (schema.properties && schema.required) {
          for (const requiredProp of schema.required) {
            if (!(requiredProp in value)) {
              return {
                valid: false,
                error: `Missing required property '${requiredProp}'`,
              };
            }
          }
        }
        return { valid: true };

      default:
        // Unknown type - allow
        return { valid: true };
    }
  }

  /**
   * Generate an example usage string for a tool
   */
  private generateExample(
    toolName: string,
    properties: Record<string, ParameterSchema>,
    required: string[]
  ): string {
    const exampleParams = required
      .map((paramName) => {
        const schema = properties[paramName];
        if (!schema) {
          return `${paramName}="value"`;
        }
        const exampleValue = this.getExampleValue(paramName, schema);
        return `${paramName}=${exampleValue}`;
      });

    return `${toolName}(${exampleParams.join(', ')})`;
  }

  /**
   * Generate an example value for a parameter
   */
  private getExampleValue(paramName: string, schema: ParameterSchema | undefined): string {
    // Parameter-specific examples
    const examples: Record<string, string> = {
      file_path: '"src/main.ts"',
      path: '"."',
      pattern: '"**/*.ts"',
      command: '"ls -la"',
      content: '"Hello world"',
      old_string: '"old text"',
      new_string: '"new text"',
      limit: '50',
      offset: '0',
      case_sensitive: 'false',
    };

    if (paramName in examples) {
      const example = examples[paramName];
      if (example !== undefined) {
        return example;
      }
    }

    if (!schema) {
      return '"value"';
    }

    // Type-based examples
    switch (schema.type) {
      case 'string':
        return `"${paramName}_value"`;
      case 'number':
      case 'integer':
        return '0';
      case 'boolean':
        return 'false';
      case 'array':
        return '[]';
      case 'object':
        return '{}';
      default:
        return 'null';
    }
  }
}
