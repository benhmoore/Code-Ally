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

/**
 * Check if a path is within the current working directory
 *
 * @param checkPath Path to validate
 * @returns true if path is within CWD, false otherwise
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

    // Check if the path starts with CWD
    // This ensures the path is within the current working directory or its subdirectories
    return absPath.startsWith(workingDir);
  } catch (error) {
    console.warn(`Error checking path traversal: ${error}`);
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

  const traversalPatterns = [
    '..',
    '/../',
    '/./',
    '~/',
    '$HOME',
    '${HOME}',
    '$(pwd)',
    '`pwd`',
    '/etc/',
    '/var/',
    '/usr/',
    '/bin/',
    '/tmp/',
    '/root/',
    '/proc/',
    '/sys/',
    '/dev/',
    '/*',
    '~/*',
  ];

  // Check for absolute paths - but allow if they're within the current working directory
  if (inputStr.startsWith('/') || inputStr.startsWith('~')) {
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

  // Check for common path traversal patterns, but exclude safe glob patterns
  for (const pattern of traversalPatterns) {
    if (inputStr.includes(pattern)) {
      // Special case: allow /*/ within CWD glob patterns
      if (pattern === '/*' && inputStr.startsWith('/') && inputStr.includes('*')) {
        // Already handled above in glob pattern logic
        continue;
      }
      return true;
    }
  }

  // Check for environment variable usage that could lead to path traversal
  return inputStr.includes('$(') || inputStr.includes('`') || inputStr.includes('${');
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
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}
