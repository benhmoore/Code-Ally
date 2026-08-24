export type InteractionMode = 'human' | 'none';
export type ExecutionMode = 'terminal' | 'headless';
export type CompletionMode = 'chat' | 'durable_objective';

export interface RunPolicy {
  interaction: InteractionMode;
  execution: ExecutionMode;
  completion: CompletionMode;
  authorizationPresetId: string;
}

export const DEFAULT_INTERACTIVE_RUN_POLICY: RunPolicy = Object.freeze({
  interaction: 'human',
  execution: 'terminal',
  completion: 'chat',
  authorizationPresetId: 'interactive',
});

/**
 * Process-local authority for the current run policy.
 *
 * Automatic execution is intentionally separated from authorization: callers
 * may change the authorization preset without ever enabling human interaction.
 */
export class RunPolicyManager {
  private basePolicy: RunPolicy;
  private terminalAutoAllow = false;
  private epoch = 0;

  constructor(initial: RunPolicy = DEFAULT_INTERACTIVE_RUN_POLICY) {
    this.basePolicy = { ...initial };
  }

  getPolicy(): Readonly<RunPolicy> {
    return this.terminalAutoAllow
      ? { ...this.basePolicy, interaction: 'none', authorizationPresetId: 'ui-auto' }
      : { ...this.basePolicy };
  }

  getEpoch(): number {
    return this.epoch;
  }

  isInteractionAvailable(): boolean {
    return this.getPolicy().interaction === 'human';
  }

  updatePolicy(next: RunPolicy): void {
    const before = this.getPolicy();
    this.basePolicy = { ...next };
    if (JSON.stringify(before) !== JSON.stringify(this.getPolicy())) this.epoch += 1;
  }

  setInteraction(interaction: InteractionMode): void {
    this.updatePolicy({ ...this.basePolicy, interaction });
  }

  /**
   * Apply the terminal UI's temporary auto-allow mode without erasing the
   * completion contract selected at process startup. Authorization,
   * interactivity, and completion are independent policy dimensions: turning
   * Shift-Tab auto-allow off must not turn an explicitly durable interactive
   * objective back into ordinary chat.
   */
  setTerminalAutoAllow(enabled: boolean): void {
    if (enabled === this.terminalAutoAllow) return;
    const before = this.getPolicy();
    this.terminalAutoAllow = enabled;
    if (JSON.stringify(before) !== JSON.stringify(this.getPolicy())) this.epoch += 1;
  }
}

export class InteractionUnavailableError extends Error {
  readonly code = 'interaction_unavailable';

  constructor(public readonly interaction: string) {
    super(`Human interaction is unavailable for this run: ${interaction}`);
    this.name = 'InteractionUnavailableError';
  }
}

export function isInteractionUnavailableError(
  error: unknown
): error is InteractionUnavailableError {
  return error instanceof InteractionUnavailableError;
}
