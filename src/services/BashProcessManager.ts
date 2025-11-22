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
  private readonly lines: string[] = [];
  private readonly maxLines: number;

  constructor(maxLines: number = 10000) {
    this.maxLines = maxLines;
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

      // Remove oldest line if at capacity
      if (this.lines.length >= this.maxLines) {
        this.lines.shift();
      }
      this.lines.push(line);
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
    let result = this.lines;

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
  }

  /**
   * Get the current number of lines in the buffer
   */
  size(): number {
    return this.lines.length;
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
  /** Exit code (null while running) */
  exitCode: number | null;
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
   * Use killProcess() to both kill and remove.
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
   * Kill a process and remove it from tracking
   *
   * Sends the specified signal to the process. If successful, removes the
   * process from tracking.
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

    try {
      info.process.kill(signal);
      logger.debug(`[BashProcessManager] Sent ${signal} to process ${id} (pid: ${info.pid})`);

      // Remove from tracking after successful kill
      this.removeProcess(id);
      return true;
    } catch (error) {
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

      if (info.exitCode === null) {
        // Process is still running
        reminders.push(
          `Background shell ${info.id} [running]: "${info.command}" (${elapsed}). ` +
          `Use bash-output(shell_id="${info.id}") to read or kill-shell(shell_id="${info.id}") to stop.`
        );
      } else if (info.exitTime && info.exitTime >= fiveMinutesAgo) {
        // Process exited within last 5 minutes
        reminders.push(
          `Background shell ${info.id} [exited(${info.exitCode})]: "${info.command}" completed (${elapsed}). ` +
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
      info => info.exitCode === null
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
        info.process.kill('SIGTERM');
      } catch (error) {
        logger.warn(`[BashProcessManager] Failed to send SIGTERM to ${info.id}:`, error);
      }
    }

    // Wait for graceful shutdown
    const startTime = Date.now();
    while (Date.now() - startTime < gracefulTimeout) {
      const stillRunning = runningProcesses.filter(info => info.exitCode === null);
      if (stillRunning.length === 0) {
        logger.info('[BashProcessManager] All processes exited gracefully');
        return;
      }
      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Force kill any remaining processes
    const remainingProcesses = runningProcesses.filter(info => info.exitCode === null);
    if (remainingProcesses.length > 0) {
      logger.warn(`[BashProcessManager] ${remainingProcesses.length} process(es) did not exit gracefully, sending SIGKILL`);
      for (const info of remainingProcesses) {
        try {
          logger.debug(`[BashProcessManager] Sending SIGKILL to process ${info.id} (pid: ${info.pid})`);
          info.process.kill('SIGKILL');
        } catch (error) {
          logger.warn(`[BashProcessManager] Failed to send SIGKILL to ${info.id}:`, error);
        }
      }
    }

    // Clear all processes from tracking
    this.processes.clear();
    logger.info('[BashProcessManager] Shutdown complete');
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
      if (info.exitCode !== null && info.startTime < oldestTime) {
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

