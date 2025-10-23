/**
 * PathResolver - Centralized path resolution service
 *
 * Provides focus-aware path resolution with fallback to standard resolution.
 * Integrates with optional FocusManager service for directory-scoped operations.
 */

import { resolve, isAbsolute } from 'path';
import { homedir } from 'os';
import { ServiceRegistry } from './ServiceRegistry.js';
import { formatError, isFileNotFoundError } from '../utils/errorUtils.js';
import { logger } from './Logger.js';

/**
 * Interface for FocusManager service
 * This is a forward declaration to avoid circular dependencies
 */
interface IFocusManager {
  resolvePathInFocus(filePath: string): string;
  getFocusDirectory(): string | null;
  isPathInFocus(filePath: string): boolean;
}

export class PathResolver {
  private _focusManager?: IFocusManager;
  private _focusManagerChecked: boolean = false;

  /**
   * Get focus manager instance lazily from service registry
   */
  private get focusManager(): IFocusManager | null {
    if (!this._focusManagerChecked) {
      try {
        const registry = ServiceRegistry.getInstance();
        if (registry.hasService('focus_manager')) {
          this._focusManager = registry.get<IFocusManager>('focus_manager')!;
        }
      } catch (error) {
        // Focus manager not available - expected if not initialized
        if (!isFileNotFoundError(error)) {
          logger.warn('Unexpected error accessing focus_manager:', formatError(error));
        }
      }
      this._focusManagerChecked = true;
    }

    return this._focusManager || null;
  }

  /**
   * Resolve a single file path with focus awareness
   *
   * Resolution order:
   * 1. If FocusManager is available, use focus-aware resolution
   * 2. Otherwise, use standard resolution (expand ~ and make absolute)
   *
   * @param filePath - Path to resolve
   * @returns Absolute path
   */
  resolvePath(filePath: string): string {
    if (!filePath) {
      return '';
    }

    try {
      const focusManager = this.focusManager;

      if (focusManager) {
        return focusManager.resolvePathInFocus(filePath);
      }

      // Standard resolution
      return this.standardResolve(filePath);
    } catch (error) {
      logger.warn('Path resolution failed, using fallback:', formatError(error));
      // Fallback to standard resolution
      return this.standardResolve(filePath);
    }
  }

  /**
   * Resolve multiple file paths efficiently
   *
   * @param filePaths - Array of paths to resolve
   * @returns Array of absolute paths
   */
  resolvePaths(filePaths: string[]): string[] {
    return filePaths.map(path => this.resolvePath(path));
  }

  /**
   * Standard path resolution without focus awareness
   *
   * Expands ~ to home directory and converts to absolute path
   *
   * @param filePath - Path to resolve
   * @returns Absolute path
   */
  private standardResolve(filePath: string): string {
    // Expand tilde
    let expanded = filePath;
    if (filePath.startsWith('~/')) {
      expanded = filePath.replace('~', homedir());
    } else if (filePath === '~') {
      expanded = homedir();
    }

    // Make absolute
    if (!isAbsolute(expanded)) {
      expanded = resolve(process.cwd(), expanded);
    }

    return expanded;
  }

  /**
   * Check if a path is within the focus directory (if set)
   *
   * @param filePath - Path to check
   * @returns True if path is in focus or no focus is set
   */
  isInFocus(filePath: string): boolean {
    const focusManager = this.focusManager;

    if (!focusManager) {
      return true; // No focus restriction
    }

    try {
      const resolvedPath = this.resolvePath(filePath);
      return focusManager.isPathInFocus(resolvedPath);
    } catch (error) {
      console.warn(`Error checking focus for path: ${error}`);
      return false;
    }
  }

  /**
   * Get the current focus directory, if any
   *
   * @returns Focus directory path or null if no focus is set
   */
  getFocusDirectory(): string | null {
    const focusManager = this.focusManager;
    return focusManager ? focusManager.getFocusDirectory() : null;
  }

  /**
   * Reset the cached focus manager reference
   *
   * Useful when focus manager is registered after PathResolver creation
   */
  resetFocusManager(): void {
    this._focusManager = undefined;
    this._focusManagerChecked = false;
  }
}

/**
 * Global path resolver instance
 * Lazy initialization on first access
 */
let _pathResolver: PathResolver | null = null;

/**
 * Get or create the global path resolver service
 *
 * This function ensures the PathResolver is registered in the service registry
 * and returns the singleton instance.
 *
 * @returns PathResolver instance
 */
export function getPathResolver(): PathResolver {
  if (!_pathResolver) {
    const registry = ServiceRegistry.getInstance();
    let resolver = registry.get<PathResolver>('path_resolver');

    if (!resolver) {
      resolver = new PathResolver();
      registry.registerInstance('path_resolver', resolver);
    }

    _pathResolver = resolver;
  }

  return _pathResolver;
}

/**
 * Convenience function for resolving a single path
 *
 * @param filePath - Path to resolve
 * @returns Absolute path
 */
export function resolvePath(filePath: string): string {
  return getPathResolver().resolvePath(filePath);
}

/**
 * Convenience function for resolving multiple paths
 *
 * @param filePaths - Array of paths to resolve
 * @returns Array of absolute paths
 */
export function resolvePaths(filePaths: string[]): string[] {
  return getPathResolver().resolvePaths(filePaths);
}
