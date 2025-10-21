/**
 * PermissionManager - Manages permission checks for tools
 *
 * Responsibilities:
 * - Check tool arguments for path traversal patterns
 * - Verify operations are within allowed directories
 * - Coordinate with TrustManager for permission prompts
 * - Enforce security boundaries
 *
 * Based on Python implementation: code_ally/agent/permission_manager.py
 */

import path from 'path';
import { cwd } from 'process';
import { TrustManager, CommandPath } from '../agent/TrustManager.js';
import {
  hasPathTraversalPatterns,
  isPathWithinCwd,
  DirectoryTraversalError,
} from './PathSecurity.js';
import { logger } from '../services/Logger.js';

/**
 * PermissionManager class
 *
 * Manages permission checks for tool execution
 */
export class PermissionManager {
  private trustManager: TrustManager;
  private startDirectory: string;
  private allowedPaths: Set<string>;

  constructor(trustManager: TrustManager) {
    this.trustManager = trustManager;
    // Store the starting directory at initialization time
    this.startDirectory = path.resolve(cwd());
    logger.debug(
      `PermissionManager initialized with starting directory: ${this.startDirectory}`
    );

    // Create a set of allowed file paths (paths within the working directory)
    this.allowedPaths = new Set();
    this.allowedPaths.add(this.startDirectory);
  }

  /**
   * Check if a tool has permission to execute
   *
   * @param toolName Name of the tool
   * @param args Tool arguments
   * @returns true if permission granted, throws DirectoryTraversalError if unsafe
   */
  async checkPermission(
    toolName: string,
    args: Record<string, any>
  ): Promise<boolean> {
    // Get permission path based on the tool and arguments
    const permissionPath = this.getPermissionPath(toolName, args);

    // Check all arguments for path traversal attempts
    this.checkAllArgumentsForTraversal(toolName, args);

    // Verify the path is within allowed directory bounds
    this.verifyDirectoryAccess(toolName, permissionPath);

    // Check if already trusted
    if (this.trustManager.isTrusted(toolName, permissionPath)) {
      console.log(`Tool ${toolName} is already trusted`);
      return true;
    }

    console.log(`Requesting permission for ${toolName}`);

    // Prompt for permission (this may throw PermissionDeniedError)
    return await this.trustManager.checkPermission(toolName, args, permissionPath);
  }

  /**
   * Check all string arguments for path traversal patterns
   *
   * @param toolName Name of the tool being used
   * @param args Tool arguments
   * @throws DirectoryTraversalError if any argument contains path traversal patterns
   */
  private checkAllArgumentsForTraversal(
    toolName: string,
    args: Record<string, any>
  ): void {
    // For bash commands, the command is validated separately
    if (toolName === 'bash' && 'command' in args) {
      return;
    }

    // Check all string arguments for path traversal patterns
    for (const [argName, argValue] of Object.entries(args)) {
      if (typeof argValue === 'string') {
        // Skip empty strings
        if (!argValue || argValue.trim() === '') {
          continue;
        }

        // Check for path traversal patterns
        if (hasPathTraversalPatterns(argValue)) {
          console.warn(
            `Path traversal pattern detected in ${toolName} argument ${argName}: ${argValue}`
          );
          throw new DirectoryTraversalError(
            `Access denied: The argument '${argName}' contains path traversal patterns. ` +
              `Operations are restricted to '${this.startDirectory}' and its subdirectories.`
          );
        }

        // Check if it's a potential file path
        if (argValue.includes('/') || argValue.includes('\\') || argValue.includes('.')) {
          try {
            // Verify it doesn't resolve to a path outside CWD
            const absPath = path.resolve(argValue);
            if (!absPath.startsWith(this.startDirectory)) {
              console.warn(
                `Path outside CWD detected in ${toolName} argument ${argName}: ${argValue}`
              );
              throw new DirectoryTraversalError(
                `Access denied: The path '${argValue}' in argument '${argName}' is outside the working directory. ` +
                  `Operations are restricted to '${this.startDirectory}' and its subdirectories.`
              );
            }
          } catch (error) {
            if (error instanceof DirectoryTraversalError) {
              throw error;
            }
            // If we can't parse it as a path, log and continue
            console.debug(
              `Could not validate potential path in ${toolName} argument ${argName}: ${error}`
            );
          }
        }
      }

      // Check string arrays recursively
      else if (Array.isArray(argValue)) {
        for (const item of argValue) {
          if (typeof item === 'string' && hasPathTraversalPatterns(item)) {
            console.warn(
              `Path traversal pattern detected in ${toolName} list argument ${argName}: ${item}`
            );
            throw new DirectoryTraversalError(
              `Access denied: The list argument '${argName}' contains path traversal patterns. ` +
                `Operations are restricted to '${this.startDirectory}' and its subdirectories.`
            );
          }
        }
      }
    }
  }

  /**
   * Verify that directory access is allowed
   *
   * @param toolName Name of the tool
   * @param permissionPath Permission path to verify
   * @throws DirectoryTraversalError if access is outside allowed directories
   */
  private verifyDirectoryAccess(toolName: string, permissionPath: CommandPath): void {
    // Extract path from permission path
    let targetPath: string | null = null;

    if (typeof permissionPath === 'string') {
      targetPath = permissionPath;
    } else if (permissionPath && typeof permissionPath === 'object') {
      if ('path' in permissionPath && permissionPath.path) {
        targetPath = permissionPath.path;
      }
    }

    // If we have a target path, verify it's within CWD
    if (targetPath) {
      if (!isPathWithinCwd(targetPath)) {
        throw new DirectoryTraversalError(
          `Access denied: ${toolName} attempted to access '${targetPath}' which is outside ` +
            `the working directory '${this.startDirectory}'.`
        );
      }
    }
  }

  /**
   * Get permission path based on tool and arguments
   *
   * @param toolName Name of the tool
   * @param args Tool arguments
   * @returns Permission path for trust checking
   */
  private getPermissionPath(
    toolName: string,
    args: Record<string, any>
  ): CommandPath {
    // Bash tool uses command content
    if (toolName === 'bash' && 'command' in args) {
      const command = args.command as string;
      const outsideCwd = this.isCommandOutsideCwd(command);
      return {
        command,
        outside_cwd: outsideCwd,
      };
    }

    // File operations use path
    if ('file_path' in args) {
      return args.file_path as string;
    }
    if ('path' in args) {
      return args.path as string;
    }
    if ('pattern' in args && typeof args.pattern === 'string') {
      // For glob/grep
      return args.pattern;
    }

    // Default: tool name only
    return null;
  }

  /**
   * Check if a bash command operates outside CWD
   *
   * @param command Bash command
   * @returns true if command operates outside CWD
   */
  private isCommandOutsideCwd(command: string): boolean {
    // Simple heuristic: check for path traversal patterns
    return hasPathTraversalPatterns(command);
  }

  /**
   * Get the starting directory
   *
   * @returns Starting directory path
   */
  getStartDirectory(): string {
    return this.startDirectory;
  }
}
