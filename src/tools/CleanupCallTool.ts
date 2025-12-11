/**
 * CleanupCallTool - Remove tool result messages from conversation
 *
 * Allows the LLM to clean up tool results that are no longer needed in the
 * conversation context, helping manage context window usage.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { formatError } from '../utils/errorUtils.js';
import { UI_COLORS } from '../ui/constants/colors.js';

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
  readonly visibleInChat = true; // Show as a notice in chat
  readonly hideOutput = true; // Hide detailed output
  readonly breaksExploratoryStreak = false; // Part of cleanup → explore workflow

  // Custom display: meta tool notice with sparkle icon
  readonly displayColor = UI_COLORS.META;
  readonly displayIcon = '✦';
  readonly hideToolName = true; // Show only the subtext message

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
   * Format subtext for display - shows cleanup summary
   */
  formatSubtext(_args: Record<string, any>, result?: any): string | null {
    if (!result) {
      return 'Cleaning up...';
    }
    const count = (result.immediate_count ?? 0) + (result.queued_count ?? 0);
    if (count === 0) {
      return null; // Don't show if nothing was cleaned
    }
    return `Ally cleaned up ${count} tool call${count !== 1 ? 's' : ''}.`;
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

      // Get conversation manager
      const conversationManager = agent.getConversationManager();
      if (!conversationManager) {
        return this.formatErrorResponse(
          'ConversationManager not available',
          'system_error'
        );
      }

      // Partition IDs into current turn and prior turns
      const { currentTurn, priorTurns } = conversationManager.partitionByTurn(toolCallIds);

      // Calculate not found IDs
      const validIds = [...currentTurn, ...priorTurns];
      const notFoundIds = toolCallIds.filter((id: string) => !validIds.includes(id));

      // Immediately remove prior-turn results
      let immediateResult = { removed_count: 0, removed_ids: [], not_found_ids: [] };
      if (priorTurns.length > 0) {
        immediateResult = conversationManager.removeToolResults(priorTurns);
      }

      // Queue current-turn results for deferred cleanup
      if (currentTurn.length > 0) {
        agent.queueCleanup(currentTurn);
      }

      // Format success response
      const totalCleaned = immediateResult.removed_count + currentTurn.length;
      let message = '';

      if (totalCleaned === 0) {
        message = 'No tool results were cleaned up. All provided IDs were not found in the conversation.';
      } else {
        message = `Cleaned up ${totalCleaned} tool result(s):\n`;
        message += `  - ${immediateResult.removed_count} removed immediately (prior turns)\n`;
        message += `  - ${currentTurn.length} queued for end of turn (current turn)`;

        if (immediateResult.removed_count > 0) {
          message += `\n\nRemoved immediately:\n${immediateResult.removed_ids.map((id: string) => `  - ${id}`).join('\n')}`;
        }

        if (currentTurn.length > 0) {
          message += `\n\nQueued for end of turn:\n${currentTurn.map((id: string) => `  - ${id}`).join('\n')}`;
        }
      }

      if (notFoundIds.length > 0) {
        message += `\n\nTool call IDs not found in conversation:\n${notFoundIds.map((id: string) => `  - ${id}`).join('\n')}`;
      }

      return this.formatSuccessResponse({
        content: message,
        immediate_count: immediateResult.removed_count,
        immediate_ids: immediateResult.removed_ids,
        queued_count: currentTurn.length,
        queued_ids: currentTurn,
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
