/**
 * DebugCommand - Debug tool call history
 *
 * Provides subcommands for viewing recent tool calls and their details.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { ToolCallHistory } from '@services/ToolCallHistory.js';
import type { ToolCallState } from '@shared/index.js';
import { logger } from '@services/Logger.js';
import { LogLevel } from '@services/Logger.js';

export class DebugCommand extends Command {
  readonly name = '/debug';
  readonly description = 'Debug commands';

  // Don't use yellow output for multi-line debug display
  protected readonly useYellowOutput = false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    // No args → show usage
    if (!argString) {
      return {
        handled: true,
        response: `Debug Commands:
  /debug enable    - Enable debug-level logging
  /debug disable   - Disable debug-level logging
  /debug calls [n] - Show last N tool calls (default: 5)
`,
      };
    }

    // Parse subcommand
    const parts = argString.split(/\s+/);
    const subcommand = parts[0];

    if (!subcommand) {
      return this.createError('Invalid debug command');
    }

    // Route to subcommand handlers
    switch (subcommand.toLowerCase()) {
      case 'enable':
        return this.handleDebugEnable();

      case 'disable':
        return this.handleDebugDisable();

      case 'calls':
        const toolCallHistory = serviceRegistry.getToolCallHistory();
        if (!toolCallHistory) {
          return this.createError('Tool call history not available');
        }
        return this.handleDebugCalls(
          toolCallHistory,
          parts.length > 1 ? parts[1] : undefined
        );

      default:
        return this.createError(
          `Unknown debug subcommand: ${subcommand}. Available: enable, disable, calls`
        );
    }
  }

  /**
   * Enable debug-level logging
   */
  private async handleDebugEnable(): Promise<CommandResult> {
    logger.setLevel(LogLevel.DEBUG);
    return {
      handled: true,
      response: 'Debug logging enabled. Use /debug disable to turn it off.',
    };
  }

  /**
   * Disable debug-level logging (reset to INFO)
   */
  private async handleDebugDisable(): Promise<CommandResult> {
    logger.setLevel(LogLevel.INFO);
    return {
      handled: true,
      response: 'Debug logging disabled.',
    };
  }

  /**
   * Show the last N tool calls
   */
  private async handleDebugCalls(
    toolCallHistory: ToolCallHistory,
    countStr: string | undefined
  ): Promise<CommandResult> {
    // Default to 5 if not specified
    let count = 5;

    if (countStr) {
      const parsed = parseInt(countStr, 10);

      if (isNaN(parsed) || parsed < 1) {
        return this.createError('Invalid count. Must be a positive number.');
      }

      count = parsed;
    }

    const totalCount = toolCallHistory.getCount();

    // Handle no history
    if (totalCount === 0) {
      return {
        handled: true,
        response: 'No tool call history available.',
      };
    }

    // Get the last N calls
    const calls = toolCallHistory.getLastN(count);
    const actualCount = calls.length;

    // Build output
    let output = `Tool Call History (Last ${actualCount} call${actualCount !== 1 ? 's' : ''})\n`;
    output += '━'.repeat(60) + '\n';

    // Format each call (in reverse order - most recent first)
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i];
      if (!call) continue; // Safety check
      const callNumber = calls.length - i;

      output += this.formatToolCall(call, callNumber);

      // Add separator between calls (but not after last one)
      if (i > 0) {
        output += '━'.repeat(60) + '\n';
      }
    }

    return {
      handled: true,
      response: output,
    };
  }

  /**
   * Format a single tool call for display
   */
  private formatToolCall(call: ToolCallState, callNumber: number): string {
    let output = '';

    // Header with tool name and relative time
    const timeAgo = this.formatTimeAgo(call.endTime || call.startTime);
    output += `#${callNumber} - ${call.toolName} (${timeAgo})\n`;

    // Status
    const statusDisplay =
      call.status === 'error' ? `error${call.error_type ? ` (${call.error_type})` : ''}` : call.status;
    output += `Status: ${statusDisplay}\n`;

    // Duration
    if (call.endTime && call.startTime) {
      const duration = call.endTime - call.startTime;
      output += `Duration: ${duration}ms\n`;
    }

    output += '\n';

    // Parameters
    output += 'Parameters:\n';
    const formattedParams = this.formatJSON(call.arguments);
    output += formattedParams + '\n\n';

    // Output (if available)
    if (call.output) {
      const truncated = this.truncateString(call.output, 500);
      const charCount = call.output.length;

      if (charCount > 500) {
        output += `Output: (${charCount} chars, showing first 500)\n`;
      } else {
        output += 'Output:\n';
      }

      output += truncated + '\n\n';
    }

    // Error message (if error status)
    if (call.error) {
      output += 'Error:\n';
      output += call.error + '\n\n';
    }

    return output;
  }

  /**
   * Format JSON with truncation if needed
   */
  private formatJSON(obj: any): string {
    try {
      const json = JSON.stringify(obj, null, 2);
      return this.truncateString(json, 500);
    } catch {
      return String(obj);
    }
  }

  /**
   * Truncate string to max length with ellipsis
   */
  private truncateString(str: string, maxLength: number): string {
    if (str.length <= maxLength) {
      return str;
    }
    return str.substring(0, maxLength) + '...';
  }

  /**
   * Format timestamp as relative time (e.g., "2 seconds ago")
   */
  private formatTimeAgo(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days} day${days !== 1 ? 's' : ''} ago`;
    } else if (hours > 0) {
      return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    } else if (minutes > 0) {
      return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    } else if (seconds > 0) {
      return `${seconds} second${seconds !== 1 ? 's' : ''} ago`;
    } else {
      return 'just now';
    }
  }
}
