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
  private policy: RunPolicy;
  private readonly terminalBaseline: RunPolicy;
  private epoch = 0;

  constructor(initial: RunPolicy = DEFAULT_INTERACTIVE_RUN_POLICY) {
    this.policy = { ...initial };
    this.terminalBaseline = { ...initial };
  }

  getPolicy(): Readonly<RunPolicy> {
    return { ...this.policy };
  }

  getEpoch(): number {
    return this.epoch;
  }

  isInteractionAvailable(): boolean {
    return this.policy.interaction === 'human';
  }

  updatePolicy(next: RunPolicy): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.policy);
    this.policy = { ...next };
    if (changed) this.epoch += 1;
  }

  setInteraction(interaction: InteractionMode): void {
    if (interaction === this.policy.interaction) return;
    this.policy = { ...this.policy, interaction };
    this.epoch += 1;
  }

  /**
   * Apply the terminal UI's temporary auto-allow mode without erasing the
   * completion contract selected at process startup. Authorization,
   * interactivity, and completion are independent policy dimensions: turning
   * Shift-Tab auto-allow off must not turn an explicitly durable interactive
   * objective back into ordinary chat.
   */
  setTerminalAutoAllow(enabled: boolean): void {
    this.updatePolicy(enabled
      ? {
          ...this.policy,
          interaction: 'none',
          completion: 'durable_objective',
          authorizationPresetId: 'ui-auto',
        }
      : {
          ...this.policy,
          interaction: this.terminalBaseline.interaction,
          completion: this.terminalBaseline.completion,
          authorizationPresetId: this.terminalBaseline.authorizationPresetId,
        });
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
