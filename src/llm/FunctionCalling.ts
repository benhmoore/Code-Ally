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

import { TEXT_LIMITS } from '../config/constants.js';
import { logger } from '../services/Logger.js';
import { stripDisplayOnlyFields } from '../utils/toolResultContent.js';

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
  result: any,
  isError?: boolean,
  errorType?: string
): {
  role: 'tool';
  tool_call_id: string;
  name: string;
  content: string;
  is_error?: boolean;
} {
  // When given a result object, strip display-only fields so the user-facing
  // rendering never reaches the model. Pre-serialized strings pass through
  // untouched (the orchestrator already strips before serializing).
  let content = typeof result === 'string'
    ? result
    : JSON.stringify(stripDisplayOnlyFields(result), null, 2);

  // Wrap error content in XML tags so the model can distinguish errors from successful output.
  // This is the primary error signal for Ollama-hosted models (which don't support is_error at protocol level).
  if (isError) {
    const typeAttr = errorType ? ` type="${errorType}"` : '';
    content = `<error${typeAttr}>\n${content}\n</error>`;
  }

  // Prepend tool call ID to content so model can reference it with cleanup-call
  // (outside error tags — it's metadata, not error content)
  content = `[Tool Call ID: ${toolCallId}]\n${content}`;

  return {
    role: 'tool',
    tool_call_id: toolCallId,
    name: toolName,
    content,
    ...(isError ? { is_error: true } : {}),
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

