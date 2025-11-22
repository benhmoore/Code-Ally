/**
 * BashTool - Execute shell commands safely
 *
 * Executes bash commands with timeout, streaming output, and security validation.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, Config } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { spawn, ChildProcess } from 'child_process';
import { TIMEOUT_LIMITS, TOOL_OUTPUT_ESTIMATES } from '../config/toolDefaults.js';
import { formatError } from '../utils/errorUtils.js';
import { logger } from '../services/Logger.js';

export class BashTool extends BaseTool {
  readonly name = 'bash';
  readonly description =
    'Execute shell commands. Use for running scripts, system operations, building/testing code';
  readonly requiresConfirmation = true; // Destructive operations require confirmation

  private config?: Config;

  constructor(activityStream: ActivityStream, config?: Config) {
    super(activityStream);
    this.config = config;
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
              description: `Shell command to execute. IMPORTANT: Use non-interactive flags: npm create -y ..., npm init -y, apt install -y, etc. Commands will be killed if idle for ${TIMEOUT_LIMITS.IDLE_DETECTION_TIMEOUT / 1000}+ seconds.`,
            },
            timeout: {
              type: 'integer',
              description: `Timeout in seconds (default: 60, max: 1200)`,
            },
            output_mode: {
              type: 'string',
              description: 'Output mode: "full" (default), "last_line", "exit_code_only"',
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
    const outputMode = (args.output_mode as string) || 'full';
    const workingDir = (args.working_dir as string) || process.cwd();

    // Validate output_mode parameter
    if (!['full', 'last_line', 'exit_code_only'].includes(outputMode)) {
      return this.formatErrorResponse(
        `Invalid output_mode: ${outputMode}`,
        'validation_error',
        'Valid values are: "full", "last_line", "exit_code_only"'
      );
    }

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
      const result = await this.executeCommand(command, workingDir, timeout, outputMode, this.currentAbortSignal);
      return result;
    } catch (error) {
      return this.formatErrorResponse(
        formatError(error),
        'system_error'
      );
    }
  }

  /**
   * Validate timeout parameter
   */
  private validateTimeout(timeout: any): number {
    if (timeout === undefined || timeout === null) {
      // Use config bash_timeout (in seconds), convert to milliseconds
      const configTimeoutSec = this.config?.bash_timeout ?? 60;
      return configTimeoutSec * 1000;
    }

    const timeoutMs = Number(timeout) * 1000;
    if (isNaN(timeoutMs) || timeoutMs <= 0) {
      // Use config bash_timeout (in seconds), convert to milliseconds
      const configTimeoutSec = this.config?.bash_timeout ?? 60;
      return configTimeoutSec * 1000;
    }

    return Math.min(timeoutMs, TIMEOUT_LIMITS.MAX);
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
   * Check if command is likely interactive (pre-execution)
   */
  private checkInteractiveCommand(command: string): { isInteractive: boolean; suggestion?: string } {
    const patterns = [
      { pattern: /^npm\s+create(?!\s+(-y|--yes)(?:\s|$))/, suggestion: 'Add -y flag: npm create -y vite@latest myapp -- --template react-ts' },
      { pattern: /^npm\s+init(?!\s+(-y|--yes))/, suggestion: 'Use: npm init -y' },
      { pattern: /^npx\s+create-[^\s]+(?!.*(-y|--yes))/, suggestion: 'Many create-* tools support -y flag' },
      { pattern: /^(apt-get|apt)\s+install(?!\s+.*-y)/, suggestion: 'Add -y flag' },
      { pattern: /^(vi|vim|nano|emacs|less|more)\s/, suggestion: 'Text editors are interactive' },
      { pattern: /^(python3?|node|irb|php)$/, suggestion: 'Use with -c flag or script file' },
    ];

    for (const { pattern, suggestion } of patterns) {
      if (pattern.test(command.trim())) {
        return { isInteractive: true, suggestion };
      }
    }
    return { isInteractive: false };
  }

  /**
   * Execute a command with streaming output
   */
  private async executeCommand(
    command: string,
    workingDir: string,
    timeout: number,
    outputMode: string = 'full',
    abortSignal?: AbortSignal
  ): Promise<ToolResult> {
    let stdout = '';
    let stderr = '';
    let returnCode: number | null = null;
    let timedOut = false;
    let lastOutputTime = Date.now();
    let idleKilled = false;

    // Check for known interactive patterns
    const interactiveCheck = this.checkInteractiveCommand(command);
    if (interactiveCheck.isInteractive) {
      return this.formatErrorResponse(
        `Command appears to be interactive and may hang`,
        'validation_error',
        interactiveCheck.suggestion
      );
    }

    return new Promise((resolve) => {
      // Spawn process
      // Use 'ignore' for stdin to prevent hanging on interactive prompts
      // Use detached: true on Unix to create a new process group for proper cleanup
      const child: ChildProcess = spawn(command, {
        cwd: workingDir,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', // Create process group on Unix
      });

      // Helper to kill process group (important for shell: true)
      const killProcessGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;

        try {
          if (process.platform !== 'win32' && child.pid) {
            // On Unix, kill the entire process group (negative PID)
            // This ensures child processes like 'npm run dev' are also killed
            process.kill(-child.pid, signal);
          } else {
            // On Windows, just kill the process
            child.kill(signal);
          }
        } catch (error) {
          // Process might have already exited
          logger.debug('[BashTool] Error killing process:', error);
        }
      };

      // Set up abort handler
      let abortTimeoutHandle: NodeJS.Timeout | null = null;
      const abortHandler = () => {
        killProcessGroup('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) {
            killProcessGroup('SIGKILL');
          }
        }, TIMEOUT_LIMITS.GRACEFUL_SHUTDOWN_DELAY);

        // Hard timeout: force resolve after 2 seconds if process still hasn't closed
        // This prevents limbo state where tool call disappears but never completes
        abortTimeoutHandle = setTimeout(() => {
          if (child.exitCode === null) {
            logger.warn('[BashTool] Process did not respond to SIGKILL after abort, forcing completion');
            // Force resolve the promise even if process hasn't closed
            resolve(
              this.formatErrorResponse(
                'Command interrupted by user (forced completion)',
                'interrupted'
              )
            );
          }
        }, 2000); // 2 seconds: 500ms grace + 1500ms for SIGKILL to take effect
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          // Already aborted, kill immediately
          abortHandler();
        } else {
          // Listen for future abort
          abortSignal.addEventListener('abort', abortHandler);
        }
      }

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killProcessGroup('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) {
            killProcessGroup('SIGKILL');
          }
        }, TIMEOUT_LIMITS.GRACEFUL_SHUTDOWN_DELAY);
      }, timeout);

      // Idle detection: kill process if no output for configured idle timeout
      const idleCheckInterval = setInterval(() => {
        const now = Date.now();
        const idleTime = now - lastOutputTime;

        // If process is running and has been idle for too long, it's likely waiting for input
        if (child.exitCode === null && idleTime > TIMEOUT_LIMITS.IDLE_DETECTION_TIMEOUT) {
          idleKilled = true;
          clearInterval(idleCheckInterval);
          killProcessGroup('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null) {
              killProcessGroup('SIGKILL');
            }
          }, TIMEOUT_LIMITS.GRACEFUL_SHUTDOWN_DELAY);
        }
      }, TIMEOUT_LIMITS.IDLE_CHECK_INTERVAL);

      // Handle stdout
      if (child.stdout) {
        child.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          lastOutputTime = Date.now(); // Update last output time
          this.emitOutputChunk(chunk);
        });
      }

      // Handle stderr
      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderr += chunk;
          lastOutputTime = Date.now(); // Update last output time
          this.emitOutputChunk(chunk);
        });
      }

      // Handle process exit
      child.on('close', (code: number | null) => {
        clearTimeout(timeoutHandle);
        clearInterval(idleCheckInterval);
        if (abortTimeoutHandle) {
          clearTimeout(abortTimeoutHandle);
        }

        // Clean up abort listener
        if (abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }

        returnCode = code;

        // Check if killed due to abort
        if (abortSignal?.aborted) {
          resolve(
            this.formatErrorResponse(
              'Command interrupted by user',
              'interrupted'
            )
          );
          return;
        }

        // Check if killed due to idle (likely interactive prompt)
        if (idleKilled) {
          const combined = stdout + stderr;
          const lastOutput = combined.trim().split('\n').slice(-3).join('\n');
          const idleSeconds = TIMEOUT_LIMITS.IDLE_DETECTION_TIMEOUT / 1000;
          resolve(
            this.formatErrorResponse(
              `Command appears to be waiting for input (idle for ${idleSeconds}+ seconds)\n\nLast output:\n${lastOutput}`,
              'interactive_command',
              'Use non-interactive flags like --yes, -y, or provide input via pipe'
            )
          );
          return;
        }

        // Check if command timed out
        if (timedOut) {
          const timeoutSecs = timeout / 1000;
          resolve(
            this.formatErrorResponse(
              `Command timed out after ${timeoutSecs} seconds`,
              'timeout_error',
              'Try increasing the timeout parameter'
            )
          );
          return;
        }

        // Non-zero exit code = failure (except for special cases)
        if (returnCode !== 0 && returnCode !== null) {
          // Use stderr if available, otherwise stdout, otherwise generic message
          const errorMsg = stderr.trim() || stdout.trim() || 'Command failed with no output';

          resolve(
            this.formatErrorResponse(
              errorMsg,
              'command_failed',
              `Command exited with code ${returnCode}`
            )
          );
        } else {
          // Success - format output based on mode
          let content = stdout;
          if (outputMode === 'last_line') {
            const lines = stdout.trim().split('\n');
            content = lines[lines.length - 1] || '';
          } else if (outputMode === 'exit_code_only') {
            content = `Exit code: ${returnCode ?? 0}`;
          }

          // Include both stdout and stderr
          // (stderr may contain warnings even on success)
          resolve(
            this.formatSuccessResponse({
              content, // Human-readable output for LLM (formatted based on mode)
              stderr: stderr, // Warnings/info that appeared on stderr
              return_code: returnCode ?? 0,
            })
          );
        }
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
   * Format subtext for display in UI
   * Shows: [command_snippet] - [timeout] - [description]
   */
  formatSubtext(args: Record<string, any>): string | null {
    const command = args.command as string;
    const description = args.description as string;
    const timeoutParam = args.timeout;

    if (!command) {
      return null;
    }

    // Calculate timeout (same logic as validateTimeout)
    let timeoutSeconds: number;
    if (timeoutParam === undefined || timeoutParam === null) {
      timeoutSeconds = this.config?.bash_timeout ?? 60;
    } else {
      const timeoutNum = Number(timeoutParam);
      if (isNaN(timeoutNum) || timeoutNum <= 0) {
        timeoutSeconds = this.config?.bash_timeout ?? 60;
      } else {
        // Cap at max timeout (convert from ms to seconds)
        timeoutSeconds = Math.min(timeoutNum, TIMEOUT_LIMITS.MAX / 1000);
      }
    }

    // Show first 40 chars of command, truncate with ... if longer
    let commandSnippet = command;
    if (commandSnippet.length > 40) {
      commandSnippet = commandSnippet.substring(0, 40) + '...';
    }

    // Format timeout display
    const timeoutDisplay = `${timeoutSeconds}s`;

    // Build subtext: command - timeout [- description]
    if (description) {
      return `${commandSnippet} - ${timeoutDisplay} - ${description}`;
    }

    return `${commandSnippet} - ${timeoutDisplay}`;
  }

  /**
   * Get parameters shown in subtext
   * BashTool shows 'command', 'timeout', and 'description' in subtext
   */
  getSubtextParameters(): string[] {
    return ['command', 'timeout', 'description'];
  }

  /**
   * Get truncation guidance for bash output
   */
  getTruncationGuidance(): string {
    return 'Use grep, head, tail, sed, or awk to filter/narrow the output in your command';
  }

  /**
   * Get estimated output size for bash commands
   */
  getEstimatedOutputSize(): number {
    return TOOL_OUTPUT_ESTIMATES.BASH;
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

    // Show first few lines of stdout
    const output = result.content || '';
    if (output) {
      const outputLines = output.split('\n').slice(0, maxLines - 1);
      lines.push(...outputLines);

      if (output.split('\n').length > maxLines - 1) {
        lines.push('...');
      }
    }

    // Show stderr if present and no stdout (warnings/info on success)
    if (!output && result.stderr) {
      const stderrLines = result.stderr.split('\n').slice(0, maxLines - 1);
      lines.push(...stderrLines);

      if (result.stderr.split('\n').length > maxLines - 1) {
        lines.push('...');
      }
    }

    return lines;
  }
}
