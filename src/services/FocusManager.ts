/**
 * FocusManager - Directory-based operation constraints
 *
 * Provides centralized focus state management for constraining file operations
 * to specific directories. When focus is active, all file operations must occur
 * within the focused directory tree.
 */

import { resolve, relative, isAbsolute, sep } from 'path';
import { realpath, access, stat } from 'fs/promises';
import { constants } from 'fs';
import { formatError } from '../utils/errorUtils.js';

export interface FocusResult {
  success: boolean;
  message: string;
  error_details?: {
    message: string;
    operation: string;
    path?: string;
  };
}

/**
 * Helper function to create structured error results
 */
function createFocusError(
  message: string,
  operation: string,
  path?: string
): FocusResult {
  return {
    success: false,
    message,
    error_details: {
      message,
      operation,
      path,
    },
  };
}

export class FocusManager {
  private focusDirectory: string | null = null;
  private excludedFiles: Set<string> = new Set();
  private readonly initialWorkingDirectory: string;

  constructor() {
    // Capture initial working directory for consistency
    this.initialWorkingDirectory = process.cwd();
  }

  /**
   * Set focus to a directory relative to current working directory
   *
   * @param relativePath - Path relative to current working directory
   * @returns Result indicating success or failure
   */
  async setFocus(relativePath: string): Promise<FocusResult> {
    try {
      const currentWd = this.initialWorkingDirectory;

      // Handle special cases
      let focusPath: string;
      if (relativePath === '.') {
        focusPath = currentWd;
      } else {
        // Reject absolute paths
        if (isAbsolute(relativePath)) {
          return createFocusError(
            'Focus path must be relative to current working directory',
            'setFocus',
            relativePath
          );
        }

        focusPath = resolve(currentWd, relativePath);
      }

      // Resolve symlinks
      focusPath = await realpath(focusPath);

      // Validate the focus directory exists and is accessible
      try {
        await access(focusPath, constants.R_OK);
      } catch {
        return createFocusError(
          `Focus directory is not accessible: ${relativePath}`,
          'setFocus',
          relativePath
        );
      }

      const stats = await stat(focusPath);
      if (!stats.isDirectory()) {
        return createFocusError(
          `Focus path is not a directory: ${relativePath}`,
          'setFocus',
          relativePath
        );
      }

      // Ensure focus is within current working directory
      if (!focusPath.startsWith(currentWd)) {
        return createFocusError(
          `Focus directory must be within current working directory: ${relativePath}`,
          'setFocus',
          relativePath
        );
      }

      this.focusDirectory = focusPath;
      const relativeDisplay = relative(currentWd, focusPath);

      return {
        success: true,
        message: `Focus set to: ${relativeDisplay || '.'}`,
      };
    } catch (error) {
      return createFocusError(
        `Error setting focus: ${formatError(error)}`,
        'setFocus'
      );
    }
  }

  /**
   * Set files to exclude from access (absolute paths)
   *
   * @param filePaths - Array of absolute file paths to exclude
   */
  setExcludedFiles(filePaths: string[]): void {
    this.excludedFiles = new Set(filePaths.map(p => resolve(p)));
  }

  /**
   * Clear excluded files list
   */
  clearExcludedFiles(): void {
    this.excludedFiles.clear();
  }

  /**
   * Clear the current focus (does NOT clear excluded files)
   *
   * @returns Result indicating success
   */
  clearFocus(): FocusResult {
    if (this.focusDirectory === null) {
      return {
        success: true,
        message: 'No focus was set',
      };
    }

    const oldFocus = this.getFocusDisplay();
    this.focusDirectory = null;

    return {
      success: true,
      message: `Focus cleared (was: ${oldFocus})`,
    };
  }

  /**
   * Get the current focus directory as an absolute path
   *
   * @returns Absolute path or null if no focus is set
   */
  getFocusDirectory(): string | null {
    return this.focusDirectory;
  }

  /**
   * Get the focus directory for display (relative to working directory)
   *
   * @returns Relative path for display or null if no focus is set
   */
  getFocusDisplay(): string | null {
    if (this.focusDirectory === null) {
      return null;
    }

    const relPath = relative(this.initialWorkingDirectory, this.focusDirectory);
    return relPath || '.';
  }

