import path from 'node:path';
/** One consent boundary: explicit run policy, exact session grants, selective review, then human approval. */

import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityEventType, ActivityEvent } from '../types/index.js';
import { API_TIMEOUTS, PERMISSION_MESSAGES } from '../config/constants.js';
import { PermissionDeniedError, PolicyDeniedError } from '../security/PathSecurity.js';
import { logger } from '../services/Logger.js';
import type { ScheduledTaskPermissionPolicy } from '../services/ScheduledTaskManager.js';
import type { RunPolicyManager } from '../services/RunPolicyManager.js';
import { evaluateRunAuthorization, type RunAuthorizationPolicy } from '../security/RunAuthorizationPolicy.js';

import type { PermissionMode } from '../security/PermissionMode.js';
import type { PermissionPolicyService, PermissionEvaluation } from '../services/PermissionPolicyService.js';

export interface PermissionContext {
  toolMetadata?: import('../security/ToolPermissionMetadata.js').ToolPermissionMetadata;
  onDecision?: (decision: import('../security/PermissionDecision.js').PermissionDecision) => void;
  requiresConfirmation: boolean;
  workspaceRoot: string;
  task?: string;
  signal?: AbortSignal;
}

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
  ALWAYS_ALLOW = 'Allow This Target',
  INSTRUCT = 'Tell Ally what to do differently',
}

/**
 * TrustManager class
 *
 * Core responsibilities:
 * 1. Track trusted tools per session
 * 2. Prompt users for permissions when needed
 * 3. Analyze command sensitivity
 * 4. Apply explicit permission modes
 */
export class TrustManager {
  /**
   * Requested mode when no runtime policy service is installed
   */
  private permissionMode: PermissionMode;
  private readonly subscriptions: Array<() => void> = [];
  private permissionPolicy?: PermissionPolicyService;

  /**
   * Session-based trust storage
   * Map of tool name -> set of trusted paths/scopes
   */
  private trustedTools: Map<string, Set<string>>;

  /**
   * Activity stream for event-based permission prompts
   */
  private activityStream?: ActivityStream;

  /** Central interaction policy. When absent, behavior remains interactive. */
  private runPolicyManager?: RunPolicyManager;

  /**
   * Optional authorization policy for this run, consulted before trust and
   * prompting. A denied match always throws; an allowed match always passes.
   */
  private authorizationPolicy?: RunAuthorizationPolicy;

  /**
   * Strict policies deny anything they do not name, which is what an
   * unattended scheduled run needs. Non-strict policies let an unnamed tool
   * fall through to the ordinary trust and interaction checks.
   */
  private authorizationStrict = false;

  /**
   * Delegation info getter function
   * Returns the agent display name if there's an active delegation (sub-agent running)
   * Used to decide whether to show INSTRUCT (with agent name) or DENY (no delegation)
   */
  private getActiveDelegationNameGetter?: () => string | undefined;

  /**
   * Pending permission requests waiting for response
   */
  private pendingPermissions: Map<
    string,
    {
      resolve: (choice: PermissionChoice) => void;
      reject: (error: Error) => void;
      timeoutId: NodeJS.Timeout;
    }
  > = new Map();

