/**
 * AdditionalDirectoriesManager - Expanded scope directory management
 *
 * Manages additional working directories outside the main CWD to expand
 * Ally's accessible scope. Provides validation and tracking of directories
 * that are explicitly added to the accessible scope.
 */

import { resolve, sep } from 'path';
import { realpath, access, stat } from 'fs/promises';
import { constants } from 'fs';
import { homedir } from 'os';
import { formatError } from '../utils/errorUtils.js';

export interface DirectoryResult {
  success: boolean;
  message: string;
  path?: string; // The resolved absolute path
}

/**
 * Helper function to create structured error results
 */
function createDirectoryError(
  message: string,
  path?: string
): DirectoryResult {
  return {
    success: false,
    message,
    path,
  };
}

/**
 * AdditionalDirectoriesManager manages directories that extend Ally's scope
 * beyond the current working directory
 */
export class AdditionalDirectoriesManager {
  private additionalDirectories: Set<string> = new Set();
  private readonly initialWorkingDirectory: string;

  constructor() {
    // Capture initial working directory for consistency
    this.initialWorkingDirectory = process.cwd();
  }

  /**
   * Add a directory to the additional directories list
   *
   * Validates that the path exists, is a directory, and is accessible.
   * Resolves symlinks to canonical paths. If the path is already within
   * the CWD, returns success with a message indicating this.
   *
   * @param path - Directory path to add (can be relative or absolute)
   * @returns Result indicating success or failure with resolved path
   */
  async addDirectory(path: string): Promise<DirectoryResult> {
    try {
      if (!path || path.trim() === '') {
        return createDirectoryError('Directory path cannot be empty');
      }

      // Expand tilde and remove trailing slashes
      let processedPath = path.trim();

      // Remove trailing slashes (but keep single / for root)
      if (processedPath.length > 1 && processedPath.endsWith(sep)) {
        processedPath = processedPath.slice(0, -1);
      }

      // Expand ~ to home directory
      if (processedPath.startsWith('~/')) {
        const home = homedir();
        processedPath = processedPath.replace('~', home);
      } else if (processedPath === '~') {
        processedPath = homedir();
      }

      // Resolve the path to absolute
      let absolutePath = resolve(processedPath);

      // Validate the directory exists
      try {
        await access(absolutePath, constants.R_OK);
      } catch {
        return createDirectoryError(
          `Directory is not accessible: ${path}`,
          absolutePath
        );
      }

      // Check if it's a directory
      const stats = await stat(absolutePath);
      if (!stats.isDirectory()) {
        return createDirectoryError(
          `Path is not a directory: ${path}`,
          absolutePath
        );
      }

      // Resolve symlinks to get the real path
      absolutePath = await realpath(absolutePath);

      // Check if path is already within the CWD
      const currentWd = this.initialWorkingDirectory;
      if (
        absolutePath === currentWd ||
        absolutePath.startsWith(currentWd + sep)
      ) {
        return {
          success: true,
          message: 'Path is already within working directory',
          path: absolutePath,
        };
      }

      // Check if already added (idempotent operation)
      if (this.additionalDirectories.has(absolutePath)) {
        return {
          success: true,
          message: 'Directory already added',
          path: absolutePath,
        };
      }

      // Add the directory
      this.additionalDirectories.add(absolutePath);

      const displayPath = this.getDisplayPath(absolutePath);
      return {
        success: true,
        message: `Added directory: ${displayPath}`,
        path: absolutePath,
      };
    } catch (error) {
      return createDirectoryError(
        `Error adding directory: ${formatError(error)}`,
        path
      );
    }
  }

  /**
   * Remove a directory from the additional directories list
   *
   * @param path - Directory path to remove (can be relative or absolute)
   * @returns Result indicating success or failure
   */
  removeDirectory(path: string): DirectoryResult {
    try {
      if (!path || path.trim() === '') {
        return createDirectoryError('Directory path cannot be empty');
      }

      // Expand tilde and remove trailing slashes
      let processedPath = path.trim();

      // Remove trailing slashes (but keep single / for root)
      if (processedPath.length > 1 && processedPath.endsWith(sep)) {
        processedPath = processedPath.slice(0, -1);
      }

      // Expand ~ to home directory
      if (processedPath.startsWith('~/')) {
        const home = homedir();
        processedPath = processedPath.replace('~', home);
      } else if (processedPath === '~') {
        processedPath = homedir();
      }

      // Resolve to absolute path for comparison
      const absolutePath = resolve(processedPath);

      // Try to find and remove the directory
      // Check exact match first
      if (this.additionalDirectories.has(absolutePath)) {
        this.additionalDirectories.delete(absolutePath);
        const displayPath = this.getDisplayPath(absolutePath);
        return {
          success: true,
          message: `Removed directory: ${displayPath}`,
          path: absolutePath,
        };
      }

      // If not found by exact match, try to find by comparing all entries
      // This handles cases where the path might have been added differently
      for (const dir of this.additionalDirectories) {
        if (dir === absolutePath) {
          this.additionalDirectories.delete(dir);
          const displayPath = this.getDisplayPath(dir);
          return {
            success: true,
            message: `Removed directory: ${displayPath}`,
            path: dir,
          };
        }
      }

      const displayPath = this.getDisplayPath(absolutePath);
      return createDirectoryError(
        `Directory not found in additional directories: ${displayPath}`,
        absolutePath
      );
    } catch (error) {
      return createDirectoryError(
        `Error removing directory: ${formatError(error)}`,
        path
      );
    }
  }

  /**
   * Get list of all additional directories
   *
   * @returns Array of absolute directory paths
   */
  getAdditionalDirectories(): string[] {
    return Array.from(this.additionalDirectories);
  }

  /**
   * Check if a path is within any additional directory
   *
   * @param absolutePath - Absolute path to check
   * @returns True if path is within any additional directory
   */
  isPathInAdditionalDirectory(absolutePath: string): boolean {
    if (!absolutePath || !this.additionalDirectories.size) {
      return false;
    }

    try {
      const normalizedPath = resolve(absolutePath);

      for (const dir of this.additionalDirectories) {
        // Check if path is exactly the directory or within it
        if (
          normalizedPath === dir ||
          normalizedPath.startsWith(dir + sep)
        ) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Clear all additional directories
   */
  clear(): void {
    this.additionalDirectories.clear();
  }

  /**
   * Get display paths for UI (abbreviate home directory with ~)
   *
   * @returns Array of display-friendly paths
   */
  getDisplayPaths(): string[] {
    return Array.from(this.additionalDirectories).map(path =>
      this.getDisplayPath(path)
    );
  }

  /**
   * Convert an absolute path to a display-friendly version
   *
   * @param absolutePath - Absolute path to convert
   * @returns Display-friendly path with ~ for home directory
   */
  private getDisplayPath(absolutePath: string): string {
    const home = homedir();
    if (absolutePath === home) {
      return '~';
    }
    if (absolutePath.startsWith(home + sep)) {
      return '~' + absolutePath.slice(home.length);
    }
    return absolutePath;
  }
}
