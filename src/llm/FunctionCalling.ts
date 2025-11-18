/**
 * FunctionCalling - Utilities for function calling / tool use
 *
 * Provides utilities for:
 * - Converting tool schemas to function definitions
 * - Parsing tool call responses
 * - Validating function arguments
 *
 * Supports the OpenAI function calling format used by Ollama.
 */

import { FunctionDefinition, ParameterSchema } from '../types/index.js';
import { TEXT_LIMITS } from '../config/constants.js';
import { logger } from '../services/Logger.js';

/**
 * Tool schema definition (simplified)
 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<
    string,
    {
      type: string;
      description?: string;
      required?: boolean;
      items?: any;
      properties?: any;
    }
  >;
}

/**
 * Convert a tool schema to an OpenAI function definition
 *
 * @param schema - Tool schema
 * @returns OpenAI function definition
 *
 * @example
 * ```typescript
 * const schema: ToolSchema = {
 *   name: 'bash',
 *   description: 'Execute bash commands',
 *   parameters: {
 *     command: {
 *       type: 'string',
 *       description: 'The command to execute',
 *       required: true
 *     }
 *   }
 * };
 *
 * const functionDef = convertToolSchemaToFunctionDefinition(schema);
 * ```
 */
export function convertToolSchemaToFunctionDefinition(schema: ToolSchema): FunctionDefinition {
  const properties: Record<string, ParameterSchema> = {};
  const required: string[] = [];

  // Convert parameters to properties
  for (const [paramName, paramDef] of Object.entries(schema.parameters)) {
    properties[paramName] = {
      type: paramDef.type as any,
      description: paramDef.description,
      items: paramDef.items,
      properties: paramDef.properties,
      required: paramDef.required ? [paramName] : undefined,
    };

    if (paramDef.required) {
      required.push(paramName);
    }
  }

  return {
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description,
      parameters: {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      },
    },
  };
}

/**
 * Convert multiple tool schemas to function definitions
 *
 * @param schemas - Array of tool schemas
 * @returns Array of function definitions
 */
export function convertToolSchemasToFunctionDefinitions(
  schemas: ToolSchema[]
): FunctionDefinition[] {
  return schemas.map(convertToolSchemaToFunctionDefinition);
}

/**
 * Parse tool call arguments from string or object
 *
 * Handles both JSON strings and objects gracefully.
 *
 * @param args - Arguments (string or object)
 * @returns Parsed arguments object
 */
export function parseToolCallArguments(args: string | Record<string, any>): Record<string, any> {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch (error) {
      logger.warn('Failed to parse tool call arguments:', error);
      logger.warn('Invalid JSON string:', args.substring(0, TEXT_LIMITS.MESSAGE_PREVIEW_MAX) + (args.length > TEXT_LIMITS.MESSAGE_PREVIEW_MAX ? '...' : ''));
      return {};
    }
  }

  return args || {};
}

/**
 * Validate function arguments against a parameter schema
 *
 * Performs basic type checking and required field validation.
 *
 * @param args - Arguments to validate
 * @param schema - Parameter schema
 * @returns Validation result with errors
 */
export function validateFunctionArguments(
  args: Record<string, any>,
  schema: FunctionDefinition['function']['parameters']
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required fields
  if (schema.required) {
    for (const requiredField of schema.required) {
      if (!(requiredField in args)) {
        errors.push(`Missing required parameter: ${requiredField}`);
      }
    }
  }

  // Basic type checking
  for (const [paramName, paramSchema] of Object.entries(schema.properties || {})) {
    if (paramName in args) {
      const value = args[paramName];
      const expectedType = paramSchema.type;

      const actualType = Array.isArray(value) ? 'array' : typeof value;

      // Map JavaScript types to JSON schema types
      const typeMap: Record<string, string[]> = {
        string: ['string'],
        number: ['number', 'integer'],
        integer: ['number'],
        boolean: ['boolean'],
        object: ['object'],
        array: ['array'],
      };

      const validTypes = typeMap[expectedType] || [expectedType];
      if (!validTypes.includes(actualType)) {
        errors.push(
          `Parameter '${paramName}' has invalid type. Expected ${expectedType}, got ${actualType}`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Extract tool name and arguments from a tool call
 *
 * @param toolCall - Tool call object
 * @returns Tool name and parsed arguments
 */
export function extractToolCallData(toolCall: any): {
  name: string;
  arguments: Record<string, any>;
  id: string;
} {
  const functionObj = toolCall.function || {};

  return {
    name: functionObj.name || '',
    arguments: parseToolCallArguments(functionObj.arguments || {}),
    id: toolCall.id || `call-${Date.now()}`,
  };
}

/**
 * Create a standardized tool result message
 *
 * @param toolCallId - ID of the tool call
 * @param toolName - Name of the tool
 * @param result - Result data
 * @returns Message object for conversation history
 */
export function createToolResultMessage(
  toolCallId: string,
  toolName: string,
  result: any
): {
  role: 'tool';
  tool_call_id: string;
  name: string;
  content: string;
} {
  let content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

  // Prepend tool call ID to content so model can reference it with cleanup-call
  content = `[Tool Call ID: ${toolCallId}]\n${content}`;

  return {
    role: 'tool',
    tool_call_id: toolCallId,
    name: toolName,
    content,
  };
}

/**
 * Check if a message contains tool calls
 *
 * @param message - Message to check
 * @returns True if message has tool calls
 */
export function hasToolCalls(message: any): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

/**
 * Check if a tool call is valid
 *
 * @param toolCall - Tool call to validate
 * @returns True if valid
 */
export function isValidToolCall(toolCall: any): boolean {
  if (!toolCall || typeof toolCall !== 'object') {
    return false;
  }

  if (!toolCall.id) {
    return false;
  }

  if (toolCall.type !== 'function') {
    return false;
  }

  if (!toolCall.function || typeof toolCall.function !== 'object') {
    return false;
  }

  if (!toolCall.function.name || typeof toolCall.function.name !== 'string') {
    return false;
  }

  return true;
}

/**
 * Sanitize tool call arguments
 *
 * Removes undefined values and ensures proper types.
 *
 * @param args - Arguments to sanitize
 * @returns Sanitized arguments
 */
export function sanitizeToolCallArguments(args: Record<string, any>): Record<string, any> {
  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== null) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
