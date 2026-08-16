/**
 * PathSecurity - Path traversal detection and validation utilities
 *
 * Provides security checks to prevent path traversal attacks and
 * restrict operations to the current working directory.
 *
 * Based on Python implementation: code_ally/trust.py
 */

import path from 'path';
import { cwd } from 'process';
import os from 'os';
import { logger } from '../services/Logger.js';
import { PERMISSION_MESSAGES } from '../config/constants.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { getProjectSessionsDir, getProjectPlansDir } from '../config/paths.js';
import type { ConfigManager } from '../services/ConfigManager.js';
import type { AdditionalDirectoriesManager } from '../services/AdditionalDirectoriesManager.js';
import { realpath, lstat } from 'node:fs/promises';

/**
 * Check if a path is within a parent directory (handles path boundary correctly)
 * Avoids prefix attacks where '/tmpfile' would match '/tmp' with naive startsWith
 */
function isPathWithinDirectory(childPath: string, parentPath: string): boolean {
  return childPath === parentPath || childPath.startsWith(parentPath + path.sep);
}

/** Resolve symlinks for the nearest existing ancestor of a path. */
async function canonicalizePath(inputPath: string): Promise<string> {
  const absolute = path.resolve(inputPath);
  const missing: string[] = [];
  let existing = absolute;

  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }

  return path.join(await realpath(existing), ...missing);
}

/**
 * Extra roots granted by the harness itself, beyond the project and its
 * configured directories.
 *
 * This exists because the test suite runs tools against isolated `mkdtemp`
 * directories. It replaces a `process.env.VITEST` check that sat inside this
 * function: an environment variable is set by whoever launched the process, so
 * it let anything that could influence the environment widen the filesystem
 * boundary. Granting a root now requires executing a call in-process, and
 * nothing in production does.
 */
let extraAllowedRoots: readonly string[] = [];

/**
 * Grant additional allowed roots. Intended for test setup only — see
 * `vitest.setup.ts`, the single caller. Production authorization comes from the
 * project directory, the configured temp directory, and the user's explicitly
 * added directories.
 */
export function setExtraAllowedRoots(roots: readonly string[]): void {
  extraAllowedRoots = [...roots];
}

/**
 * Symlink-aware path authorization for filesystem operations. Unlike the
 * legacy synchronous helper, this validates the path the OS will actually use.
 */
export async function isPathWithinAllowedDirectories(checkPath: string): Promise<boolean> {
  if (!checkPath || checkPath.startsWith('~')) return false;

  try {
    const canonicalPath = await canonicalizePath(checkPath);
    const roots = [cwd(), getProjectSessionsDir(), getProjectPlansDir(), ...extraAllowedRoots];

    try {
      const registry = ServiceRegistry.getInstance();
      const additional = registry.get<AdditionalDirectoriesManager>('additional_dirs_manager');
      roots.push(...(additional?.getAdditionalDirectories() ?? []));

      const configManager = registry.get<ConfigManager>('config_manager');
      const tempDir = configManager?.getConfig().temp_directory;
      if (tempDir && isSafeTempDirectory(tempDir)) roots.push(tempDir);
    } catch (error) {
      logger.debug(`Could not resolve configured path roots: ${error}`);
    }

    for (const root of roots) {
      const canonicalRoot = await canonicalizePath(root).catch(() => path.resolve(root));
      if (isPathWithinDirectory(canonicalPath, canonicalRoot)) return true;
    }
    return false;
  } catch (error) {
    logger.debug(`Error resolving canonical path '${checkPath}': ${error}`);
    return false;
  }
}

export async function assertPathWithinAllowedDirectories(checkPath: string): Promise<void> {
  if (!await isPathWithinAllowedDirectories(checkPath)) {
    throw new DirectoryTraversalError(
      `Access denied: '${checkPath}' resolves outside the allowed project directories.`
    );
  }
}

/**
 * Validate that a temp directory is in a safe location
 *
 * @param tempDir Temp directory path to validate
 * @returns true if temp directory is in a safe location, false otherwise
 */
function isSafeTempDirectory(tempDir: string): boolean {
  try {
    const absTempDir = path.resolve(tempDir);
    const systemTmpDir = path.resolve(os.tmpdir());
    const homeDir = path.resolve(os.homedir());
    const workingDir = path.resolve(cwd());

    // Allow if within system temp directory
    if (isPathWithinDirectory(absTempDir, systemTmpDir)) {
      return true;
    }

    // Allow if under /tmp or /var/tmp on Unix systems
    if (process.platform !== 'win32') {
      if (isPathWithinDirectory(absTempDir, '/tmp') || isPathWithinDirectory(absTempDir, '/var/tmp')) {
        return true;
      }
    }

    // Allow if under user's home directory
    if (isPathWithinDirectory(absTempDir, homeDir)) {
      return true;
    }

    // Allow if under current working directory
    if (isPathWithinDirectory(absTempDir, workingDir)) {
      return true;
    }

    // Not in a safe location
    return false;
  } catch (error) {
    logger.debug(`Error validating temp directory: ${error}`);
    return false;
  }
}

/**
 * Check if a path is within the current working directory, temp directory,
 * or any directory added via /add-dir
 *
 * @param checkPath Path to validate
 * @returns true if path is within an allowed directory, false otherwise
 */
