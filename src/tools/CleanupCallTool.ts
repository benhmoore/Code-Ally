/**
 * CleanupCallTool - Remove tool result messages from conversation
 *
 * Allows the LLM to clean up tool results that are no longer needed in the
 * conversation context, helping manage context window usage.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, Message } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { formatError } from '../utils/errorUtils.js';

/**
 * Tool for removing tool result messages from conversation history
 *
 * This tool allows the LLM to clean up tool results that are no longer
 * needed, helping to manage the context window more efficiently.
 *
 * Example usage:
 * - After reviewing file contents and extracting needed information
 * - After exploring many files and retaining only the summary
 * - When tool results are large but conclusions are simple
 */
export class CleanupCallTool extends BaseTool {
  readonly name = 'cleanup-call';
  readonly description =
    'Remove tool result messages from conversation to free up context space. Useful for cleaning up large tool outputs after extracting the needed information.';
  readonly requiresConfirmation = false;
  readonly visibleInChat = true;
  readonly hideOutput = true; // Show tool call but hide output details

  /**
   * Usage guidance for LLM on when/how to use this tool
   */
  readonly usageGuidance = `
Use cleanup-call to remove tool results from conversation when:
- You've extracted the needed information from large tool outputs
- Tool results are taking up context space but no longer needed
- You want to retain conclusions but not the full output

Example:
1. Read multiple files to understand a feature
2. Extract key insights and summarize
3. Use cleanup-call to remove the file contents, keeping only your summary
`.trim();

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Get function definition for Claude API
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
            tool_call_ids: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Array of tool call IDs to remove results for. These are the IDs from previous tool calls whose results should be cleaned up.',
            },
          },
          required: ['tool_call_ids'],
        },
      },
    };
  }

  /**
   * Execute the cleanup operation
   *
   * @param args - Tool arguments containing tool_call_ids array
   * @returns Result with removal counts and IDs
   */
  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    // Validate tool_call_ids parameter
    const toolCallIds = args.tool_call_ids;

    if (!Array.isArray(toolCallIds)) {
      return this.formatErrorResponse(
        'tool_call_ids must be an array',
        'validation_error'
      );
    }

    if (toolCallIds.length === 0) {
      return this.formatErrorResponse(
        'tool_call_ids array cannot be empty',
        'validation_error'
      );
    }

    // Validate each ID is a string
    for (let i = 0; i < toolCallIds.length; i++) {
      if (typeof toolCallIds[i] !== 'string') {
        return this.formatErrorResponse(
          `tool_call_ids[${i}]: must be a string`,
          'validation_error'
        );
      }
    }

    try {
      // Get Agent from ServiceRegistry
      const registry = ServiceRegistry.getInstance();
      const agent = registry.get<any>('agent');

      if (!agent) {
        return this.formatErrorResponse(
          'Agent not available',
          'system_error'
        );
      }

      // Validate IDs exist in conversation before queuing
      const conversationManager = agent.getConversationManager();
      if (!conversationManager) {
        return this.formatErrorResponse(
          'ConversationManager not available',
          'system_error'
        );
      }

      // Check which IDs exist (don't remove yet, just validate)
      const messages = conversationManager.getMessages();
      const existingIds = new Set(
        messages
          .filter((msg: Message) => msg.role === 'tool' && msg.tool_call_id)
          .map((msg: Message) => msg.tool_call_id as string)
      );

      const validIds: string[] = [];
      const notFoundIds: string[] = [];

      for (const id of toolCallIds) {
        if (existingIds.has(id)) {
          validIds.push(id);
        } else {
          notFoundIds.push(id);
        }
      }

      // Queue valid IDs for cleanup at end of turn
      if (validIds.length > 0) {
        agent.queueCleanup(validIds);
      }

      // Format success response
      let message = `Queued ${validIds.length} tool result(s) for cleanup at end of turn.`;

      if (validIds.length > 0) {
        message += `\n\nQueued for cleanup:\n${validIds.map(id => `  - ${id}`).join('\n')}`;
      }

      if (notFoundIds.length > 0) {
        message += `\n\nTool call IDs not found in conversation:\n${notFoundIds.map(id => `  - ${id}`).join('\n')}`;
      }

      if (validIds.length === 0) {
        message = 'No tool results were queued for cleanup. All provided IDs were not found in the conversation.';
      } else {
        message += '\n\nThese results will be removed from context after this response completes.';
      }

      return this.formatSuccessResponse({
        content: message,
        queued_count: validIds.length,
        queued_ids: validIds,
        not_found_ids: notFoundIds,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error queueing cleanup: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
