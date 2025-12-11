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
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { BashProcessManager, CircularBuffer } from '../services/BashProcessManager.js';

/**
 * Whitelist of safe environment variables to pass to spawned processes.
 * This prevents leaking sensitive data (API keys, tokens) to subprocesses.
 */
const SAFE_ENV_VARS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'NODE_ENV',
  'TZ',
  'PWD',
  'OLDPWD',
  'COLORTERM',
  'TERM_PROGRAM',
];

export class BashTool extends BaseTool {
  readonly name = 'bash';
  readonly description =
    'Execute shell commands. Use for running scripts, system operations, building/testing code';
  readonly requiresConfirmation = true;
  readonly streamsOutput = true; // Output is emitted via emitOutputChunk() during execution

  private config?: Config;

  constructor(activityStream: ActivityStream, config?: Config) {
    super(activityStream);
    this.config = config;
  }

  /**
   * Validate BashTool arguments
   */
  validateArgs(args: Record<string, unknown>): { valid: boolean; error?: string; error_type?: string; suggestion?: string } | null {
    // Skip timeout validation for background processes (timeout is ignored)
    const runInBackground = args.run_in_background === true;

    // Validate timeout parameter (only for foreground processes)
    if (!runInBackground && args.timeout !== undefined && args.timeout !== null) {
      const timeout = Number(args.timeout);
      if (isNaN(timeout) || timeout <= 0) {
        return {
          valid: false,
          error: 'timeout must be a positive number (in seconds)',
          error_type: 'validation_error',
          suggestion: 'Example: timeout=30 (30 seconds)',
        };
      }
      if (timeout > 600) {
        return {
          valid: false,
          error: 'timeout cannot exceed 600 seconds (10 minutes)',
          error_type: 'validation_error',
          suggestion: 'Maximum timeout is 600 seconds',
        };
      }
    }

    // Validate command length
    if (args.command !== undefined && args.command !== null && typeof args.command === 'string') {
      if (args.command.length === 0) {
        return {
          valid: false,
          error: 'command cannot be empty',
          error_type: 'validation_error',
          suggestion: 'Example: command="ls -la"',
        };
      }
      if (args.command.length > 10000) {
        return {
          valid: false,
          error: 'command is too long (max 10000 characters)',
          error_type: 'validation_error',
          suggestion: 'Consider breaking into smaller commands or using a script file',
        };
      }
    }

    return null;
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
              description: `Timeout in seconds (default: 60, max: 1200, use -1 for no timeout)`,
            },
            output_mode: {
              type: 'string',
              description: 'Output mode: "full" (default), "last_line", "exit_code_only"',
            },
            working_dir: {
              type: 'string',
              description: 'Working directory for command execution (default: current directory)',
            },
            run_in_background: {
              type: 'boolean',
              description: 'Run command in background (returns shell_id for monitoring with bash-output). Use this for long-running servers (npm run dev, python -m http.server, etc), watchers, or any process that runs indefinitely. The timeout parameter is ignored for background processes.',
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
    const runInBackground = args.run_in_background === true;
    const timeout = runInBackground ? Infinity : this.validateTimeout(args.timeout);
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

    // Branch on execution mode
    if (runInBackground) {
      return this.spawnBackground(command, workingDir);
    } else {
      // Existing foreground execution
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
  }

  /**
   * Create sanitized environment for spawned processes
   * Filters environment to only include whitelisted variables
   */
  private getSafeEnvironment(): NodeJS.ProcessEnv {
    const safeEnv: NodeJS.ProcessEnv = {};
    for (const key of SAFE_ENV_VARS) {
      if (process.env[key] !== undefined) {
        safeEnv[key] = process.env[key];
      }
    }
    return safeEnv;
  }

  /**
   * Kill a process and its entire process group
   *
   * On Unix systems, uses negative PID to kill the entire process group.
   * On Windows, kills only the main process.
   */
  private killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;

    try {
      if (process.platform !== 'win32' && child.pid) {
        // On Unix, kill the entire process group (negative PID)
        process.kill(-child.pid, signal);
      } else {
        // On Windows, just kill the process
        child.kill(signal);
      }
    } catch (error) {
      logger.debug('[BashTool] Error killing process:', error);
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

    // Handle -1 for no timeout (infinite)
    if (timeout === -1) {
      return Infinity;
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
   * Spawn a background process and return immediately with shell_id
   *
   * Creates a detached process that runs independently, with output buffered
   * in a CircularBuffer for later retrieval via bash-output tool.
   *
   * @param command - Shell command to execute in background
   * @param workingDir - Working directory for command execution
   * @returns ToolResult with shell_id, pid, message, and command
   */
  private async spawnBackground(command: string, workingDir: string): Promise<ToolResult> {
    // Get process manager from registry
    const registry = ServiceRegistry.getInstance();
    const processManager = registry.get<BashProcessManager>('bash_process_manager');

    if (!processManager) {
      return this.formatErrorResponse(
        'BashProcessManager not available',
        'system_error',
        'Background execution requires BashProcessManager to be registered'
      );
    }

    // Generate unique shell ID
    const shellId = `shell-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Create circular buffer for output
    const outputBuffer = new CircularBuffer(10000); // 10k lines max

    // Spawn detached process
    // Note: env is filtered to prevent leaking sensitive environment variables
    const child: ChildProcess = spawn(command, {
      cwd: workingDir,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', // Create process group on Unix
      env: this.getSafeEnvironment(),
    });

    if (!child.pid) {
      return this.formatErrorResponse(
        'Failed to spawn background process',
        'system_error',
        'Process did not receive a PID'
      );
    }

    // Pipe stdout to circular buffer
    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        outputBuffer.append(data.toString());
      });
    }

    // Pipe stderr to circular buffer
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        outputBuffer.append(data.toString());
      });
    }

    // Register process with manager
    const processInfo = {
      id: shellId,
      pid: child.pid,
      command,
      process: child,
      outputBuffer,
      startTime: Date.now(),
      exitCode: null,
      exitTime: null,
    };

    try {
      processManager.addProcess(processInfo);
    } catch (error) {
      // Failed to add (probably hit limit) - kill the process
      this.killProcessGroup(child, 'SIGTERM');
      return this.formatErrorResponse(
        formatError(error),
        'system_error'
      );
    }

    // Track when process exits
    child.on('exit', (code: number | null) => {
      const info = processManager.getProcess(shellId);
      if (info) {
        info.exitCode = code;
        info.exitTime = Date.now();

        // Emit event so UI can update
        this.activityStream.emit({
          id: `bg-exit-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          type: 'background_process_exit' as any, // Cast needed until types are rebuilt
          timestamp: Date.now(),
          data: {
            shellId,
            exitCode: code,
            command,
          },
        });
      }
    });

    // Return immediately with shell_id and pid
    return this.formatSuccessResponse({
      shell_id: shellId,
      pid: child.pid,
      message: `Background shell started: ${shellId}`,
      command,
    });
  }

  /**
   * Transition a running foreground process to background
   *
   * Called when a foreground command exceeds its timeout. Instead of killing
   * the process, we preserve it by registering with BashProcessManager and
   * continuing to capture output in a CircularBuffer.
   *
   * @param child - Running ChildProcess to transition
   * @param command - Original command string
   * @param existingStdout - Output already captured before transition
   * @param existingStderr - Error output already captured before transition
   * @param timeout - Original timeout value (for message)
   * @returns ToolResult with shell_id and transition message
   */
  private transitionToBackground(
    child: ChildProcess,
    command: string,
    existingStdout: string,
    existingStderr: string,
    timeout: number
  ): ToolResult {
    // Get process manager from registry
    const registry = ServiceRegistry.getInstance();
    const processManager = registry.get<BashProcessManager>('bash_process_manager');

    if (!processManager) {
      logger.warn('[BashTool] Cannot transition to background - BashProcessManager not available');
      // Fall back to returning timeout error (process will be killed by caller)
      return this.formatErrorResponse(
        `Command timed out after ${timeout / 1000} seconds`,
        'timeout_error',
        'BashProcessManager not available for background transition'
      );
    }

    // Check if process already exited
    if (child.exitCode !== null) {
      logger.debug('[BashTool] Process already exited, cannot transition to background');
      // Return the output we have
      const output = existingStdout + existingStderr;
      return this.formatSuccessResponse({
        output: output || '(no output)',
        exit_code: child.exitCode,
        message: 'Process completed during timeout handling',
      });
    }

    // Generate unique shell ID
    const shellId = `shell-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Create circular buffer and transfer existing output
    const outputBuffer = new CircularBuffer(10000);
    if (existingStdout) {
      outputBuffer.append(existingStdout);
    }
    if (existingStderr) {
      outputBuffer.append(existingStderr);
    }

    // Continue capturing future output
    // Note: We don't remove existing listeners - they'll naturally stop when process exits
    // We add new listeners that write to the buffer
    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        outputBuffer.append(data.toString());
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        outputBuffer.append(data.toString());
      });
    }

    // Register process with manager
    const processInfo = {
      id: shellId,
      pid: child.pid!,
      command,
      process: child,
      outputBuffer,
      startTime: Date.now(),
      exitCode: null,
      exitTime: null,
    };

    try {
      processManager.addProcess(processInfo);
    } catch (error) {
      // Failed to add (probably hit limit) - return timeout error
      logger.warn('[BashTool] Failed to transition to background:', formatError(error));
      return this.formatErrorResponse(
        `Command timed out after ${timeout / 1000} seconds`,
        'timeout_error',
        formatError(error)
      );
    }

    // Track when process exits
    child.on('exit', (code: number | null) => {
      const info = processManager.getProcess(shellId);
      if (info) {
        info.exitCode = code;
        info.exitTime = Date.now();

        // Emit event so UI can update
        this.activityStream.emit({
          id: `bg-exit-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          type: 'background_process_exit' as any, // Cast needed until types are rebuilt
          timestamp: Date.now(),
          data: {
            shellId,
            exitCode: code,
            command,
          },
        });
      }
    });

    const timeoutSecs = timeout / 1000;
    const outputPreview = (existingStdout + existingStderr).trim().split('\n').slice(-5).join('\n');

    // Return success with transition info
    return this.formatSuccessResponse({
      shell_id: shellId,
      pid: child.pid,
      command,
      transitioned: true,
      reason: 'timeout',
      timeout_seconds: timeoutSecs,
      message: `Command exceeded ${timeoutSecs}s timeout and was moved to background. Process continues running as ${shellId}.`,
      output_preview: outputPreview || '(no output yet)',
      instructions: `Use bash-output(shell_id="${shellId}") to monitor output, or /task list to see all background processes.`,
    });
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
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let returnCode: number | null = null;
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
      // Note: env is filtered to prevent leaking sensitive environment variables
      const child: ChildProcess = spawn(command, {
        cwd: workingDir,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', // Create process group on Unix
        env: this.getSafeEnvironment(),
      });

      // Set up abort handler
      let abortTimeoutHandle: NodeJS.Timeout | null = null;
      const abortHandler = () => {
        this.killProcessGroup(child, 'SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) {
            this.killProcessGroup(child, 'SIGKILL');
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

      // Set up timeout - transition to background instead of killing
      const timeoutHandle = setTimeout(() => {
        // Transition to background instead of killing
        const transitionResult = this.transitionToBackground(child, command, stdoutChunks.join(''), stderrChunks.join(''), timeout);

        // Clean up listeners and intervals
        clearInterval(idleCheckInterval);
        if (abortSignal) {
          abortSignal.removeEventListener('abort', abortHandler);
        }

        // Resolve immediately with transition result
        resolve(transitionResult);
      }, timeout);

      // Idle detection: kill process if no output for configured idle timeout
      const idleCheckInterval = setInterval(() => {
        const now = Date.now();
        const idleTime = now - lastOutputTime;

        // If process is running and has been idle for too long, it's likely waiting for input
        if (child.exitCode === null && idleTime > TIMEOUT_LIMITS.IDLE_DETECTION_TIMEOUT) {
          idleKilled = true;
          clearInterval(idleCheckInterval);
          this.killProcessGroup(child, 'SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null) {
              this.killProcessGroup(child, 'SIGKILL');
            }
          }, TIMEOUT_LIMITS.GRACEFUL_SHUTDOWN_DELAY);
        }
      }, TIMEOUT_LIMITS.IDLE_CHECK_INTERVAL);

      // Handle stdout
      if (child.stdout) {
        child.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdoutChunks.push(chunk);
          lastOutputTime = Date.now(); // Update last output time
          this.emitOutputChunk(chunk);
        });
      }

      // Handle stderr
      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderrChunks.push(chunk);
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
          const stdout = stdoutChunks.join('');
          const stderr = stderrChunks.join('');
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

        // Note: Timeout handling removed - timeouts now trigger immediate transition to background
        // See timeout handler above which resolves the promise with transitionToBackground() result

        // Join chunks once for final output (O(n) vs O(n²) string concatenation)
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');

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
   * Shows: [command_snippet] - [timeout/background] - [description]
   */
  formatSubtext(args: Record<string, any>): string | null {
    const command = args.command as string;
    const description = args.description as string;
    const timeoutParam = args.timeout;
    const runInBackground = args.run_in_background === true;

    if (!command) {
      return null;
    }

    // Show first 40 chars of command, truncate with ... if longer
    let commandSnippet = command;
    if (commandSnippet.length > 40) {
      commandSnippet = commandSnippet.substring(0, 40) + '...';
    }

    // Background mode ignores timeout
    if (runInBackground) {
      const mode = 'background';
      return description ? `${commandSnippet} - ${mode} - ${description}` : `${commandSnippet} - ${mode}`;
    }

    // Calculate timeout (same logic as validateTimeout)
    let timeoutDisplay: string;
    if (timeoutParam === -1) {
      timeoutDisplay = '∞'; // Infinite timeout
    } else if (timeoutParam === undefined || timeoutParam === null) {
      const timeoutSeconds = this.config?.bash_timeout ?? 60;
      timeoutDisplay = `${timeoutSeconds}s`;
    } else {
      const timeoutNum = Number(timeoutParam);
      if (isNaN(timeoutNum) || timeoutNum <= 0) {
        const timeoutSeconds = this.config?.bash_timeout ?? 60;
        timeoutDisplay = `${timeoutSeconds}s`;
      } else {
        // Cap at max timeout (convert from ms to seconds)
        const timeoutSeconds = Math.min(timeoutNum, TIMEOUT_LIMITS.MAX / 1000);
        timeoutDisplay = `${timeoutSeconds}s`;
      }
    }

    // Build subtext: command - timeout [- description]
    if (description) {
      return `${commandSnippet} - ${timeoutDisplay} - ${description}`;
    }

    return `${commandSnippet} - ${timeoutDisplay}`;
  }

  /**
   * Get parameters shown in subtext
   * BashTool shows 'command', 'timeout', 'run_in_background', and 'description' in subtext
   */
  getSubtextParameters(): string[] {
    return ['command', 'timeout', 'run_in_background', 'description'];
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
