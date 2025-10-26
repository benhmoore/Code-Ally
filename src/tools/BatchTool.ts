/**
 * BatchTool - Execute multiple tools concurrently in a single call
 *
 * Workaround for models that don't support returning multiple tool_calls
 * in a single response. This tool accepts an array of tool specifications
 * and executes them concurrently using the ToolOrchestrator.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { BUFFER_SIZES } from '../config/constants.js';

export class BatchTool extends BaseTool {
  readonly name = 'batch';
  readonly description =
    `Execute multiple tools concurrently in a single call. Use this when you need to run several independent operations in parallel (e.g., reading multiple files, running multiple searches). Each tool in the batch runs simultaneously for better performance. IMPORTANT: Maximum ${BUFFER_SIZES.MAX_BATCH_SIZE} tools per batch.`;
  readonly requiresConfirmation = false; // Individual tools will handle their own confirmation
  readonly visibleInChat = false; // Don't show batch() in conversation, only its children
  readonly isTransparentWrapper = true; // Promote children to replace wrapper

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Provide custom function definition
   */
  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              description: `Array of tool specifications to execute concurrently (max ${BUFFER_SIZES.MAX_BATCH_SIZE}). Each spec must have "name" and "arguments" fields.`,
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Name of the tool to execute',
                  },
                  arguments: {
                    type: 'object',
                    description: 'Arguments to pass to the tool',
                  },
                },
                required: ['name', 'arguments'],
              },
            },
          },
          required: ['tools'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const toolSpecs = args.tools;

    // Validate tools parameter
    if (!Array.isArray(toolSpecs) || toolSpecs.length === 0) {
      return this.formatErrorResponse(
        'tools parameter is required and must contain at least one tool specification',
        'validation_error',
        'Example: batch(tools=[{"name": "read", "arguments": {"file_path": "README.md"}}, {"name": "read", "arguments": {"file_path": "package.json"}}])'
      );
    }

    // Enforce maximum batch size
    if (toolSpecs.length > BUFFER_SIZES.MAX_BATCH_SIZE) {
      return this.formatErrorResponse(
        `Too many tools in batch: ${toolSpecs.length} requested, maximum is ${BUFFER_SIZES.MAX_BATCH_SIZE}. Split your request into smaller batches.`,
        'validation_error',
        'Break your batch into smaller groups with 5 or fewer tool calls each.'
      );
    }

    // Validate all tool specs
    for (let i = 0; i < toolSpecs.length; i++) {
      const validationError = this.validateToolSpec(toolSpecs[i], i);
      if (validationError) {
        return this.formatErrorResponse(validationError, 'validation_error');
      }
    }

    // NOTE: BatchTool is a transparent wrapper.
    // The actual execution is handled by ToolOrchestrator which unwraps batch calls
    // and executes child tools directly. This executeImpl is called for validation
    // and to provide a result message, but the real work happens in the orchestrator.

    return this.formatSuccessResponse({
      content: `Batch execution: ${toolSpecs.length} tool${toolSpecs.length !== 1 ? 's' : ''} executed concurrently`,
      tools_executed: toolSpecs.length,
    });
  }

  /**
   * Validate a single tool specification
   */
  private validateToolSpec(spec: any, index: number): string | null {
    if (typeof spec !== 'object' || spec === null) {
      return `Tool ${index} must be an object with "name" and "arguments" fields`;
    }

    if (!spec.name || typeof spec.name !== 'string') {
      return `Tool ${index} missing required field: name (must be a string)`;
    }

    if (!spec.arguments || typeof spec.arguments !== 'object') {
      return `Tool ${index} missing required field: arguments (must be an object)`;
    }

    return null;
  }

  // No custom result preview needed - BatchTool is transparent and won't be displayed
}
