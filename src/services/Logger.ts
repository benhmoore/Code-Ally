/**
 * Logger - Conditional logging utility
 *
 * Provides debug/verbose/info logging that respects global configuration.
 * Replaces unconditional console.log statements throughout the codebase.
 *
 * All log messages are stored in memory regardless of log level,
 * allowing for comprehensive debug dumps when needed.
 */

import { BUFFER_SIZES } from '../config/constants.js';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  VERBOSE = 3,
  DEBUG = 4,
}

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
}

export class Logger {
  private static instance: Logger | null = null;
  private logLevel: LogLevel = LogLevel.INFO;
  private logBuffer: LogEntry[] = [];
  private maxBufferSize: number = BUFFER_SIZES.MAX_LOG_BUFFER_SIZE;

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Set the global log level
   */
  setLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  /**
   * Configure logging from CLI flags
   */
  configure(options: { verbose?: boolean; debug?: boolean }): void {
    if (options.debug) {
      this.logLevel = LogLevel.DEBUG;
      console.log('[DEBUG] Debug logging enabled');
    } else if (options.verbose) {
      this.logLevel = LogLevel.VERBOSE;
      console.log('[VERBOSE] Verbose logging enabled');
    } else {
      this.logLevel = LogLevel.INFO;
    }
  }

  /**
   * Store a log entry in the buffer
   * Immediately serializes and truncates to prevent memory leaks
   */
  private storeLog(level: LogLevel, args: any[]): void {
    // Serialize immediately - don't keep references to original objects
    let message = args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch {
          return '[Circular]';
        }
      }
      return String(arg);
    }).join(' ');

    // Truncate to prevent single huge entries
    if (message.length > BUFFER_SIZES.MAX_LOG_MESSAGE_LENGTH) {
      message = message.substring(0, BUFFER_SIZES.MAX_LOG_MESSAGE_LENGTH) + '... [truncated]';
    }

    this.logBuffer.push({
      timestamp: Date.now(),
      level,
      message
    });

    // Maintain circular buffer - remove oldest entries if over limit
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }
  }

  /**
   * Log an error (always shown)
   */
  error(...args: any[]): void {
    this.storeLog(LogLevel.ERROR, args);
    if (this.logLevel >= LogLevel.ERROR) {
      console.error(...args);
    }
  }

  /**
   * Log a warning (shown at WARN level and above)
   */
  warn(...args: any[]): void {
    this.storeLog(LogLevel.WARN, args);
    if (this.logLevel >= LogLevel.WARN) {
      console.warn(...args);
    }
  }

  /**
   * Log info (shown at INFO level and above)
   */
  info(...args: any[]): void {
    this.storeLog(LogLevel.INFO, args);
    if (this.logLevel >= LogLevel.INFO) {
      console.log(...args);
    }
  }

  /**
   * Log verbose info (shown at VERBOSE level and above)
   */
  verbose(...args: any[]): void {
    this.storeLog(LogLevel.VERBOSE, args);
    if (this.logLevel >= LogLevel.VERBOSE) {
      console.log(...args);
    }
  }

  /**
   * Log debug info (shown only at DEBUG level)
   */
  debug(...args: any[]): void {
    this.storeLog(LogLevel.DEBUG, args);
    if (this.logLevel >= LogLevel.DEBUG) {
      console.log(...args);
    }
  }

  /**
   * Get current log level
   */
  getLevel(): LogLevel {
    return this.logLevel;
  }

  /**
   * Check if debug logging is enabled
   */
  isDebugEnabled(): boolean {
    return this.logLevel >= LogLevel.DEBUG;
  }

  /**
   * Check if verbose logging is enabled
   */
  isVerboseEnabled(): boolean {
    return this.logLevel >= LogLevel.VERBOSE;
  }

  /**
   * Get all stored log entries
   */
  getAllLogs(): LogEntry[] {
    return [...this.logBuffer];
  }

  /**
   * Get logs filtered by level
   */
  getLogsByLevel(level: LogLevel): LogEntry[] {
    return this.logBuffer.filter(entry => entry.level === level);
  }

  /**
   * Get logs at or above a certain level
   */
  getLogsAtOrAbove(level: LogLevel): LogEntry[] {
    return this.logBuffer.filter(entry => entry.level >= level);
  }

  /**
   * Clear all stored logs
   */
  clearLogs(): void {
    this.logBuffer = [];
  }

  /**
   * Get the number of stored log entries
   */
  getLogCount(): number {
    return this.logBuffer.length;
  }
}

// Export singleton instance for convenience
export const logger = Logger.getInstance();
