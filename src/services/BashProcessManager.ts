/**
 * BashProcessManager - Manages background bash processes with output buffering
 *
 * Provides process lifecycle management, circular buffering for output capture,
 * and status monitoring for long-running shell commands.
 */

import { ChildProcess } from 'child_process';
import { logger } from './Logger.js';
import { formatDuration } from '../ui/utils/timeUtils.js';

/**
 * Circular buffer for storing lines of output with automatic overflow handling
 *
 * Maintains a fixed-size buffer of lines, automatically removing oldest lines
 * when capacity is reached. Memory-safe for long-running processes.
 */
export class CircularBuffer {
  private lines: string[] = [];
  private head = 0;
  private bytes = 0;
  private readonly maxLines: number;
  private readonly maxBytes: number;

  constructor(maxLines: number = 10000, maxBytes: number = 4 * 1024 * 1024) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
  }

  /**
   * Append text to the buffer, splitting on newlines
   *
   * Text may contain multiple lines or partial lines. Lines are split on \n
   * and stored individually. When buffer reaches capacity, oldest lines are
   * automatically removed.
   *
   * @param text - Text to append (may contain newlines)
   */
  append(text: string): void {
    if (!text) return;

    const newLines = text.split('\n');

    for (let i = 0; i < newLines.length; i++) {
      const line = newLines[i];
      if (line === undefined) continue; // Safety check for TypeScript

      // Skip empty lines that result from trailing newlines
      // (e.g., "hello\n" splits to ["hello", ""] - skip the empty string)
      if (i === newLines.length - 1 && line === '') {
        continue;
      }

      let boundedLine = line;
      let lineBytes = Buffer.byteLength(boundedLine);
      if (lineBytes > this.maxBytes) {
        boundedLine = Buffer.from(boundedLine).subarray(lineBytes - this.maxBytes).toString('utf8');
        lineBytes = Buffer.byteLength(boundedLine);
      }
      this.lines.push(boundedLine);
      this.bytes += lineBytes;
      while ((this.lines.length - this.head > this.maxLines || this.bytes > this.maxBytes)
        && this.head < this.lines.length) {
        this.bytes -= Buffer.byteLength(this.lines[this.head]!);
        this.head += 1;
      }
      if (this.head > 1024 && this.head * 2 > this.lines.length) {
        this.lines = this.lines.slice(this.head);
        this.head = 0;
      }
    }
  }

  /**
   * Get lines from the buffer
   *
   * @param count - Optional limit on number of lines to return (from end)
   * @param filter - Optional regex to filter lines
   * @returns Array of lines matching criteria
   */
  getLines(count?: number, filter?: RegExp): string[] {
    let result = this.lines.slice(this.head);

    // Apply regex filter if provided
    if (filter) {
      result = result.filter(line => filter.test(line));
    }

    // Return last N lines if count specified
    if (count !== undefined && count > 0) {
      return result.slice(-count);
    }

    return result;
  }

  /**
   * Clear all lines from the buffer
   */
  clear(): void {
    this.lines.length = 0;
    this.head = 0;
    this.bytes = 0;
  }

  /**
   * Get the current number of lines in the buffer
   */
  size(): number {
    return this.lines.length - this.head;
  }
}

/**
 * Information about a managed process
 */
export interface ProcessInfo {
  /** Unique identifier: shell-{timestamp}-{random} */
  id: string;
  /** Process ID from operating system */
  pid: number;
  /** Original command that was executed */
  command: string;
  /** ChildProcess instance */
  process: ChildProcess;
  /** Circular buffer containing process output */
  outputBuffer: CircularBuffer;
  /** Unix timestamp when process started */
  startTime: number;
  /** Explicit lifecycle state; exitCode is null both while running and after signal exit. */
  status: 'running' | 'stopping' | 'exited';
  /** Exit code (null while running or when terminated by a signal) */
  exitCode: number | null;
  /** Signal reported by Node when the process exits because of a signal */
  exitSignal: NodeJS.Signals | null;
  /** Signal requested through killProcess while termination is in flight */
  terminationSignal: NodeJS.Signals | null;
  /** Whether this background process is an explicit durable-objective dependency */
  blocksCompletion: boolean;
  /** Unix timestamp when process exited (null while running) */
  exitTime: number | null;
}

/**
 * Manages a collection of background bash processes
 *
 * Provides centralized tracking, output buffering, and lifecycle management
 * for background shell processes. Enforces process limits and provides
 * monitoring capabilities.
 */
