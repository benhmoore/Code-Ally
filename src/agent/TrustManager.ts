/**
 * TrustManager - Handles tool execution permissions and user confirmations
 *
 * Manages permission flows for potentially destructive operations, including:
 * - Session-based trust tracking
 * - User permission prompts with keyboard navigation
 * - Command sensitivity analysis for bash operations
 * - Batch operation permissions
 * - Trust scope management (once, session, path, global)
 *
 * Security Model:
 * - Non-destructive tools (read, glob, grep) never require confirmation
 * - Sensitive tools (write, edit, bash) require user permission
 * - Extremely sensitive commands (rm with wildcards, system commands) disable "Always Allow"
 * - Session-based trust (cleared on exit, no persistence)
 */

import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityEventType, ActivityEvent } from '../types/index.js';
import { TEXT_LIMITS, PERMISSION_MESSAGES } from '../config/constants.js';
import { PermissionDeniedError } from '../security/PathSecurity.js';
import { logger } from '../services/Logger.js';

/**
 * Trust scope levels for permission management
 */
export enum TrustScope {
  /** Trust for this single operation only */
  ONCE = 'once',
  /** Trust for current session only */
  SESSION = 'session',
  /** Trust for specific file/directory */
  PATH = 'path',
  /** Trust globally (represented by '*' internally) */
  GLOBAL = 'global',
}

/**
 * Command sensitivity classification
 */
export enum SensitivityTier {
  /** Normal operations */
  NORMAL = 'NORMAL',
  /** Destructive single-file operations */
  SENSITIVE = 'SENSITIVE',
  /** Multi-file or system-level destructive operations */
  EXTREMELY_SENSITIVE = 'EXTREMELY_SENSITIVE',
}

/**
 * Permission path type (for context-specific trust)
 */
export type CommandPath = string | { command?: string; path?: string; outside_cwd?: boolean } | null;

/**
 * User permission choice
 */
export enum PermissionChoice {
  ALLOW = 'Allow',
  DENY = 'Deny',
  ALWAYS_ALLOW = 'Always Allow',
}

/**
 * TrustManager class
 *
 * Core responsibilities:
 * 1. Track trusted tools per session
 * 2. Prompt users for permissions when needed
 * 3. Analyze command sensitivity
 * 4. Manage batch operation permissions
 * 5. Support auto-confirm mode for scripting
 */
export class TrustManager {
  /**
   * Auto-confirm flag (dangerous - for scripting/testing only)
   */
  private autoConfirm: boolean;

  /**
   * Session-based trust storage
   * Map of tool name -> set of trusted paths/scopes
   */
  private trustedTools: Map<string, Set<string>>;

  /**
   * Pre-approved operations for batch processing
   * Set of operation keys that have been approved in advance
   */
  private preApprovedOperations: Set<string>;

  /**
   * Activity stream for event-based permission prompts
   */
  private activityStream?: ActivityStream;

  /**
   * Auto-allow mode getter function
   * When enabled, automatically approves non-EXTREMELY_SENSITIVE commands
   */
  private autoAllowModeGetter?: () => boolean;

  /**
   * Pending permission requests waiting for response
   */
  private pendingPermissions: Map<
    string,
    {
      resolve: (choice: PermissionChoice) => void;
      reject: (error: Error) => void;
    }
  > = new Map();

  constructor(autoConfirm: boolean = false, activityStream?: ActivityStream, autoAllowModeGetter?: () => boolean) {
    this.autoConfirm = autoConfirm;
    this.trustedTools = new Map();
    this.preApprovedOperations = new Set();
    this.activityStream = activityStream;
    this.autoAllowModeGetter = autoAllowModeGetter;

    // Listen for permission responses if ActivityStream is provided
    if (this.activityStream) {
      this.activityStream.subscribe(ActivityEventType.PERMISSION_RESPONSE, (event: ActivityEvent) => {
        this.handlePermissionResponse(event);
      });
    }
  }

