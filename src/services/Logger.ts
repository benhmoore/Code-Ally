/**
 * Logger - Conditional logging utility
 *
 * Provides debug/verbose/info logging that respects global configuration.
 * Replaces unconditional console.log statements throughout the codebase.
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  VERBOSE = 3,
  DEBUG = 4,
}

export class Logger {
  private static instance: Logger | null = null;
  private logLevel: LogLevel = LogLevel.INFO;

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
   * Log an error (always shown)
   */
  error(...args: any[]): void {
    if (this.logLevel >= LogLevel.ERROR) {
      console.error(...args);
    }
  }

  /**
   * Log a warning (shown at WARN level and above)
   */
  warn(...args: any[]): void {
    if (this.logLevel >= LogLevel.WARN) {
      console.warn(...args);
    }
  }

  /**
   * Log info (shown at INFO level and above)
   */
  info(...args: any[]): void {
    if (this.logLevel >= LogLevel.INFO) {
      console.log(...args);
    }
  }

  /**
   * Log verbose info (shown at VERBOSE level and above)
   */
  verbose(...args: any[]): void {
    if (this.logLevel >= LogLevel.VERBOSE) {
      console.log(...args);
    }
  }

  /**
   * Log debug info (shown only at DEBUG level)
   */
  debug(...args: any[]): void {
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
}

// Export singleton instance for convenience
export const logger = Logger.getInstance();
