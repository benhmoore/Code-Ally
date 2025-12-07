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
import type { ConfigManager } from '../services/ConfigManager.js';

/**
 * Check if a path is within a parent directory (handles path boundary correctly)
 * Avoids prefix attacks where '/tmpfile' would match '/tmp' with naive startsWith
 */
function isPathWithinDirectory(childPath: string, parentPath: string): boolean {
  return childPath === parentPath || childPath.startsWith(parentPath + path.sep);
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
 * Check if a path is within the current working directory or temp directory
 *
 * @param checkPath Path to validate
 * @returns true if path is within CWD or temp directory, false otherwise
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

    // Also allow access to configured temp directory
    try {
      const registry = ServiceRegistry.getInstance();
      const configManager = registry.get<ConfigManager>('config');
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
      // If we can't get config, just use CWD check
      logger.debug(`Could not check temp directory: ${error}`);
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
 * Check if a command contains extremely dangerous path patterns
 *
 * @param command Command to check
 * @returns true if command contains dangerous patterns, false otherwise
 */
export function hasDangerousPathPatterns(command: string): boolean {
  const dangerousPatterns = [
    '/etc/passwd',
    '/etc/shadow',
    '/etc/sudoers',
    '/boot/',
    '/sys/',
    '/proc/',
    '/dev/sd', // Disk devices
    '$(pwd)',
    '`pwd`',
    '${HOME}',
    '$HOME/.*', // Home directory access via variables
  ];

  const normalizedCommand = command.toLowerCase();

  return dangerousPatterns.some((pattern) =>
    normalizedCommand.includes(pattern.toLowerCase())
  );
}

/**
 * Sensitivity tiers for commands
 */
export enum CommandSensitivityTier {
  EXTREMELY_SENSITIVE = 'EXTREMELY_SENSITIVE',
  SENSITIVE = 'SENSITIVE',
  NORMAL = 'NORMAL',
}

/**
 * Determine the sensitivity tier of a command
 *
 * @param command Command to classify
 * @returns Sensitivity tier
 */
export function getCommandSensitivityTier(command: string): CommandSensitivityTier {
  if (!command || !command.trim()) {
    return CommandSensitivityTier.NORMAL;
  }

  const normalizedCommand = command.toLowerCase();

  // Extremely sensitive patterns
  const extremelyDangerousPatterns = [
    'rm -rf /',
    'rm -rf /*',
    'rm -rf ~',
    'rm -rf ~/*',
    ':(){:|:&};:',
    'mkfs',
    'dd if=',
    'dd of=/dev/',
    '> /dev/sd',
    'wget',
    'curl',
    'nc ',
    'netcat',
    '/etc/passwd',
    '/etc/shadow',
    'sudo ',
    'chmod 777',
    'chmod -R 777',
  ];

  for (const pattern of extremelyDangerousPatterns) {
    if (normalizedCommand.includes(pattern.toLowerCase())) {
      return CommandSensitivityTier.EXTREMELY_SENSITIVE;
    }
  }

  // Sensitive patterns
  const sensitivePatterns = [
    'rm ',
    'mv ',
    'cp ',
    'chmod',
    'chown',
    'git push',
    'git reset --hard',
    'npm publish',
    'pip install',
  ];

  for (const pattern of sensitivePatterns) {
    if (normalizedCommand.includes(pattern.toLowerCase())) {
      return CommandSensitivityTier.SENSITIVE;
    }
  }

  return CommandSensitivityTier.NORMAL;
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