  /**
   * Check if user permission is required and request if needed
   *
   * @param toolName - Name of the tool requesting permission
   * @param args - Tool arguments (for context)
   * @param path - Context-specific path/command
   * @returns True if permission granted, throws PermissionDeniedError if denied
   */
  async checkPermission(toolName: string, args: any, path?: CommandPath): Promise<boolean> {
    // Auto-confirm mode bypasses all permission checks
    if (this.autoConfirm) {
      return true;
    }

    // Check if tool is already trusted
    if (this.isTrusted(toolName, path)) {
      return true;
    }

    // Prompt user for permission
    return this.promptForPermission(toolName, args, path);
  }

  /**
   * Prompt user for permission with keyboard navigation menu
   *
   * @param toolName - Name of the tool requesting permission
   * @param args - Tool arguments for display
   * @param path - Context-specific path/command
   * @returns True if allowed, throws PermissionDeniedError if denied
   */
  async promptForPermission(toolName: string, args: any, path?: CommandPath): Promise<boolean> {
    // Require ActivityStream for permission prompts
    if (!this.activityStream) {
      throw new Error('ActivityStream is required for permission prompts');
    }

    // Detect command sensitivity tier
    const tier = this.getCommandSensitivity(toolName, path);

    // Auto-allow mode: automatically approve non-EXTREMELY_SENSITIVE commands
    // Security constraint: EXTREMELY_SENSITIVE commands ALWAYS require explicit user approval
    if (this.autoAllowModeGetter?.() && tier !== SensitivityTier.EXTREMELY_SENSITIVE) {
      logger.debug(`[TrustManager] Auto-allowing ${toolName} (auto-allow mode enabled)`);
      this.trustTool(toolName, TrustScope.GLOBAL);
      return true;
    }

    // Determine available options based on sensitivity
    const options =
      tier === SensitivityTier.EXTREMELY_SENSITIVE
        ? [PermissionChoice.ALLOW, PermissionChoice.DENY]
        : [PermissionChoice.ALLOW, PermissionChoice.DENY, PermissionChoice.ALWAYS_ALLOW];

    // Get user choice with event-based UI
    const choice = await this.showPermissionMenu(toolName, args, path, options);

    // Handle user selection
    switch (choice) {
      case PermissionChoice.ALLOW:
        // One-time permission - just return true (permission already granted)
        // Do NOT add to preApprovedOperations (that's only for batch operations)
        return true;

      case PermissionChoice.ALWAYS_ALLOW:
        // Session-wide trust - add to trusted tools
        this.trustTool(toolName, TrustScope.GLOBAL);
        return true;

      case PermissionChoice.DENY:
        throw new PermissionDeniedError(PERMISSION_MESSAGES.toolSpecificDenial(toolName));

      default:
        throw new PermissionDeniedError(`Unknown permission choice: ${choice}`);
    }
  }

  /**
   * Prompt for batch operation permissions
   *
   * Used when multiple tools need to execute in sequence.
   *
   * @param toolCalls - Array of tool call objects with {function: {name, arguments}}
   * @returns True if permission granted, false if denied
   */
  async promptForBatchOperations(toolCalls: Array<{ function: { name: string; arguments: any } }>): Promise<boolean> {
    // Auto-confirm mode bypasses all checks
    if (this.autoConfirm) {
      // Pre-approve all operations
      for (const call of toolCalls) {
        this.markOperationAsApproved(call.function.name, null);
      }
      return true;
    }

    // Check if any command is extremely sensitive
    const hasExtremelySensitive = toolCalls.some(call => {
      const tier = this.getCommandSensitivity(call.function.name, null);
      return tier === SensitivityTier.EXTREMELY_SENSITIVE;
    });

    // Show appropriate menu based on sensitivity
    const options = hasExtremelySensitive
      ? [PermissionChoice.ALLOW, PermissionChoice.DENY]
      : [PermissionChoice.ALLOW, PermissionChoice.DENY, PermissionChoice.ALWAYS_ALLOW];

    // Pass batch operation context to permission menu
    const choice = await this.showPermissionMenu(
      'batch',
      { operations: toolCalls.map(tc => tc.function.name) },
      undefined,
      options
    );

    switch (choice) {
      case PermissionChoice.ALLOW:
        // Pre-approve all operations for this batch
        for (const call of toolCalls) {
          this.markOperationAsApproved(call.function.name, null);
        }
        return true;

      case PermissionChoice.ALWAYS_ALLOW:
        // Trust all tools in the batch
        for (const call of toolCalls) {
          this.trustTool(call.function.name, TrustScope.GLOBAL);
          this.markOperationAsApproved(call.function.name, null);
        }
        return true;

      case PermissionChoice.DENY:
        return false;

      default:
        return false;
    }
  }

