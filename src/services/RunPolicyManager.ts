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
  private epoch = 0;

  constructor(initial: RunPolicy = DEFAULT_INTERACTIVE_RUN_POLICY) {
    this.policy = { ...initial };
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
