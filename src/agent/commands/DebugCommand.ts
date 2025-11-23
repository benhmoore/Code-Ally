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
import { logger, LogLevel, type LogEntry } from '@services/Logger.js';
import { BUFFER_SIZES } from '@config/constants.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  /debug enable     - Enable debug-level logging
  /debug disable    - Disable debug-level logging
  /debug calls [n]  - Show last N tool calls (default: ${BUFFER_SIZES.DEBUG_HISTORY_DEFAULT})
  /debug errors [n] - Show last N failed tool calls (default: ${BUFFER_SIZES.DEBUG_HISTORY_DEFAULT})
  /debug dump       - Dump all debug information to a timestamped file in home directory
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

      case 'errors':
        const errorToolCallHistory = serviceRegistry.getToolCallHistory();
        if (!errorToolCallHistory) {
          return this.createError('Tool call history not available');
        }
        return this.handleDebugErrors(
          errorToolCallHistory,
          parts.length > 1 ? parts[1] : undefined
        );

      case 'dump':
        return this.handleDebugDump(serviceRegistry);

      default:
        return this.createError(
          `Unknown debug subcommand: ${subcommand}. Available: enable, disable, calls, errors, dump`
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
    // Use configured default if not specified
    let count: number = BUFFER_SIZES.DEBUG_HISTORY_DEFAULT;

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
   * Show the last N failed tool calls (errors only)
   */
  private async handleDebugErrors(
    toolCallHistory: ToolCallHistory,
    countStr: string | undefined
  ): Promise<CommandResult> {
    // Use configured default if not specified
    let count: number = BUFFER_SIZES.DEBUG_HISTORY_DEFAULT;

    if (countStr) {
      const parsed = parseInt(countStr, 10);

      if (isNaN(parsed) || parsed < 1) {
        return this.createError('Invalid count. Must be a positive number.');
      }

      count = parsed;
    }

    // Get all calls and filter to errors only
    const allCalls = toolCallHistory.getAll();
    const errorCalls = allCalls.filter(call => call.status === 'error');
    const totalErrorCount = errorCalls.length;

    // Handle no errors
    if (totalErrorCount === 0) {
      return {
        handled: true,
        response: 'No failed tool calls in history.',
      };
    }

    // Get the last N error calls
    const calls = errorCalls.slice(-count);
    const actualCount = calls.length;

    // Build output
    let output = `Failed Tool Calls (Last ${actualCount} error${actualCount !== 1 ? 's' : ''}`;
    if (totalErrorCount > actualCount) {
      output += ` of ${totalErrorCount} total`;
    }
    output += ')\n';
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
   * Dump all debug information to a file
   */
  private async handleDebugDump(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    try {
      // Generate timestamp for filename
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5); // Remove milliseconds
      const filename = `codeally-debug-${timestamp}.txt`;
      const homeDir = os.homedir();
      const filepath = path.join(homeDir, filename);

      // Build debug dump content
      let content = '';

      // Header
      content += '='.repeat(80) + '\n';
      content += 'CodeAlly Debug Dump\n';
      content += `Generated: ${now.toLocaleString()}\n`;
      content += `Timestamp: ${now.toISOString()}\n`;
      content += '='.repeat(80) + '\n\n';

      // System Information
      content += '━'.repeat(80) + '\n';
      content += 'SYSTEM INFORMATION\n';
      content += '━'.repeat(80) + '\n';
      content += `Platform: ${os.platform()}\n`;
      content += `Architecture: ${os.arch()}\n`;
      content += `Node Version: ${process.version}\n`;
      content += `Memory Usage: ${JSON.stringify(process.memoryUsage(), null, 2)}\n`;
      content += `Current Log Level: ${LogLevel[logger.getLevel()]}\n`;
      content += '\n';

      // Log Buffer
      content += '━'.repeat(80) + '\n';
      content += 'LOG BUFFER\n';
      content += '━'.repeat(80) + '\n';
      const logs = logger.getAllLogs();
      content += `Total log entries: ${logs.length}\n\n`;

      if (logs.length > 0) {
        // Group logs by level
        const logsByLevel: { [key: string]: LogEntry[] } = {};
        for (const log of logs) {
          const levelName = LogLevel[log.level];
          if (!logsByLevel[levelName]) {
            logsByLevel[levelName] = [];
          }
          logsByLevel[levelName].push(log);
        }

        // Display summary
        content += 'Log Summary by Level:\n';
        for (const levelName of Object.keys(logsByLevel).sort()) {
          const levelLogs = logsByLevel[levelName];
          if (levelLogs) {
            content += `  ${levelName}: ${levelLogs.length} entries\n`;
          }
        }
        content += '\n';

        // Display all logs chronologically
        content += 'All Log Entries (chronological):\n';
        content += '-'.repeat(80) + '\n';
        for (const log of logs) {
          const date = new Date(log.timestamp);
          const levelName = LogLevel[log.level].padEnd(7);
          content += `[${date.toISOString()}] [${levelName}] ${log.message}\n`;
        }
      } else {
        content += 'No log entries found.\n';
      }
      content += '\n';

      // Tool Call History
      content += '━'.repeat(80) + '\n';
      content += 'TOOL CALL HISTORY\n';
      content += '━'.repeat(80) + '\n';

      const toolCallHistory = serviceRegistry.getToolCallHistory();
      if (toolCallHistory) {
        const allCalls = toolCallHistory.getAll();
        content += `Total tool calls: ${allCalls.length}\n\n`;

        if (allCalls.length > 0) {
          // Summary by tool name
          const callsByTool: { [key: string]: number } = {};
          const errorsByTool: { [key: string]: number } = {};
          for (const call of allCalls) {
            callsByTool[call.toolName] = (callsByTool[call.toolName] || 0) + 1;
            if (call.status === 'error') {
              errorsByTool[call.toolName] = (errorsByTool[call.toolName] || 0) + 1;
            }
          }

          content += 'Tool Call Summary:\n';
          for (const toolName of Object.keys(callsByTool).sort()) {
            const errorCount = errorsByTool[toolName] || 0;
            const errorInfo = errorCount > 0 ? ` (${errorCount} errors)` : '';
            content += `  ${toolName}: ${callsByTool[toolName]} calls${errorInfo}\n`;
          }
          content += '\n';

          // Detailed call history
          content += 'Detailed Call History:\n';
          content += '-'.repeat(80) + '\n';
          for (let i = 0; i < allCalls.length; i++) {
            const call = allCalls[i];
            if (!call) continue;

            content += `#${i + 1} - ${call.toolName}\n`;
            content += `  Status: ${call.status}\n`;
            content += `  Started: ${new Date(call.startTime).toISOString()}\n`;
            if (call.endTime) {
              const duration = call.endTime - call.startTime;
              content += `  Duration: ${duration}ms\n`;
            }
            if (call.error) {
              content += `  Error: ${call.error}\n`;
            }
            content += `  Arguments: ${JSON.stringify(call.arguments, null, 2)}\n`;
            if (call.output && call.output.length > 500) {
              content += `  Output: ${call.output.substring(0, 500)}... (truncated, ${call.output.length} chars total)\n`;
            } else if (call.output) {
              content += `  Output: ${call.output}\n`;
            }
            content += '\n';
          }
        } else {
          content += 'No tool calls recorded.\n\n';
        }
      } else {
        content += 'Tool call history not available.\n\n';
      }

      // Write to file
      fs.writeFileSync(filepath, content, 'utf-8');

      return {
        handled: true,
        response: `Debug dump written to: ${filepath}\n\nContains:\n  - ${logs.length} log entries\n  - ${toolCallHistory?.getCount() || 0} tool calls\n  - System information`,
      };
    } catch (error) {
      return this.createError(
        `Failed to write debug dump: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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

    // Error message (if error status) - show first for visibility
    if (call.error) {
      output += 'Error';
      if (call.error_type) {
        output += ` (${call.error_type})`;
      }
      output += ':\n';

      // Use structured error message if available, otherwise fall back to formatted error
      const errorMessage = call.result?.error_details?.message || call.error;
      output += errorMessage + '\n\n';
    }

    // Output (show for both success and error - useful for debugging failed tools)
    if (call.output) {
      const truncated = this.truncateString(call.output, 1000);
      const charCount = call.output.length;

      if (charCount > 1000) {
        output += `Output: (${charCount} chars, showing first 1000)\n`;
      } else {
        output += 'Output:\n';
      }

      output += truncated + '\n\n';
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