  /**
   * Check if a tool is already trusted for the given context
   *
   * @param toolName - Name of the tool
   * @param path - Context-specific path/command
   * @returns True if trusted, false otherwise
   */
  isTrusted(toolName: string, path?: CommandPath): boolean {
    // Check pre-approved operations first (one-time approvals)
    const operationKey = this.getOperationKey(toolName, path);
    if (this.preApprovedOperations.has(operationKey)) {
      // Consume one-time approval (remove it so it only works once)
      // Note: "Always Allow" also adds to trustedTools, so it will still work
      this.preApprovedOperations.delete(operationKey);
      return true;
    }

    // Check trusted tools
    const trustedPaths = this.trustedTools.get(toolName);
    if (!trustedPaths) {
      return false;
    }

    // Check for global trust (*)
    if (trustedPaths.has('*')) {
      return true;
    }

    // Check for path-specific trust
    if (typeof path === 'string') {
      // Exact path match
      if (trustedPaths.has(path)) {
        return true;
      }

      // Check parent directory trust (TODO: implement if needed)
      // For now, exact match only
    }

    return false;
  }

  /**
   * Mark a tool as trusted for the specified scope
   *
   * @param toolName - Name of the tool to trust
   * @param scope - Trust scope (once, session, path, global)
   * @param path - Specific path for path-scoped trust
   */
  trustTool(toolName: string, scope: TrustScope, path?: string): void {
    if (!this.trustedTools.has(toolName)) {
      this.trustedTools.set(toolName, new Set());
    }

    const trustedPaths = this.trustedTools.get(toolName)!;

    switch (scope) {
      case TrustScope.GLOBAL:
      case TrustScope.SESSION:
        // Global/session trust represented by '*'
        trustedPaths.add('*');
        break;

      case TrustScope.PATH:
        // Path-specific trust
        if (path) {
          trustedPaths.add(path);
        }
        break;

      case TrustScope.ONCE:
        // Once scope doesn't add to trusted tools
        // It's handled via pre-approved operations
        break;
    }
  }

  /**
   * Mark an operation as pre-approved (for batch processing)
   *
   * @param toolName - Name of the tool
   * @param path - Context-specific path/command
   */
  markOperationAsApproved(toolName: string, path?: CommandPath): void {
    const operationKey = this.getOperationKey(toolName, path);
    this.preApprovedOperations.add(operationKey);
  }

  /**
   * Set the auto-allow mode getter function
   * This should be called after UI initialization to connect the UI state
   *
   * @param getter - Function that returns the current auto-allow mode state
   */
  setAutoAllowModeGetter(getter: () => boolean): void {
    this.autoAllowModeGetter = getter;
  }

  /**
   * Check if a bash command is sensitive and requires confirmation
   *
   * @param command - The bash command to check
   * @returns True if command is sensitive
   */
  isSensitiveCommand(command: string): boolean {
    const tier = this.getCommandSensitivityForBash(command);
    return tier !== SensitivityTier.NORMAL;
  }

  /**
   * Get the sensitivity tier for a command
   *
   * @param toolName - Name of the tool
   * @param path - Context-specific path/command
   * @returns Sensitivity tier
   */
  getCommandSensitivity(toolName: string, path?: CommandPath): SensitivityTier {
    // Bash tool uses command content analysis
    if (toolName === 'bash' && path && typeof path === 'object') {
      const command = path.command;
      if (command) {
        return this.getCommandSensitivityForBash(command);
      }
    }

    // Outside CWD access is extremely sensitive
    if (path && typeof path === 'object' && path.outside_cwd) {
      return SensitivityTier.EXTREMELY_SENSITIVE;
    }

    // Default to normal
    return SensitivityTier.NORMAL;
  }