export class BashProcessManager {
  private readonly processes: Map<string, ProcessInfo> = new Map();
  private readonly maxProcesses: number;

  constructor(maxProcesses: number = 10) {
    this.maxProcesses = maxProcesses;
  }

  /**
   * Add a process to the manager
   *
   * Enforces the maximum process limit. If limit is reached, the oldest
   * completed process is removed. If all processes are running, an error
   * is thrown.
   *
   * @param info - Process information to track
   * @throws Error if process limit reached and no completed processes exist
   */
  addProcess(info: ProcessInfo): void {
    // Check if we've hit the limit
    if (this.processes.size >= this.maxProcesses) {
      // Try to remove oldest completed process
      const removed = this.removeOldestCompletedProcess();

      if (!removed) {
        throw new Error(
          `Process limit reached (${this.maxProcesses}). ` +
          `Kill an existing process before starting a new one.`
        );
      }

      logger.debug(
        `[BashProcessManager] Removed oldest completed process to make room for ${info.id}`
      );
    }

    this.processes.set(info.id, info);
    logger.debug(`[BashProcessManager] Added process ${info.id} (pid: ${info.pid})`);
  }

  /**
   * Get a process by its ID
   *
   * @param id - Process identifier
   * @returns ProcessInfo if found, undefined otherwise
   */
  getProcess(id: string): ProcessInfo | undefined {
    return this.processes.get(id);
  }

  /**
   * List all tracked processes
   *
   * @returns Array of all ProcessInfo objects
   */
  listProcesses(): ProcessInfo[] {
    return Array.from(this.processes.values());
  }

  /**
   * Remove a process from tracking
   *
   * Does not kill the process - only removes it from the manager's tracking.
   * Use killProcess() to request termination. Completed entries remain briefly
   * available so callers can read their final output.
   *
   * @param id - Process identifier
   */
  removeProcess(id: string): void {
    const removed = this.processes.delete(id);
    if (removed) {
      logger.debug(`[BashProcessManager] Removed process ${id} from tracking`);
    }
  }

  /**
   * Request process termination and mark it as stopping
   *
   * Sends the specified signal to the process. Signal delivery is not process
   * exit, so the entry remains tracked as `stopping` until the child's exit
   * event records its final code/signal.
   *
   * @param id - Process identifier
   * @param signal - Signal to send (default: SIGTERM)
   * @returns true if process was found and killed, false otherwise
   */
  killProcess(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const info = this.processes.get(id);

    if (!info) {
      logger.debug(`[BashProcessManager] Process ${id} not found for killing`);
      return false;
    }

    if (info.status === 'exited') {
      logger.debug(`[BashProcessManager] Process ${id} already exited`);
      return false;
    }

    const previousStatus = info.status;
    const previousSignal = info.terminationSignal;
    info.status = 'stopping';
    info.terminationSignal = signal;

    try {
      const signalDelivered = this.signalProcessGroup(info, signal);
      if (!signalDelivered) {
        // The OS/ChildProcess reports no live target. Treat that as settled even
        // if Node's asynchronous exit event has not reached us yet.
        info.status = 'exited';
        info.exitCode = info.process.exitCode;
        info.exitSignal = info.process.signalCode as NodeJS.Signals | null;
        info.exitTime ??= Date.now();
      }
      logger.debug(
        `[BashProcessManager] ${signalDelivered ? `Sent ${signal}` : 'Target already absent'} for process ${id} (pid: ${info.pid})`
      );

      return true;
    } catch (error) {
      info.status = previousStatus;
      info.terminationSignal = previousSignal;
      logger.error(`[BashProcessManager] Failed to kill process ${id}:`, error);
      return false;
    }
  }

