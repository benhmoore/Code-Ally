/**
 * Type definitions for file checking system
 *
 * Defines interfaces for syntax/type checking across multiple languages
 */

/**
 * Represents a single issue found during checking
 */
export interface CheckIssue {
  /** Line number where issue occurs (1-indexed) */
  line: number;

  /** Column number where issue occurs (1-indexed, optional) */
  column?: number;

  /** Human-readable error/warning message */
  message: string;

  /** Error/warning code (e.g., 'TS2304', 'E0001') */
  code?: string;

  /** Severity level */
  severity: 'error' | 'warning';
}

/**
 * Result of checking a file
 */
export interface CheckResult {
  /** Name of checker that performed the check */
  checker: string;

  /** Whether the file passed all checks (no errors) */
  passed: boolean;

  /** List of errors found */
  errors: CheckIssue[];

  /** List of warnings found */
  warnings: CheckIssue[];

  /** Time taken to check in milliseconds */
  checkTimeMs: number;
}

/**
 * Interface for language-specific file checkers
 *
 * Each checker handles one or more file types and provides
 * syntax/type checking using appropriate tools.
 */
export interface FileChecker {
  /** Unique identifier for this checker */
  readonly name: string;

  /**
   * Check if this checker can handle the given file
   *
   * @param filePath - Path to file to check
   * @returns True if checker can handle this file type
   */
  canCheck(filePath: string): boolean;

  /**
   * Check a file for syntax/type errors
   *
   * @param filePath - Path to file being checked
   * @param content - File content to check
   * @returns Check result with errors/warnings
   */
  check(filePath: string, content: string): Promise<CheckResult>;
}
