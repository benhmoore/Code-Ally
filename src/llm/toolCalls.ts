/**
 * Shared tool-call normalization, repair, and validation.
 *
 * Every backend we speak to emits tool calls that drift from the canonical
 * `{id, type:'function', function:{name, arguments}}` shape in the same handful
 * of ways: a flat `name`/`arguments` pair at the top level, a missing `type`,
 * arguments delivered as a JSON *string*, and ids the model reuses across turns.
 * None of that is provider-specific, so the repair lives here once and both
 * clients call it rather than keeping diverging private copies.
 */

import { LLMResponse } from './ModelClient.js';
import { logger } from '../services/Logger.js';

/** Outcome of validating (and repairing in place) a message's tool calls. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Anything carrying tool calls that may not yet be in canonical shape. */
interface ToolCallCarrier {
  content?: string;
  tool_calls?: any[];
}

/**
 * Normalize and validate every tool call on a message, rewriting the message's
 * `tool_calls` with the repaired versions. Returns the collected errors; a
 * message with any unrepairable call is reported invalid so the caller can ask
 * the model to try again instead of silently dropping the call.
 */
export function normalizeToolCallsInMessage(message: ToolCallCarrier): ValidationResult {
  const errors: string[] = [];
  const validCalls: any[] = [];

  if (!message.tool_calls || message.tool_calls.length === 0) {
    return { valid: true, errors: [] };
  }

  for (let i = 0; i < message.tool_calls.length; i++) {
    const repairResult = repairSingleToolCall(message.tool_calls[i], i);

    if (repairResult.valid) {
      validCalls.push(repairResult.repaired);
    } else {
      errors.push(...repairResult.errors);
    }
  }

  // Update message with repaired calls
  if (validCalls.length > 0) {
    message.tool_calls = validCalls;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Attempt to repair a single tool call into canonical shape.
 */
export function repairSingleToolCall(
  call: any,
  index: number
): { valid: boolean; errors: string[]; repaired?: any } {
  const errors: string[] = [];
  const repaired: any = { ...call };

  // ALWAYS generate a unique ID to prevent duplicates from LLM
  // LLMs don't maintain state across responses and can reuse IDs (e.g., functions.glob:4)
  // Using timestamp + random suffix ensures uniqueness across the entire session
  const random = Math.random().toString(36).substring(2, 9);
  repaired.id = `call-${Date.now()}-${index}-${random}`;

  // Repair missing type
  if (!repaired.type) {
    repaired.type = 'function';
  }

  // Handle flat structure (name/arguments at top level)
  if (repaired.name && !repaired.function) {
    repaired.function = {
      name: repaired.name,
      arguments: repaired.arguments || {},
    };
    delete repaired.name;
    delete repaired.arguments;
  }

  // Validate function object
  if (!repaired.function || typeof repaired.function !== 'object') {
    errors.push(`Tool call ${index}: Missing or invalid function object`);
    return { valid: false, errors };
  }

  // Validate function name
  if (!repaired.function.name || typeof repaired.function.name !== 'string') {
    errors.push(`Tool call ${index}: Missing or invalid function name`);
    return { valid: false, errors };
  }

  // Parse JSON string arguments. A blank/whitespace-only string is the wire
  // encoding for "no arguments" (streamed tool calls often accumulate nothing),
  // so it becomes {} rather than a JSON parse error.
  if (typeof repaired.function.arguments === 'string') {
    if (!repaired.function.arguments.trim()) {
      repaired.function.arguments = {};
    } else {
      try {
        repaired.function.arguments = JSON.parse(repaired.function.arguments);
      } catch (error) {
        errors.push(`Tool call ${index}: Invalid JSON in arguments: ${error}`);
        return { valid: false, errors };
      }
    }
  }

  // Ensure arguments is an object
  if (!repaired.function.arguments || typeof repaired.function.arguments !== 'object') {
    repaired.function.arguments = {};
  }

  return { valid: true, errors: [], repaired };
}

/**
 * Validate (and repair in place) the tool calls on a model response.
 *
 * On success the response is returned with canonical tool calls. On failure it
 * is replaced by a validation-error response carrying the malformed calls: a
 * TERMINAL outcome that the Agent turns into a repair prompt, so the model is
 * told what was wrong instead of the calls vanishing or the whole request being
 * retried from scratch.
 */
export function validateToolCalls(result: LLMResponse): LLMResponse {
  if (!result.tool_calls || result.tool_calls.length === 0) {
    return result;
  }

  const validation = normalizeToolCallsInMessage(result as ToolCallCarrier);
  if (validation.valid) {
    return result;
  }

  logger.warn('[LLM] Tool call validation failed, returning error for Agent-level continuation...');
  logger.debug('[LLM] Validation errors:', validation.errors);

  return {
    role: 'assistant',
    content: result.content || '',
    tool_calls: result.tool_calls, // Include malformed calls
    error: true,
    tool_call_validation_failed: true,
    validation_errors: validation.errors,
  };
}
