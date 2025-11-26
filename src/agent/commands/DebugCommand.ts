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
import type { Agent } from '../Agent.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

/**
 * Timeline entry types for unified chronological display
 */
type TimelineEntry =
  | { type: 'log'; timestamp: number; data: LogEntry }
  | { type: 'message'; timestamp: number; data: Message }
  | { type: 'tool_call'; timestamp: number; data: ToolCallState };

export class DebugCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/debug',
    description: 'Show debug information',
    helpCategory: 'Core',
    subcommands: [
      { name: 'enable', description: 'Enable debug logging' },
      { name: 'disable', description: 'Disable debug logging' },
      { name: 'calls', description: 'Show recent tool calls' },
      { name: 'errors', description: 'Show failed tool calls' },
      { name: 'dump', description: 'Generate debug dump file' },
    ],
  };

  static {
    CommandRegistry.register(DebugCommand.metadata);
  }

  readonly name = DebugCommand.metadata.name;
  readonly description = DebugCommand.metadata.description;
  protected readonly useYellowOutput = DebugCommand.metadata.useYellowOutput ?? false;

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
  /debug enable        - Enable debug-level logging
  /debug disable       - Disable debug-level logging
  /debug calls [n]     - Show last N tool calls (default: ${BUFFER_SIZES.DEBUG_HISTORY_DEFAULT})
  /debug errors [n]    - Show last N failed tool calls (default: ${BUFFER_SIZES.DEBUG_HISTORY_DEFAULT})
  /debug dump [n]      - Dump debug info to file (last N entries, default: ${BUFFER_SIZES.MAX_LOG_BUFFER_SIZE})
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
        return this.handleDebugDump(
          serviceRegistry,
          parts.length > 1 ? parts[1] : undefined
        );

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
  private async handleDebugDump(
    serviceRegistry: ServiceRegistry,
    countStr: string | undefined
  ): Promise<CommandResult> {
    try {
      // Parse entry count (default to max buffer size)
      let maxEntries: number = BUFFER_SIZES.MAX_LOG_BUFFER_SIZE;

      if (countStr) {
        const parsed = parseInt(countStr, 10);

        if (isNaN(parsed) || parsed < 1) {
          return this.createError('Invalid count. Must be a positive number.');
        }

        maxEntries = parsed;
      }

      // Generate timestamp for filename
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5); // Remove milliseconds
      const filename = `codeally-debug-${timestamp}.txt`;
      const homeDir = os.homedir();
      const filepath = path.join(homeDir, filename);

      // Collect all data sources
      const logs = logger.getAllLogs();
      const toolCallHistory = serviceRegistry.getToolCallHistory();
      const allToolCalls = toolCallHistory?.getAll() || [];

      // Get conversation messages from agent
      const agent = serviceRegistry.get<Agent>('agent');
      const messages = agent?.getConversationManager().getMessages() || [];

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

      // Summary Statistics
      content += '━'.repeat(80) + '\n';
      content += 'SUMMARY\n';
      content += '━'.repeat(80) + '\n';
      content += `Total Entries: ${logs.length + messages.length + allToolCalls.length}\n`;
      content += `  Log Entries: ${logs.length}\n`;
      content += `  Messages: ${messages.length}\n`;
      content += `  Tool Calls: ${allToolCalls.length}\n\n`;

      // Message breakdown by role
      if (messages.length > 0) {
        const messagesByRole: { [key: string]: number } = {};
        for (const msg of messages) {
          messagesByRole[msg.role] = (messagesByRole[msg.role] || 0) + 1;
        }
        content += 'Messages by Role:\n';
        for (const role of Object.keys(messagesByRole).sort()) {
          content += `  ${role}: ${messagesByRole[role]}\n`;
        }
        content += '\n';
      }

      // Log breakdown by level
      if (logs.length > 0) {
        const logsByLevel: { [key: string]: number } = {};
        for (const log of logs) {
          const levelName = LogLevel[log.level];
          logsByLevel[levelName] = (logsByLevel[levelName] || 0) + 1;
        }
        content += 'Logs by Level:\n';
        for (const levelName of Object.keys(logsByLevel).sort()) {
          content += `  ${levelName}: ${logsByLevel[levelName]}\n`;
        }
        content += '\n';
      }

      // Tool call breakdown
      if (allToolCalls.length > 0) {
        const callsByTool: { [key: string]: number } = {};
        const errorsByTool: { [key: string]: number } = {};
        for (const call of allToolCalls) {
          callsByTool[call.toolName] = (callsByTool[call.toolName] || 0) + 1;
          if (call.status === 'error') {
            errorsByTool[call.toolName] = (errorsByTool[call.toolName] || 0) + 1;
          }
        }
        content += 'Tool Calls by Name:\n';
        for (const toolName of Object.keys(callsByTool).sort()) {
          const errorCount = errorsByTool[toolName] || 0;
          const errorInfo = errorCount > 0 ? ` (${errorCount} errors)` : '';
          content += `  ${toolName}: ${callsByTool[toolName]}${errorInfo}\n`;
        }
        content += '\n';
      }

      // Build unified chronological timeline
      content += '━'.repeat(80) + '\n';
      content += 'CHRONOLOGICAL TIMELINE (Logs + Messages + Tool Calls)\n';
      content += '━'.repeat(80) + '\n';

      const timeline = this.buildTimeline(logs, messages, allToolCalls, maxEntries);
      const totalEntries = logs.length + messages.length + allToolCalls.length;

      if (timeline.length < totalEntries) {
        content += `Showing last ${timeline.length} of ${totalEntries} total entries\n`;
      } else {
        content += `Showing all ${timeline.length} entries\n`;
      }
      content += '\n';

      if (timeline.length === 0) {
        content += 'No timeline entries found.\n\n';
      } else {
        for (const entry of timeline) {
          content += this.formatTimelineEntry(entry);
        }
      }

      // Write to file
      fs.writeFileSync(filepath, content, 'utf-8');

      const limitInfo = timeline.length < totalEntries
        ? ` (last ${timeline.length} of ${totalEntries} total entries)`
        : '';

      return {
        handled: true,
        response: `Debug dump written to: ${filepath}${limitInfo}\n\nContains:\n  - ${logs.length} log entries\n  - ${messages.length} conversation messages\n  - ${allToolCalls.length} tool calls\n  - System information`,
      };
    } catch (error) {
      return this.createError(
        `Failed to write debug dump: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Build a unified chronological timeline from logs, messages, and tool calls
   */
  private buildTimeline(
    logs: LogEntry[],
    messages: readonly Message[],
    toolCalls: ToolCallState[],
    maxEntries: number
  ): TimelineEntry[] {
    const timeline: TimelineEntry[] = [];

    // Add logs
    for (const log of logs) {
      timeline.push({ type: 'log', timestamp: log.timestamp, data: log });
    }

    // Add messages
    for (const msg of messages) {
      if (msg.timestamp) {
        timeline.push({ type: 'message', timestamp: msg.timestamp, data: msg });
      }
    }

    // Add tool calls
    for (const call of toolCalls) {
      timeline.push({ type: 'tool_call', timestamp: call.startTime, data: call });
    }

    // Sort chronologically
    timeline.sort((a, b) => a.timestamp - b.timestamp);

    // Return last N entries if limit specified
    if (maxEntries > 0 && timeline.length > maxEntries) {
      return timeline.slice(-maxEntries);
    }

    return timeline;
  }

  /**
   * Format a timeline entry based on its type
   */
  private formatTimelineEntry(entry: TimelineEntry): string {
    const date = new Date(entry.timestamp);
    const isoTime = date.toISOString();

    switch (entry.type) {
      case 'log':
        return this.formatLogEntry(isoTime, entry.data);
      case 'message':
        return this.formatMessageEntry(isoTime, entry.data);
      case 'tool_call':
        return this.formatToolCallEntry(isoTime, entry.data);
    }
  }

  /**
   * Format a log entry
   */
  private formatLogEntry(isoTime: string, log: LogEntry): string {
    const levelName = LogLevel[log.level].padEnd(7);
    return `[${isoTime}] [${levelName}] ${log.message}\n`;
  }

  /**
   * Format a conversation message entry
   */
  private formatMessageEntry(isoTime: string, msg: Message): string {
    let output = '';
    const roleUpper = msg.role.toUpperCase().padEnd(9);

    // Calculate indentation based on timestamp format: "[YYYY-MM-DDTHH:MM:SS.sssZ] "
    // ISO timestamp is always 24 chars, plus "[" and "] " = 27 chars total
    const indent = ' '.repeat(27);

    output += `[${isoTime}] ┌─ ${roleUpper}`;

    // Add message ID if present
    if (msg.id) {
      output += ` (${msg.id.substring(0, 8)})`;
    }
    output += '\n';

    // Show tool calls if present
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      output += `${indent}│ Tool Calls: ${msg.tool_calls.length}\n`;
      for (const toolCall of msg.tool_calls) {
        const argsStr = this.formatJSON(toolCall.function.arguments);
        const truncatedArgs = this.truncateString(argsStr, 100);
        output += `${indent}│   - ${toolCall.function.name}(${truncatedArgs})\n`;
      }
    }

    // Show tool_call_id if present (for tool result messages)
    if (msg.tool_call_id) {
      output += `${indent}│ Tool Call ID: ${msg.tool_call_id}\n`;
    }

    // Show name if present (for tool messages)
    if (msg.name) {
      output += `${indent}│ Tool: ${msg.name}\n`;
    }

    // Show thinking if present
    if (msg.thinking) {
      const thinkingPreview = this.truncateString(msg.thinking, 100);
      output += `${indent}│ Thinking: ${thinkingPreview}\n`;
    }

    // Show content
    const contentPreview = this.truncateString(msg.content, 500);
    const lines = contentPreview.split('\n');

    if (lines.length === 1 && lines[0] && lines[0].length < 80) {
      // Short single-line content
      output += `${indent}│ ${lines[0]}\n`;
    } else {
      // Multi-line or long content
      output += `${indent}│ Content:\n`;
      for (const line of lines) {
        if (line) {
          output += `${indent}│   ${line}\n`;
        }
      }
    }

    // Show truncation indicator
    if (msg.content.length > 500) {
      output += `${indent}│   ... (${msg.content.length} chars total)\n`;
    }

    // Show metadata if present
    if (msg.metadata?.ephemeral) {
      output += `${indent}│ [Ephemeral]\n`;
    }
    if (msg.metadata?.isCommandResponse) {
      output += `${indent}│ [Command Response]\n`;
    }

    output += `${indent}└─\n`;

    return output;
  }

  /**
   * Format a tool call entry
   */
  private formatToolCallEntry(isoTime: string, call: ToolCallState): string {
    let output = '';

    // Calculate indentation based on timestamp format: "[YYYY-MM-DDTHH:MM:SS.sssZ] "
    // ISO timestamp is always 24 chars, plus "[" and "] " = 27 chars total
    const indent = ' '.repeat(27);

    const statusIcon = call.status === 'success' ? '✓' : call.status === 'error' ? '✗' : '○';
    const duration = call.endTime ? `${call.endTime - call.startTime}ms` : 'running';

    output += `[${isoTime}] ┌─ TOOL CALL: ${call.toolName} ${statusIcon} (${duration})\n`;

    // Show arguments
    const argsStr = this.formatJSON(call.arguments);
    const argLines = argsStr.split('\n');
    output += `${indent}│ Arguments:\n`;
    for (const line of argLines.slice(0, 5)) {
      if (line) {
        output += `${indent}│   ${line}\n`;
      }
    }
    if (argLines.length > 5) {
      output += `${indent}│   ... (${argLines.length - 5} more lines)\n`;
    }

    // Show error if present
    if (call.error) {
      const errorPreview = this.truncateString(call.error, 200);
      output += `${indent}│ Error: ${errorPreview}\n`;
    }

    // Show output preview
    if (call.output) {
      const outputPreview = this.truncateString(call.output, 200);
      output += `${indent}│ Output: ${outputPreview}\n`;
      if (call.output.length > 200) {
        output += `${indent}│   ... (${call.output.length} chars total)\n`;
      }
    }

    output += `${indent}└─\n`;

    return output;
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
