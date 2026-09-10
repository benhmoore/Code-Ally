/**
 * ToolValidator - Validates tool arguments against schemas
 *
 * Provides lightweight validation of tool arguments with enhanced error messages.
 * Includes value range validation, logical constraints, and tool-specific rules.
 */

import { FunctionDefinition, ParameterSchema, ErrorType } from '../types/index.js';
import { BaseTool } from './BaseTool.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  error_type?: ErrorType;
  suggestion?: string;
}

/** A validation failure that names the JSON path of the offending value. */
function fail(path: string, detail: string): { valid: false; error: string } {
  return { valid: false, error: `${path}: ${detail}` };
}

/** The observed type, distinguishing an array from a plain object. */
function describe(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
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

    // Apply tool-specific validation rules FIRST (they may catch semantic issues)
    const toolValidation = tool.validateArgs(args);
    if (toolValidation && !toolValidation.valid) {
      return {
        valid: false,
        error: toolValidation.error,
        error_type: (toolValidation.error_type as ErrorType) || 'validation_error',
        suggestion: toolValidation.suggestion,
      };
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

      const typeValid = this.validateValue(paramValue, paramSchema, paramName);
      if (!typeValid.valid) {
        return {
          valid: false,
          error: `Invalid type in ${tool.name}: ${typeValid.error}`,
          error_type: 'validation_error',
          suggestion: `Expected ${paramSchema.type}, got ${typeof paramValue}`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validate a value against a schema node, recursing through objects and
   * arrays. Every failure names the JSON path of the offending value so a
   * model can correct exactly that field and retry.
   *
   * @param value - The value to check
   * @param schema - The schema node the value must satisfy
   * @param path - JSON path of `value`, used as the prefix for nested paths
   */
  validateValue(
    value: unknown,
    schema: ParameterSchema,
    path: string = '$'
  ): { valid: boolean; error?: string } {
    if (value === null || value === undefined) {
      return fail(path, 'value is null or undefined');
    }

    if (schema.enum) {
      const allowed = schema.enum as readonly unknown[];
      if (!allowed.includes(value)) {
        return fail(path, `expected one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
      }
    }

    switch (schema.type) {
      case 'string':
        return typeof value === 'string'
          ? { valid: true }
          : fail(path, `expected string, got ${describe(value)}`);

      case 'number':
      case 'integer':
        if (typeof value !== 'number' || Number.isNaN(value)) {
          return fail(path, `expected ${schema.type}, got ${describe(value)}`);
        }
        if (schema.type === 'integer' && !Number.isInteger(value)) {
          return fail(path, `expected integer, got ${value}`);
        }
        return { valid: true };

      case 'boolean':
        return typeof value === 'boolean'
          ? { valid: true }
          : fail(path, `expected boolean, got ${describe(value)}`);

      case 'array':
        return this.validateArray(value, schema, path);

      case 'object':
        return this.validateObject(value, schema, path);

      default:
        // A node with no declared type constrains nothing further.
        return { valid: true };
    }
  }

  private validateArray(
    value: unknown,
    schema: ParameterSchema,
    path: string
  ): { valid: boolean; error?: string } {
    if (!Array.isArray(value)) {
      return fail(path, `expected array, got ${describe(value)}`);
    }
    if (!schema.items) return { valid: true };

    for (let i = 0; i < value.length; i++) {
      const item = this.validateValue(value[i], schema.items, `${path}[${i}]`);
      if (!item.valid) return item;
    }
    return { valid: true };
  }

  private validateObject(
    value: unknown,
    schema: ParameterSchema,
    path: string
  ): { valid: boolean; error?: string } {
    if (typeof value !== 'object' || Array.isArray(value)) {
      return fail(path, `expected object, got ${describe(value)}`);
    }
    const record = value as Record<string, unknown>;

    for (const name of schema.required ?? []) {
      if (!(name in record)) {
        return fail(`${path}.${name}`, 'required property is missing');
      }
    }

    if (schema.additionalProperties === false) {
      const declared = schema.properties ?? {};
      for (const name of Object.keys(record)) {
        if (!(name in declared)) {
          return fail(`${path}.${name}`, 'property is not allowed by the schema');
        }
      }
    }

    for (const [name, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (!(name in record)) continue;
      const property = this.validateValue(record[name], propertySchema, `${path}.${name}`);
      if (!property.valid) return property;
    }
    return { valid: true };
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
      patch: '"@@ -1,1 +1,1 @@\\n-old\\n+new"',
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
