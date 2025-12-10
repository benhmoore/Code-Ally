/**
 * BashOutputTool - Read output from background bash processes
 *
 * Retrieves buffered output from processes started with bash(run_in_background=true).
 * Supports optional regex filtering to show only matching lines.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { BashProcessManager } from '../services/BashProcessManager.js';
import { formatError } from '../utils/errorUtils.js';

export class BashOutputTool extends BaseTool {
  readonly name = 'bash-output';
  readonly description = 'Read output from a background bash process';
  readonly requiresConfirmation = false; // Read-only operation
  readonly hideOutput = false;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            shell_id: {
              type: 'string',
              description: 'Shell ID returned from bash(run_in_background=true)',
            },
            filter: {
              type: 'string',
              description: 'Optional regex pattern to filter output lines. Only lines matching this pattern will be returned.',
            },
            lines: {
              type: 'integer',
              description: 'Number of lines to return from the end of output (default: 20, use -1 for all lines)',
            },
          },
          required: ['shell_id'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const shellId = args.shell_id as string;
    const filterPattern = args.filter as string | undefined;
    const linesParam = args.lines as number | undefined;

    // Default to 20 lines, -1 means all lines
    const lineCount = linesParam === -1 ? undefined : (linesParam ?? 20);

    if (!shellId) {
      return this.formatErrorResponse(
        'shell_id parameter is required',
        'validation_error',
        'Example: bash-output(shell_id="shell-1234567890-abc123")'
      );
    }

    // Validate regex pattern if provided
    let filterRegex: RegExp | undefined;
    if (filterPattern) {
      try {
        filterRegex = new RegExp(filterPattern);
      } catch (error) {
        return this.formatErrorResponse(
          `Invalid regex pattern: ${formatError(error)}`,
          'validation_error',
          'Example: bash-output(bash_id="shell-123", filter="ERROR.*")'
        );
      }
    }

    // Get process manager from registry
    const registry = ServiceRegistry.getInstance();
    const processManager = registry.get<BashProcessManager>('bash_process_manager');

    if (!processManager) {
      return this.formatErrorResponse(
        'BashProcessManager not available',
        'system_error'
      );
    }

    // Get process info
    const processInfo = processManager.getProcess(shellId);

    if (!processInfo) {
      return this.formatErrorResponse(
        `Background shell ${shellId} not found`,
        'user_error',
        'Use bash(run_in_background=true) to start a background process. Check shell IDs in system reminders.'
      );
    }

    // Read output from buffer
    const lines = processInfo.outputBuffer.getLines(lineCount, filterRegex);
    const output = lines.join('\n');

    // Build status information
    const isRunning = processInfo.exitCode === null;
    const status = isRunning
      ? 'running'
      : `exited with code ${processInfo.exitCode}`;

    const returnedLineCount = lines.length;
    const totalBufferSize = processInfo.outputBuffer.size();

    // Format response with optional filter_applied field
    return this.formatSuccessResponse({
      content: output || '(no output)',
      shell_id: shellId,
      pid: processInfo.pid,
      command: processInfo.command,
      status,
      output_lines: returnedLineCount,
      total_buffer_lines: totalBufferSize,
      ...(filterPattern ? { filter_applied: filterPattern } : {}),
    });
  }

  /**
   * Format subtext for display in UI
   */
  formatSubtext(args: Record<string, any>): string | null {
    const shellId = args.shell_id as string;
    const filter = args.filter as string | undefined;

    if (!shellId) return null;

    // Shorten shell ID for display (show first 8 chars after "shell-")
    const shortId = shellId.startsWith('shell-')
      ? shellId.substring(6, 14)
      : shellId;

    if (filter) {
      return `${shortId} - filter: ${filter}`;
    }

    return shortId;
  }

  /**
   * Get parameters shown in subtext
   */
  getSubtextParameters(): string[] {
    return ['shell_id', 'filter'];
  }
}
