/**
 * ToolValidator - Validates tool arguments against schemas
 *
 * Provides lightweight validation of tool arguments with enhanced error messages.
 */

import { FunctionDefinition, ParameterSchema, ErrorType } from '../types/index.js';
import { BaseTool } from './BaseTool.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  error_type?: ErrorType;
  suggestion?: string;
}

export class ToolValidator {
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