  /**
   * Generate status reminders for all processes
   *
   * Creates reminder strings for:
   * - All running processes
   * - Processes that exited within the last 5 minutes
   *
   * Format:
   * - Running: "Background shell {id} [running]: "{command}" ({elapsed}). Use bash-output(bash_id="{id}") to read or kill-shell(shell_id="{id}") to stop."
   * - Exited: "Background shell {id} [exited({code})]: "{command}" completed ({elapsed}). Use bash-output(bash_id="{id}") to read final output."
   *
   * @returns Array of reminder strings
   */
  getStatusReminders(): string[] {
    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    const reminders: string[] = [];

    for (const info of this.processes.values()) {
      const elapsed = formatDuration(now - info.startTime);

      if (info.status === 'running') {
        // Process is still running
        const lifecycleGuidance = info.blocksCompletion
          ? 'This is an explicit completion dependency; wait for it or stop it before completing the objective.'
          : 'This process is non-blocking and does not prevent objective completion; leave long-running servers active unless the user asked to stop them.';
        reminders.push(
          `Background shell ${info.id} [running]: "${info.command}" (${elapsed}). ` +
          `${lifecycleGuidance} Use bash-output(shell_id="${info.id}") to inspect it.`
        );
      } else if (info.status === 'exited' && info.exitTime && info.exitTime >= fiveMinutesAgo) {
        // Process exited within last 5 minutes
        const outcome = info.exitSignal ?? info.exitCode ?? 'unknown';
        reminders.push(
          `Background shell ${info.id} [exited(${outcome})]: "${info.command}" completed (${elapsed}). ` +
          `Use bash-output(shell_id="${info.id}") to read final output.`
        );
      }
    }

    return reminders;
  }

  /**
   * Get the current number of tracked processes
   *
   * @returns Number of processes currently tracked
   */
  getCount(): number {
    return this.processes.size;
  }

  /**
   * Shutdown all running background processes
   *
   * Gracefully terminates all running processes with SIGTERM, waits for them to exit,
   * then forcefully kills any remaining processes with SIGKILL.
   *
   * @param gracefulTimeout - Milliseconds to wait for graceful shutdown (default: 5000ms)
   * @returns Promise that resolves when all processes are terminated
   */
  async shutdown(gracefulTimeout: number = 5000): Promise<void> {
    const runningProcesses = Array.from(this.processes.values()).filter(
      info => info.status !== 'exited'
    );

    if (runningProcesses.length === 0) {
      logger.debug('[BashProcessManager] No running processes to shutdown');
      return;
    }

    logger.info(`[BashProcessManager] Shutting down ${runningProcesses.length} background process(es)...`);

    // Send SIGTERM to all running processes
    for (const info of runningProcesses) {
      try {
        logger.debug(`[BashProcessManager] Sending SIGTERM to process ${info.id} (pid: ${info.pid})`);
        this.signalProcessGroup(info, 'SIGTERM');
      } catch (error) {
        logger.warn(`[BashProcessManager] Failed to send SIGTERM to ${info.id}:`, error);
      }
    }

    // Wait for graceful shutdown
    const startTime = Date.now();
    while (Date.now() - startTime < gracefulTimeout) {
      const stillRunning = runningProcesses.filter(info => info.status !== 'exited');
      if (stillRunning.length === 0) {
        logger.info('[BashProcessManager] All processes exited gracefully');
        return;
      }
      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Force kill any remaining processes
    const remainingProcesses = runningProcesses.filter(info => info.status !== 'exited');
    if (remainingProcesses.length > 0) {
      logger.warn(`[BashProcessManager] ${remainingProcesses.length} process(es) did not exit gracefully, sending SIGKILL`);
      for (const info of remainingProcesses) {
        try {
          logger.debug(`[BashProcessManager] Sending SIGKILL to process ${info.id} (pid: ${info.pid})`);
          this.signalProcessGroup(info, 'SIGKILL');
        } catch (error) {
          logger.warn(`[BashProcessManager] Failed to send SIGKILL to ${info.id}:`, error);
        }
      }
    }

    // Clear all processes from tracking
    this.processes.clear();
    logger.info('[BashProcessManager] Shutdown complete');
  }

  private signalProcessGroup(info: ProcessInfo, signal: NodeJS.Signals): boolean {
    if (process.platform !== 'win32' && info.pid > 0) {
      try {
        process.kill(-info.pid, signal);
        return true;
      } catch (error) {
        // Fall back to the direct child handle for spawn modes/platforms where
        // no process group exists. A false return means there is no live target.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          logger.debug(`[BashProcessManager] Process-group signal failed for ${info.id}; trying child handle`);
        }
      }
    }
    return info.process.kill(signal);
  }

  /**
   * Remove the oldest completed process from tracking
   *
   * @returns true if a process was removed, false if no completed processes exist
   */
  private removeOldestCompletedProcess(): boolean {
    let oldestCompleted: ProcessInfo | null = null;
    let oldestTime = Infinity;

    // Find the oldest completed process
    for (const info of this.processes.values()) {
      if (info.status === 'exited' && info.startTime < oldestTime) {
        oldestCompleted = info;
        oldestTime = info.startTime;
      }
    }

    if (oldestCompleted) {
      this.removeProcess(oldestCompleted.id);
      return true;
    }

    return false;
  }
}
