/**
 * Tool call utility functions
 * Shared logic for tool call processing across Agent and ToolOrchestrator
 */

import { BUFFER_SIZES } from '../config/constants.js';

/** Standard tool call structure */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, any>;
  };
}

/**
 * Unwrap batch tool calls into individual tool calls
 *
 * Batch is a transparent wrapper - we extract its children so they execute
 * as if the model called them directly.
 *
 * Invalid batches are NOT unwrapped - they execute normally so BatchTool
 * can validate and return proper errors.
 */
export function unwrapBatchToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  const unwrapped: ToolCall[] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.function.name === 'batch') {
      const tools = toolCall.function.arguments.tools;

      // Pre-validation: if obviously invalid, don't unwrap
      // Let BatchTool.executeImpl() run and provide detailed validation errors
      const shouldUnwrap =
        Array.isArray(tools) &&
        tools.length > 0 &&
        tools.length <= BUFFER_SIZES.MAX_BATCH_SIZE &&
        tools.every(
          (spec: any) =>
            typeof spec === 'object' &&
            spec !== null &&
            typeof spec.name === 'string' &&
            typeof spec.arguments === 'object' &&
            spec.arguments !== null
        );

      if (!shouldUnwrap) {
        // Invalid batch - keep as batch tool call
        unwrapped.push(toolCall);
        continue;
      }

      // Valid batch - unwrap into individual tool calls
      for (let index = 0; index < tools.length; index++) {
        const spec = tools[index];
        unwrapped.push({
          id: `${toolCall.id}-unwrapped-${index}`,
          type: 'function',
          function: {
            name: spec.name,
            arguments: spec.arguments,
          },
        });
      }
    } else {
      unwrapped.push(toolCall);
    }
  }

  return unwrapped;
}