  /**
   * Analyze bash command sensitivity
   *
   * @param command - The bash command to analyze
   * @returns Sensitivity tier
   */
  private getCommandSensitivityForBash(command: string): SensitivityTier {
    const cmdLower = command.toLowerCase();

    // Check extremely sensitive commands
    for (const dangerous of EXTREMELY_SENSITIVE_COMMANDS) {
      if (cmdLower.includes(dangerous.toLowerCase())) {
        return SensitivityTier.EXTREMELY_SENSITIVE;
      }
    }

    // Check extremely sensitive patterns
    for (const pattern of EXTREMELY_SENSITIVE_PATTERNS) {
      if (pattern.test(command)) {
        return SensitivityTier.EXTREMELY_SENSITIVE;
      }
    }

    // Check sensitive patterns
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(command)) {
        return SensitivityTier.SENSITIVE;
      }
    }

    // Check sensitive command prefixes
    for (const prefix of SENSITIVE_COMMAND_PREFIXES) {
      if (command.startsWith(prefix)) {
        return SensitivityTier.SENSITIVE;
      }
    }

    return SensitivityTier.NORMAL;
  }

  /**
   * Reset session trust (clear all trusted tools and pre-approved operations)
   */
  reset(): void {
    this.trustedTools.clear();
    this.preApprovedOperations.clear();
  }

  /**
   * Show permission menu using ActivityStream events (Ink UI)
   */
  private async showPermissionMenu(
    toolName: string,
    args: any,
    path: CommandPath | undefined,
    options: PermissionChoice[]
  ): Promise<PermissionChoice> {
    return new Promise((resolve, reject) => {
      // Generate unique ID for permission request: perm_{timestamp}_{7-char-random} (base-36, skip '0.' prefix)
      const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      // Store resolver so we can complete it when response arrives
      // No timeout - user must explicitly permit or deny
      this.pendingPermissions.set(requestId, {
        resolve: (choice: PermissionChoice) => {
          resolve(choice);
        },
        reject: (error: Error) => {
          reject(error);
        },
      });

      // Extract command string for display if this is a bash operation
      let command: string | undefined;
      if (toolName === 'bash' && path && typeof path === 'object') {
        command = path.command;
      }

      // Determine sensitivity
      const sensitivity = this.getCommandSensitivity(toolName, path);

      // Emit permission request event
      this.activityStream!.emit({
        id: requestId,
        type: ActivityEventType.PERMISSION_REQUEST,
        timestamp: Date.now(),
        data: {
          requestId,
          toolName,
          path: typeof path === 'string' ? path : undefined,
          command,
          arguments: args,
          sensitivity,
          options,
        },
      });
    });
  }

  /**
   * Handle permission response from UI
   */
  private handlePermissionResponse(event: ActivityEvent): void {
    const { requestId, choice } = event.data;

    // Find pending permission request
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      logger.error(`Unknown permission request ID: ${requestId}`);
      return;
    }

    // Remove from pending and resolve with choice
    this.pendingPermissions.delete(requestId);
    pending.resolve(choice);
  }

  /**
   * Generate operation key for trust cache
   *
   * @param toolName - Name of the tool
   * @param path - Context-specific path/command
   * @returns Operation key
   */
  private getOperationKey(toolName: string, path?: CommandPath): string {
    // Bash tool: truncate command to 50 chars for key
    if (toolName === 'bash' && path && typeof path === 'object') {
      const command = path.command || '';
      return `bash:${command.substring(0, TEXT_LIMITS.DESCRIPTION_MAX)}`;
    }

    // File operations: use absolute path (TODO: normalize path)
    if (typeof path === 'string') {
      return `${toolName}:${path}`;
    }

    // No path: tool name only
    return toolName;
  }
}

// ============================================================================
// Security Command Lists (from Python implementation)
// ============================================================================

/**
 * Commands that are extremely dangerous and require "Allow/Deny" prompt only
 * (no "Always Allow" option)
 */
