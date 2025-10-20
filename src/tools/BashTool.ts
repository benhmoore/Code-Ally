/**
 * BashTool - Execute shell commands safely
 *
 * Executes bash commands with timeout, streaming output, and security validation.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { spawn, ChildProcess } from 'child_process';
import { generateId } from '../utils/id.js';

export class BashTool extends BaseTool {
  readonly name = 'bash';
  readonly description =
    'Execute shell commands. Use this for running bash commands, installing packages, running tests, etc. Output is streamed in real-time.';
  readonly requiresConfirmation = true; // Destructive operations require confirmation

  private static readonly DEFAULT_TIMEOUT = 5000; // 5 seconds
  private static readonly MAX_TIMEOUT = 60000; // 60 seconds

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Provide custom function definition for better LLM guidance
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
            command: {
              type: 'string',
              description: 'Shell command to execute',
            },
            description: {
              type: 'string',
              description:
                'Brief description of what this command does (5-10 words, shown in UI)',
            },
            timeout: {
              type: 'integer',
              description: `Timeout in seconds (default: 5, max: 60)`,
            },
            working_dir: {
              type: 'string',
              description: 'Working directory for command execution (default: current directory)',
            },
          },
          required: ['command'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // Capture parameters
    this.captureParams(args);

    // Extract and validate parameters
    const command = args.command as string;
    const timeout = this.validateTimeout(args.timeout);
    const workingDir = (args.working_dir as string) || process.cwd();

    if (!command) {
      return this.formatErrorResponse(
        'command parameter is required',
        'validation_error',
        'Example: bash(command="ls -la")'
      );
    }

    // Security validation
    const securityCheck = this.validateCommand(command);
    if (!securityCheck.valid) {
      return this.formatErrorResponse(
        securityCheck.error!,
        'security_error',
        securityCheck.suggestion
      );
    }

    // Execute command
    try {
      const result = await this.executeCommand(command, workingDir, timeout);
      return result;
    } catch (error) {
      return this.formatErrorResponse(
        error instanceof Error ? error.message : String(error),
        'system_error'
      );
    }
  }

  /**
   * Validate timeout parameter
   */
  private validateTimeout(timeout: any): number {
    if (timeout === undefined || timeout === null) {
      return BashTool.DEFAULT_TIMEOUT;
    }

    const timeoutMs = Number(timeout) * 1000;
    if (isNaN(timeoutMs) || timeoutMs <= 0) {
      return BashTool.DEFAULT_TIMEOUT;
    }

    return Math.min(timeoutMs, BashTool.MAX_TIMEOUT);
  }

  /**
   * Validate command for security issues
   */
  private validateCommand(
    command: string
  ): { valid: boolean; error?: string; suggestion?: string } {
    // Check for disallowed commands
    const disallowedCommands = ['rm -rf /', 'mkfs', 'dd if=/dev/zero', ':(){:|:&};:'];

    for (const disallowed of disallowedCommands) {
      if (command.includes(disallowed)) {
        return {
          valid: false,
          error: `Command contains disallowed pattern: ${disallowed}`,
          suggestion: 'This command is blocked for safety reasons',
        };
      }
    }

    return { valid: true };
  }

  /**
   * Execute a command with streaming output
   */
  private async executeCommand(
    command: string,
    workingDir: string,
    timeout: number
  ): Promise<ToolResult> {
    const callId = generateId();
    let stdout = '';
    let stderr = '';
    let returnCode: number | null = null;

    return new Promise((resolve) => {
      // Spawn process
      const child: ChildProcess = spawn(command, {
        cwd: workingDir,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
          }
        }, 1000);
      }, timeout);

      // Handle stdout
      if (child.stdout) {
        child.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          this.emitOutputChunk(callId, chunk);
        });
      }

      // Handle stderr
      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderr += chunk;
          this.emitOutputChunk(callId, chunk);
        });
      }

      // Handle process exit
      child.on('close', (code: number | null) => {
        clearTimeout(timeoutHandle);
        returnCode = code;

        resolve(
          this.formatSuccessResponse({
            output: stdout,
            error: stderr,
            return_code: returnCode ?? -1,
          })
        );
      });

      // Handle process error
      child.on('error', (error: Error) => {
        clearTimeout(timeoutHandle);
        resolve(
          this.formatErrorResponse(
            `Failed to execute command: ${error.message}`,
            'system_error'
          )
        );
      });
    });
  }

  /**
   * Custom result preview for bash tool
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];

    // Show return code
    const returnCode = result.return_code ?? -1;
    const status = returnCode === 0 ? '✓' : '✗';
    lines.push(`${status} Exit code: ${returnCode}`);

    // Show first few lines of output
    const output = result.output || '';
    if (output) {
      const outputLines = output.split('\n').slice(0, maxLines - 1);
      lines.push(...outputLines);

      if (output.split('\n').length > maxLines - 1) {
        lines.push('...');
      }
    }

    // Show stderr if present and no stdout
    if (!output && result.error) {
      const errorLines = result.error.split('\n').slice(0, maxLines - 1);
      lines.push(...errorLines);

      if (result.error.split('\n').length > maxLines - 1) {
        lines.push('...');
      }
    }

    return lines;
  }
}