export function isPathWithinCwd(checkPath: string): boolean {
  try {
    // Reject paths starting with ~ (home directory)
    // Node.js path.resolve() doesn't expand ~ like a shell does
    if (checkPath.startsWith('~')) {
      return false;
    }

    // Get the absolute path and normalize it
    const absPath = path.resolve(checkPath);

    // Get the current working directory
    const workingDir = path.resolve(cwd());

    // Check if the path is within CWD
    if (isPathWithinDirectory(absPath, workingDir)) {
      return true;
    }

    // Allow access to this project's own sessions directory. Sessions live
    // outside the working tree (under ~/.ally), but they are Ally-managed data
    // that features like session analysis must be able to read.
    try {
      if (isPathWithinDirectory(absPath, path.resolve(getProjectSessionsDir()))) {
        return true;
      }
    } catch {
      // Ignore - fall through to remaining checks
    }

    // Allow access to this project's own plans directory. Like sessions, plans
    // live outside the working tree (under ~/.ally) but are Ally-managed data
    // that must be readable (e.g. to re-open a plan written during plan mode).
    try {
      if (isPathWithinDirectory(absPath, path.resolve(getProjectPlansDir()))) {
        return true;
      }
    } catch {
      // Ignore - fall through to remaining checks
    }

    // Check additional directories and temp directory via ServiceRegistry
    try {
      const registry = ServiceRegistry.getInstance();

      // Check additional directories added via /add-dir
      const additionalDirsManager = registry.get<AdditionalDirectoriesManager>('additional_dirs_manager');
      if (additionalDirsManager?.isPathInAdditionalDirectory(absPath)) {
        return true;
      }

      // Also allow access to configured temp directory
      const configManager = registry.get<ConfigManager>('config_manager');
      if (configManager) {
        const config = configManager.getConfig();
        const tempDir = path.resolve(config.temp_directory);

        // Validate that temp directory is in a safe location
        if (!isSafeTempDirectory(tempDir)) {
          logger.warn(
            `Security: Configured temp_directory "${tempDir}" is outside safe locations. ` +
            'Access denied to prevent potential security risk.'
          );
          return false;
        }

        // Check if the path is within temp directory
        if (isPathWithinDirectory(absPath, tempDir)) {
          return true;
        }
      }
    } catch (error) {
      // If we can't get services, just use CWD check
      logger.debug(`Could not check additional directories: ${error}`);
    }

    return false;
  } catch (error) {
    logger.debug(`Error checking path traversal: ${error}`);
    // If there's an error, assume it's not safe
    return false;
  }
}

/**
 * Check if a string contains path traversal patterns
 *
 * @param inputStr String to check for path traversal patterns
 * @returns true if path traversal patterns detected, false otherwise
 */
export function hasPathTraversalPatterns(inputStr: string): boolean {
  if (!inputStr) {
    return false;
  }

  // Patterns that indicate traversal (can appear anywhere)
  const anywherePatterns = [
    '..',
    '~/',
    '$HOME',
    '${HOME}',
    '$(pwd)',
    '`pwd`',
  ];

  // First, check for dangerous patterns in the string itself
  // This catches things like "foo/../bar" which contain ".." even if they resolve safely
  for (const pattern of anywherePatterns) {
    if (inputStr.includes(pattern)) {
      return true;
    }
  }

  // Check for command substitution patterns
  if (inputStr.includes('$(') || inputStr.includes('`') || inputStr.includes('${')) {
    return true;
  }

  // Check for absolute paths - but allow if they're within the current working directory
  if (inputStr.startsWith('/')) {
    // Handle glob patterns within absolute paths
    if (inputStr.includes('*')) {
      // Extract the directory part without the glob
      let basePath = inputStr.split('*')[0] ?? '';
      if (basePath.endsWith('/')) {
        basePath = basePath.slice(0, -1);
      }
      // Check if the base directory is within CWD
      if (basePath && isPathWithinCwd(basePath)) {
        // It's a glob pattern within CWD, so it's safe
        return false;
      } else {
        // It's a glob pattern outside CWD, so it's dangerous
        return true;
      }
    } else if (isPathWithinCwd(inputStr)) {
      // It's an absolute path within CWD, so it's safe
      return false;
    } else {
      // It's an absolute path outside CWD, so it's dangerous
      return true;
    }
  }

  // For relative paths without dangerous patterns, check if they're within CWD
  if (!inputStr.startsWith('/') && !inputStr.startsWith('~')) {
    try {
      // If it doesn't resolve to within CWD, it's dangerous
      if (!isPathWithinCwd(inputStr)) {
        return true;
      }
    } catch (error) {
      // If resolution fails, consider it dangerous
      return true;
    }
  }

  // No dangerous patterns found and path is safe
  return false;
}

/**
 * Custom error for directory traversal attempts
 */
export class DirectoryTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryTraversalError';
  }
}

/**
 * Custom error for permission denied
 */
export class PermissionDeniedError extends Error {
  constructor(message: string = PERMISSION_MESSAGES.GENERIC_DENIAL) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Type guard to check if an error is a PermissionDeniedError
 *
 * @param error Error to check
 * @returns true if error is a PermissionDeniedError
 */
export function isPermissionDeniedError(error: unknown): error is PermissionDeniedError {
  return error instanceof PermissionDeniedError;
}