  constructor(permissionMode: PermissionMode = 'manual', activityStream?: ActivityStream) {
    this.permissionMode = permissionMode;
    this.trustedTools = new Map();
    this.activityStream = activityStream;

    // Listen for permission responses if ActivityStream is provided
    if (this.activityStream) {
      this.subscriptions.push(
        this.activityStream.subscribe(ActivityEventType.PERMISSION_RESPONSE, event => {
          this.handlePermissionResponse(event);
        })
      );

      // Reject any pending permission prompts when the user interrupts the
      // agent, so the awaiting tool unwinds immediately instead of hanging
      // until the 2-minute timeout. The UI clears the prompt separately on
      // the same event (see useActivitySubscriptions).
      this.subscriptions.push(
        this.activityStream.subscribe(ActivityEventType.USER_INTERRUPT_INITIATED, () => {
          this.cancelAllPending();
        })
      );
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
  async checkPermission(
    toolName: string,
    args: Record<string, unknown>,
    path?: CommandPath,
    context?: PermissionContext
  ): Promise<boolean> {
    if (context?.signal?.aborted) throw new PermissionDeniedError('Permission request interrupted');
    if (this.authorizationPolicy && this.checkPolicy(toolName, args, path)) return true;
    if (this.isTrusted(toolName, path)) return true;
    const mode = this.permissionPolicy?.getSnapshot().requestedMode ?? this.permissionMode;
    if (mode === 'allow-all') {
      if (this.getCommandSensitivity(toolName, path) === SensitivityTier.EXTREMELY_SENSITIVE) {
        throw new PolicyDeniedError(
          'Allow-all does not permit this extremely sensitive operation',
          'allow_all.extremely_sensitive',
          ['Narrow the operation or use Manual mode for explicit approval']
        );
      }
      return true;
    }
    let reason: string | undefined;
    if (mode === 'auto' && this.permissionPolicy) {
      const startedInManual = this.permissionPolicy.getSnapshot().effectiveMode === 'manual';
      const input: PermissionEvaluation = {
        toolMetadata: context?.toolMetadata,
        toolName,
        args,
        workspaceRoot: context?.workspaceRoot ?? process.cwd(),
        task: context?.task,
        signal: context?.signal,
      };
      const result = await this.permissionPolicy.evaluate(input);
      // Audit observers cannot alter the authorization result being enforced.
      context?.onDecision?.(Object.freeze({ ...result }));
      if (context?.signal?.aborted) throw new PermissionDeniedError('Permission review interrupted');
      if (result.verdict === 'allow') return true;
      if (result.verdict === 'deny')
        throw new PolicyDeniedError(result.reason, 'auto.denied', [
          'Choose an action consistent with the task or request explicit approval in Manual mode',
        ]);
      reason = result.reason;
      // Manual fallback preserves ordinary read-only behavior, but a live Auto
      // policy's explicit ask must not be bypassed by tool capability metadata.
      if (startedInManual && context?.requiresConfirmation === false) return true;
    } else if (context?.requiresConfirmation === false) return true;
    return this.promptForPermission(toolName, args, path, reason, context?.signal);
  }

  setPermissionPolicy(service: PermissionPolicyService): void {
    this.permissionPolicy = service;
  }
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /**
   * Install the authorization policy for this run.
   *
   * @param policy - Policy to install, or undefined to clear.
   * @param options.strict - Deny anything the policy does not name.
   */
  setRunAuthorizationPolicy(policy?: RunAuthorizationPolicy, options?: { strict?: boolean }): void {
    this.authorizationPolicy = policy;
    this.authorizationStrict = options?.strict ?? false;
  }

  /** Install a scheduled task preset, which is always deny-by-default. */
  setScheduledPermissionPolicy(policy?: ScheduledTaskPermissionPolicy): void {
    this.setRunAuthorizationPolicy(policy, { strict: true });
  }

  /** Tool name globs this run can never call, for schema-level exclusion. */
  getDisallowedToolPatterns(): readonly string[] {
    return this.authorizationPolicy?.disallowed_tools ?? [];
  }

  setRunPolicyManager(manager: RunPolicyManager): void {
    this.runPolicyManager = manager;
  }

  /**
   * Apply the installed policy. Returns true when the policy grants the call,
   * false when it defers to the tiers below, and throws when it denies.
   */
  private checkPolicy(toolName: string, args: any, path?: CommandPath): boolean {
    const policy = this.authorizationPolicy;
    if (!policy) return false;

    const command =
      typeof path === 'object' && path?.command ? path.command : typeof args?.command === 'string' ? args.command : '';
    const decision = evaluateRunAuthorization(policy, toolName, command);
    if (decision.verdict === 'allow') {
      return true;
    }
    if (decision.verdict === 'defer' && !this.authorizationStrict) {
      return false;
    }

    const subject = 'Run policy';
    switch (decision.reason) {
      case 'policy.disallowed_tools':
        throw new PolicyDeniedError(`${subject} denied tool: ${toolName}`, decision.reason, [
          'Use a tool that the run policy does not deny',
        ]);
      case 'policy.denied_bash_patterns':
        throw new PolicyDeniedError(`${subject} denied shell command: ${command}`, decision.reason, [
          'Use a non-shell tool',
          'Choose a command the run policy allows',
        ]);
      case 'policy.allowed_bash_commands':
        throw new PolicyDeniedError(`${subject} is not allowed to run shell command: ${command}`, decision.reason, [
          'Use a non-shell tool',
          'Choose a command allowed by the run policy',
        ]);
      case 'policy.allowed_tools':
        throw new PolicyDeniedError(`${subject} is not allowed to use ${toolName}`, decision.reason, [
          'Use an allowed read-only tool',
          'Choose a policy-compliant alternative',
        ]);
    }
  }

  /**
   * Prompt user for permission with keyboard navigation menu
   *
   * @param toolName - Name of the tool requesting permission
   * @param args - Tool arguments for display
   * @param path - Context-specific path/command
   * @returns True if allowed, throws PermissionDeniedError if denied
   */
  private async promptForPermission(
    toolName: string,
    args: any,
    path?: CommandPath,
    decisionReason?: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    // Detect command sensitivity tier
    const tier = this.getCommandSensitivity(toolName, path);

    if (this.runPolicyManager && !this.runPolicyManager.isInteractionAvailable()) {
      throw new PolicyDeniedError(`Automatic run cannot request permission for ${toolName}`, 'interaction.none', [
        'Use a tool that does not require confirmation',
        'Choose a policy-allowed operation',
      ]);
    }

    // Require ActivityStream only after noninteractive policy decisions have
    // been resolved; headless runs must receive a structured denial, not a
    // missing-UI implementation error.
    if (!this.activityStream) {
      throw new Error('ActivityStream is required for permission prompts');
    }

    // Determine available options based on sensitivity
    // Always show INSTRUCT option - user can press Escape to deny without instruction
    const activeDelegationName = this.getActiveDelegationNameGetter?.();
    const instructOption = activeDelegationName
      ? `Tell ${activeDelegationName} what to do instead...`
      : 'Tell Ally what to do instead...';
    const options =
      tier === SensitivityTier.EXTREMELY_SENSITIVE
        ? [PermissionChoice.ALLOW, instructOption]
        : [PermissionChoice.ALLOW, PermissionChoice.ALWAYS_ALLOW, instructOption];

    // Get user choice with event-based UI
    const choice = await this.showPermissionMenu(toolName, args, path, options, decisionReason, signal);

    // Handle user selection
    switch (choice) {
      case PermissionChoice.ALLOW:
        // One-time permission - just return true (permission already granted)
        return true;

      case PermissionChoice.ALWAYS_ALLOW:
        // Scope trust to this exact file or command for the current session.
        this.trustTool(toolName, TrustScope.PATH, this.getTrustPath(path));
        return true;

      case PermissionChoice.DENY:
        throw new PermissionDeniedError(PERMISSION_MESSAGES.toolSpecificDenial(toolName));

      case PermissionChoice.INSTRUCT:
        // INSTRUCT is handled in the UI layer (InputPrompt) which sends the instruction
        // as an interjection and emits DENY. This case should be unreachable, but if
        // reached, treat as DENY for safety.
        throw new PermissionDeniedError(PERMISSION_MESSAGES.toolSpecificDenial(toolName));

      default:
        throw new PermissionDeniedError(`Unknown permission choice: ${choice}`);
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
    const trustPath = this.getTrustPath(path);
    if (trustPath && trustedPaths.has(trustPath)) return true;

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
        break;
    }
  }

  /**
   * Set the delegation name getter function
   * This should be called after ToolManager initialization to connect delegation state
   *
   * @param getter - Function that returns the agent display name if there's an active delegation, undefined otherwise
   */
  setActiveDelegationNameGetter(getter: () => string | undefined): void {
    this.getActiveDelegationNameGetter = getter;
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
  getCommandSensitivity(_toolName: string, path?: CommandPath): SensitivityTier {
    // Filesystem escape takes precedence over command-text classification.
    if (path && typeof path === 'object' && path.outside_cwd) {
      return SensitivityTier.EXTREMELY_SENSITIVE;
    }

    // Bash tool uses command content analysis
    if (path && typeof path === 'object') {
      const command = path.command;
      if (command) {
        return this.getCommandSensitivityForBash(command);
      }
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
   * Reset session trust
   */
  reset(): void {
    this.trustedTools.clear();
  }

  /**
   * Show permission menu using ActivityStream events (Ink UI)
   * Options can include PermissionChoice enum values or dynamic strings (e.g., "Tell Assistant what to do instead...")
   */
  private async showPermissionMenu(
    toolName: string,
    args: any,
    path: CommandPath | undefined,
    options: (PermissionChoice | string)[],
    decisionReason?: string,
    signal?: AbortSignal
  ): Promise<PermissionChoice> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new PermissionDeniedError('Permission request interrupted'));
        return;
      }
      // Generate unique ID for permission request: perm_{timestamp}_{7-char-random} (base-36, skip '0.' prefix)
      const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      const abort = () => {
        const pending = this.pendingPermissions.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        this.pendingPermissions.delete(requestId);
        pending.reject(new PermissionDeniedError('Permission request interrupted'));
      };
      signal?.addEventListener('abort', abort, { once: true });

      // Set up timeout to reject orphaned permissions after 2 minutes
      const timeoutId = setTimeout(() => {
        if (this.pendingPermissions.has(requestId)) {
          logger.warn(`Permission request ${requestId} timed out after 2 minutes`);
          this.pendingPermissions.delete(requestId);
          signal?.removeEventListener('abort', abort);
          reject(new PermissionDeniedError('Permission request timed out'));
        }
      }, API_TIMEOUTS.PERMISSION_REQUEST_TIMEOUT);

      // Store resolver so we can complete it when response arrives
      this.pendingPermissions.set(requestId, {
        resolve: (choice: PermissionChoice) => {
          signal?.removeEventListener('abort', abort);
          resolve(choice);
        },
        reject: (error: Error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
        timeoutId,
      });

      // Extract command string for display if this is a bash operation
      let command: string | undefined;
      if (path && typeof path === 'object') {
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
          decisionReason,
          options,
        },
      });
    });
  }

  /**
   * Reject all pending permission requests (e.g., on user interrupt).
   * Clears each request's timeout so it cannot fire after rejection.
   */
  cancelAllPending(): void {
    if (this.pendingPermissions.size === 0) {
      return;
    }
    logger.debug(`[TrustManager] Cancelling ${this.pendingPermissions.size} pending permission request(s)`);
    // Snapshot before iterating: reject() may settle awaiting code synchronously.
    const pendings = Array.from(this.pendingPermissions.values());
    this.pendingPermissions.clear();
    for (const pending of pendings) {
      clearTimeout(pending.timeoutId);
      pending.reject(new PermissionDeniedError('Permission request interrupted'));
    }
  }

  cleanup(): void {
    this.cancelAllPending();
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.reset();
  }

  /**
   * Handle permission response from UI
   */
  private handlePermissionResponse(event: ActivityEvent<ActivityEventType.PERMISSION_RESPONSE>): void {
    const { requestId, choice } = event.data;

    // Find pending permission request
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      logger.error(`Unknown permission request ID: ${requestId}`);
      return;
    }

    // Clear timeout to prevent it from firing after resolution
    clearTimeout(pending.timeoutId);

    // Remove from pending and resolve with choice
    this.pendingPermissions.delete(requestId);
    pending.resolve(choice);
  }

  private commandDirectory(directory?: string): string {
    return path.resolve(directory ?? process.cwd());
  }

  private getTrustPath(path?: CommandPath): string | undefined {
    if (typeof path === 'string') return path;
    if (path?.command)
      return JSON.stringify({
        command: path.command,
        cwd: this.commandDirectory(path.path),
        outside: path.outside_cwd === true,
      });
    if (path?.path) return `path:${path.path}`;
    return undefined;
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
  /\/opt\//, // Access to /opt
  /\/usr\/local/, // Access to /usr/local
  /eval\s+.+/, // Eval with commands
];

/**
 * Patterns for sensitive commands (require permission but allow "Always Allow")
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /ls\s+(-[alFhrt]+\s+)?(?:\.\.|\/|~)\/?/, // List files outside CWD
  /cat\s+(?:\.\.|\/|~)\/?/, // Cat files outside CWD
  /more\s+(?:\.\.|\/|~)\/?/, // More files outside CWD
  /less\s+(?:\.\.|\/|~)\/?/, // Less files outside CWD
  /head\s+(?:\.\.|\/|~)\/?/, // Head files outside CWD
  /tail\s+(?:\.\.|\/|~)\/?/, // Tail files outside CWD
  /grep\s+.+\s+(?:\.\.|\/|~)\/?/, // Grep outside CWD
  /find\s+(?:\.\.|\/|~)\/?\s+/, // Find outside CWD
  /^rm\s+[^\s*-]+$/, // Single file rm (no flags, wildcards, or multiple args)
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
