/**
 * KillShellTool - Terminate background bash processes
 *
 * Kills processes started with bash(run_in_background=true).
 * Sends specified signal (default SIGTERM) to the process and removes it from tracking.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { BashProcessManager } from '../services/BashProcessManager.js';
import { formatDuration } from '../ui/utils/timeUtils.js';

export class KillShellTool extends BaseTool {
  readonly name = 'kill-shell';
  readonly description = 'Terminate a background bash process';
  readonly requiresConfirmation = false;
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
            signal: {
              type: 'string',
              description: 'Signal to send to the process (default: SIGTERM). Common options: SIGTERM, SIGKILL, SIGINT',
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
    const signal = (args.signal as string) || 'SIGTERM';

    if (!shellId) {
      return this.formatErrorResponse(
        'shell_id parameter is required',
        'validation_error',
        'Example: kill-shell(shell_id="shell-1234567890-abc123")'
      );
    }

    // Validate signal
    const validSignals = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT'];
    if (!validSignals.includes(signal)) {
      return this.formatErrorResponse(
        `Invalid signal: ${signal}`,
        'validation_error',
        `Valid signals: ${validSignals.join(', ')}`
      );
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

    // Get process info before killing (for response metadata)
    const processInfo = processManager.getProcess(shellId);

    if (!processInfo) {
      return this.formatErrorResponse(
        `Background shell ${shellId} not found`,
        'user_error',
        'Check shell IDs in system reminders. The process may have already exited.'
      );
    }

    // Check if already exited
    if (processInfo.exitCode !== null) {
      return this.formatErrorResponse(
        `Background shell ${shellId} already exited with code ${processInfo.exitCode}`,
        'user_error',
        'The process has already terminated. Use bash-output to read final output.'
      );
    }

    // Calculate elapsed time
    const elapsed = formatDuration(Date.now() - processInfo.startTime);

    // Kill the process
    const killed = processManager.killProcess(shellId, signal as NodeJS.Signals);

    if (!killed) {
      return this.formatErrorResponse(
        `Failed to kill background shell ${shellId}`,
        'system_error',
        'The process may have already exited or cannot be killed.'
      );
    }

    return this.formatSuccessResponse({
      content: `Killed background shell ${shellId} (${signal})`,
      shell_id: shellId,
      pid: processInfo.pid,
      command: processInfo.command,
      signal,
      elapsed,
    });
  }

  /**
   * Format subtext for display in UI
   */
  formatSubtext(args: Record<string, any>): string | null {
    const shellId = args.shell_id as string;
    const signal = (args.signal as string) || 'SIGTERM';

    if (!shellId) return null;

    // Shorten shell ID for display (show first 8 chars after "shell-")
    const shortId = shellId.startsWith('shell-')
      ? shellId.substring(6, 14)
      : shellId;

    if (signal !== 'SIGTERM') {
      return `${shortId} - ${signal}`;
    }

    return shortId;
  }

  /**
   * Get parameters shown in subtext
   */
  getSubtextParameters(): string[] {
    return ['shell_id', 'signal'];
  }
}
