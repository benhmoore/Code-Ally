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
import { isPathWithinAllowedDirectories } from './PathSecurity.js';
import { logger } from '../services/Logger.js';
import type { BaseTool } from '../tools/BaseTool.js';
import { analyzeShellCommandPaths } from './shellCommandPaths.js';

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
    args: Record<string, any>,
    tool?: BaseTool
  ): Promise<boolean> {
    // Get permission path based on the tool and arguments
    const permissionPath = await this.getPermissionPath(toolName, args, tool);

    // Path authorization is NOT done here. Every tool's path arguments are
    // authorized against the allowed roots by BaseTool from its declared schema,
    // which covers all tools rather than only the confirm-gated ones this method
    // ever saw. This method's job is now solely trust/consent.

    // Check if already trusted
    if (this.trustManager.isTrusted(toolName, permissionPath)) {
      logger.debug(`Tool ${toolName} is already trusted`);
      return true;
    }

    logger.debug(`Requesting permission for ${toolName}`);

    // Prompt for permission (this may throw PermissionDeniedError)
    return await this.trustManager.checkPermission(toolName, args, permissionPath);
  }

  /**
   * Get permission path based on tool and arguments
   *
   * @param toolName Name of the tool
   * @param args Tool arguments
   * @returns Permission path for trust checking
   */
  private async getPermissionPath(
    toolName: string,
    args: Record<string, any>,
    tool?: BaseTool
  ): Promise<CommandPath> {
    // Any tool declaring model-supplied shell execution uses command content.
    const shellCommand = tool?.getShellCommand(args)
      ?? (toolName === 'bash' && typeof args.command === 'string' ? args.command : null);
    if (shellCommand) {
      const command = shellCommand;
      const workingDir = typeof args.working_dir === 'string' ? args.working_dir : this.startDirectory;
      const outsideCwd = await this.isCommandOutsideCwd(command)
        || !await isPathWithinAllowedDirectories(workingDir);
      return {
        command,
        path: workingDir,
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
  private async isCommandOutsideCwd(command: string): Promise<boolean> {
    const analysis = analyzeShellCommandPaths(command);
    if (analysis.hasUnresolvedExpansion || analysis.hasParentTraversal) return true;
    for (const candidate of analysis.absolutePaths) {
      if (!await isPathWithinAllowedDirectories(candidate)) return true;
    }
    return false;
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