  /**
   * Check if focus is currently active
   *
   * @returns True if focus is set
   */
  isFocused(): boolean {
    return this.focusDirectory !== null;
  }

  /**
   * Resolve a file path relative to the focused directory
   *
   * When focus is active, relative paths are resolved relative to the
   * focused directory, not the CWD.
   *
   * @param filePath - File path to resolve
   * @returns Absolute path resolved appropriately for focus context
   */
  resolvePathInFocus(filePath: string): string {
    if (!filePath) {
      return '';
    }

    // Expand user directory symbols first
    let expanded = filePath;
    if (filePath.startsWith('~/')) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      expanded = filePath.replace('~', home);
    } else if (filePath === '~') {
      expanded = process.env.HOME || process.env.USERPROFILE || '';
    }

    // No focus active - resolve normally
    if (!this.isFocused()) {
      return resolve(expanded);
    }

    // Already absolute - return normalized
    if (isAbsolute(expanded)) {
      return resolve(expanded);
    }

    // Relative path - resolve relative to focused directory
    return resolve(this.focusDirectory!, expanded);
  }

  /**
   * Validate that a file path is within the current focus (if any)
   *
   * @param filePath - Absolute file path to validate
   * @returns Validation result
   */
  async validatePathInFocus(filePath: string): Promise<FocusResult> {
    if (!this.isFocused() && this.excludedFiles.size === 0) {
      return { success: true, message: '' };
    }

    if (!filePath) {
      return createFocusError('Path cannot be empty', 'validatePathInFocus');
    }

    try {
      // Normalize the file path and resolve symlinks
      const normalizedPath = await realpath(filePath).catch(() => resolve(filePath));

      // Check if path is in excluded files list
      if (this.excludedFiles.has(normalizedPath)) {
        const relativePath = relative(this.initialWorkingDirectory, normalizedPath);
        return createFocusError(
          `Access denied: path '${relativePath}' is excluded from access`,
          'validatePathInFocus',
          relativePath
        );
      }

      // If focus is set, check focus constraints
      if (this.isFocused()) {
        const focusDir = await realpath(this.focusDirectory!);

        // Check if the path is within the focus directory
        const isWithinFocus =
          normalizedPath === focusDir || normalizedPath.startsWith(focusDir + sep);

        if (!isWithinFocus) {
          const focusDisplay = this.getFocusDisplay();
          const relativePath = relative(this.initialWorkingDirectory, normalizedPath);
          return createFocusError(
            `Access denied: path '${relativePath}' is outside focused directory '${focusDisplay}'`,
            'validatePathInFocus',
            relativePath
          );
        }
      }

      return { success: true, message: '' };
    } catch (error) {
      return createFocusError(
        `Error validating focus constraint: ${formatError(error)}`,
        'validatePathInFocus'
      );
    }
  }

  /**
   * Check if a path is within focus (synchronous check without validation)
   *
   * @param filePath - Path to check
   * @returns True if path is in focus or no focus is set
   */
  isPathInFocus(filePath: string): boolean {
    if (!this.isFocused()) {
      return true;
    }

    try {
      const resolvedPath = resolve(filePath);
      const focusDir = this.focusDirectory!;

      return resolvedPath === focusDir || resolvedPath.startsWith(focusDir + sep);
    } catch {
      return false;
    }
  }

  /**
   * Get text for status line display
   *
   * @returns Status text or empty string if no focus
   */
  getStatusLineText(): string {
    const focusDisplay = this.getFocusDisplay();
    if (focusDisplay === null) {
      return '';
    }

    if (focusDisplay === '.') {
      return 'focused: .';
    } else {
      return `focused: ${focusDisplay}/`;
    }
  }

  /**
   * Get context text for error messages
   *
   * @returns Context text describing current focus state
   */
  getErrorContext(): string {
    if (!this.isFocused()) {
      return 'No focus is currently set.';
    }

    const focusDisplay = this.getFocusDisplay();
    return `Current focus: ${focusDisplay}/`;
  }
}