const EXTREMELY_SENSITIVE_COMMANDS: string[] = [
  // System destruction
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf ~/',
  'rm -rf .',
  'rm -rf ./',
  'rm -rf --no-preserve-root /',
  'find / -delete',
  'find ~ -delete',

  // Dangerous disk operations
  'dd if=/dev/zero',
  '> /dev/sda',
  'mkfs',
  'fdisk',
  'parted',

  // Destructive system operations
  ':(){ :|:& };:', // Fork bomb
  'shutdown',
  'poweroff',
  'reboot',
  'halt',
  'systemctl poweroff',
  'systemctl reboot',
  'systemctl halt',

  // Remote code execution
  'wget -O- | bash',
  'curl | bash',
  'wget | sh',
  'curl | sh',
  'curl -s | bash',

  // Dangerous network tools
  'nc -l',
  'netcat -l',
  'socat',
  'ncat -l',

  // Privilege escalation attempts
  'sudo su',
  'sudo -i',
  'sudo bash',
  'sudo sh',

  // System configuration changes
  'passwd',
  'usermod',
  'userdel',
  'groupmod',
  'visudo',

  // Critical system files
  'rm /etc/passwd',
  'rm /etc/shadow',
  'rm /boot/*',
];

/**
 * Regex patterns for extremely sensitive commands
 */
const EXTREMELY_SENSITIVE_PATTERNS: RegExp[] = [
  /^rm\s+(-[rf]+|--recursive|--force).*/, // rm with recursive/force flags
  /^rm\s+.*\*/, // rm with wildcards
  /^rm\s+.*\s+.*/, // rm with multiple arguments
  /dd\s+if=\/dev\/zero\s+of=/, // Disk wiping
  />\s*\/dev\/sd[a-z]/, // Writing to disk devices
  /curl\s+.+\s*\|\s*(bash|sh|zsh)/, // Piping curl to shell
  /wget\s+.+\s*\|\s*(bash|sh|zsh)/, // Piping wget to shell
  /ssh\s+.+\s+'.*'/, // SSH with commands
  /sudo\s+(su|bash|sh|zsh)/, // Privilege escalation
  /chmod\s+777\s+\/(\s|$)/, // Dangerous permissions on root
  /chown\s+.*\s+\/(\s|$)/, // Ownership changes on root
  /ls\s+.*\*/, // File listing with globs
  /\*.*\|/, // Commands with wildcards and pipes
  /\/.*\*/, // Absolute paths with wildcards
  /\/Users\/[^/]+\/\.[^/]+/, // Access to hidden directories
  /\/opt\//, // Access to /opt
  /\/usr\/local/, // Access to /usr/local
  /eval\s+.+/, // Eval with commands
];

/**
 * Patterns for sensitive commands (require permission but allow "Always Allow")
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /ls\s+(-[alFhrt]+\s+)?(\.\.|\/|\~)[\/]?/, // List files outside CWD
  /cat\s+(\.\.|\/|\~)[\/]?/, // Cat files outside CWD
  /more\s+(\.\.|\/|\~)[\/]?/, // More files outside CWD
  /less\s+(\.\.|\/|\~)[\/]?/, // Less files outside CWD
  /head\s+(\.\.|\/|\~)[\/]?/, // Head files outside CWD
  /tail\s+(\.\.|\/|\~)[\/]?/, // Tail files outside CWD
  /grep\s+.+\s+(\.\.|\/|\~)[\/]?/, // Grep outside CWD
  /find\s+(\.\.|\/|\~)[\/]?\s+/, // Find outside CWD
  /^rm\s+[^\s\-\*]+$/, // Single file rm (no flags, wildcards, or multiple args)
];

/**
 * Command prefixes that require permission (SENSITIVE tier)
 */
const SENSITIVE_COMMAND_PREFIXES: string[] = [
  'sudo ',
  'su ',
  'chown ',
  'chmod ',
  'rm -r',
  'rm -f',
  'mv /* ',
  'cp /* ',
  'ln -s ',
  'wget ',
  'curl ',
  'ssh ',
  'scp ',
  'rsync ',
  'ls ..',
  'ls ../',
  'ls /',
  'ls ~/',
  'cat ../',
  'cat /',
  'cat ~/',
  'grep ../',
  'grep /',
  'grep ~/',
  'find ../',
  'find /',
  'find ~/',
  'head ../',
  'head /',
  'head ~/',
  'tail ../',
  'tail /',
  'tail ~/',
];
