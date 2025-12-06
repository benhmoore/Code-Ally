/**
 * FocusManager - Directory-based operation constraints
 *
 * Provides centralized focus state management for constraining file operations
 * to specific directories. When focus is active, all file operations must occur
 * within the focused directory tree.
 */

import { resolve, relative, sep } from 'path';
import { realpath, access, stat } from 'fs/promises';
import { constants } from 'fs';
import { formatError } from '../utils/errorUtils.js';
import { resolvePath } from '../utils/pathUtils.js';
import { ServiceRegistry } from './ServiceRegistry.js';

interface IAdditionalDirsManager {
  isPathInAdditionalDirectory(absolutePath: string): boolean;
  getAdditionalDirectories(): string[];
}

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
   * Get AdditionalDirectoriesManager from service registry (lazy-loaded)
   */
  private getAdditionalDirsManager(): IAdditionalDirsManager | null {
    try {
      const registry = ServiceRegistry.getInstance();
      if (registry.hasService('additional_dirs_manager')) {
        return registry.get<IAdditionalDirsManager>('additional_dirs_manager');
      }
    } catch {
      // Service not available
    }
    return null;
  }

  /**
   * Set focus to a directory relative to current working directory
   *
   * @param inputPath - Path relative to current working directory
   * @returns Result indicating success or failure
   */
  async setFocus(inputPath: string): Promise<FocusResult> {
    try {
      // Resolve path (handles ~, absolute, and relative paths)
      let focusPath = resolvePath(inputPath, this.initialWorkingDirectory);

      // Resolve symlinks
      focusPath = await realpath(focusPath);

      // Validate the focus directory exists and is accessible
      try {
        await access(focusPath, constants.R_OK);
      } catch {
        return createFocusError(
          `Focus directory is not accessible: ${inputPath}`,
          'setFocus',
          inputPath
        );
      }

      const stats = await stat(focusPath);
      if (!stats.isDirectory()) {
        return createFocusError(
          `Focus path is not a directory: ${inputPath}`,
          'setFocus',
          inputPath
        );
      }

      this.focusDirectory = focusPath;
      const relativeDisplay = relative(this.initialWorkingDirectory, focusPath);

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

    // Resolve path with appropriate base directory
    const baseDir = this.isFocused() ? this.focusDirectory! : undefined;
    return resolvePath(filePath, baseDir);
  }

  /**
   * Validate that a file path is within the current focus (if any)
   *
   * @param filePath - Absolute file path to validate
   * @returns Validation result
   */
  async validatePathInFocus(filePath: string): Promise<FocusResult> {
    const additionalDirsManager = this.getAdditionalDirsManager();

    // If no focus is set and no excluded files, allow all paths
    // Additional directories only expand access, they don't restrict it
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
        const inputPath = relative(this.initialWorkingDirectory, normalizedPath);
        return createFocusError(
          `Access denied: path '${inputPath}' is excluded from access`,
          'validatePathInFocus',
          inputPath
        );
      }

      // If focus is set, check focus constraints
      if (this.isFocused()) {
        const focusDir = await realpath(this.focusDirectory!);

        // Check if the path is within the focus directory
        const isWithinFocus =
          normalizedPath === focusDir || normalizedPath.startsWith(focusDir + sep);

        if (!isWithinFocus) {
          // Check if in additional directories
          if (additionalDirsManager?.isPathInAdditionalDirectory(normalizedPath)) {
            return { success: true, message: '' };
          }

          const focusDisplay = this.getFocusDisplay();
          const inputPath = relative(this.initialWorkingDirectory, normalizedPath);
          return createFocusError(
            `Access denied: path '${inputPath}' is outside focused directory '${focusDisplay}'`,
            'validatePathInFocus',
            inputPath
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
    const additionalDirsManager = this.getAdditionalDirsManager();

    if (!this.isFocused()) {
      return true;
    }

    try {
      const resolvedPath = resolve(filePath);
      const focusDir = this.focusDirectory!;

      const isWithinFocus = resolvedPath === focusDir || resolvedPath.startsWith(focusDir + sep);

      // If not in focus, check additional directories
      if (!isWithinFocus && additionalDirsManager) {
        return additionalDirsManager.isPathInAdditionalDirectory(resolvedPath);
      }

      return isWithinFocus;
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
