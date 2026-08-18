/**
 * Per-invocation Agent state that must be wiped between conversations.
 *
 * Agents are pooled and reused across unrelated tasks. Every field here is
 * scoped to a single invocation, so a field that survives reuse is a
 * cross-conversation leak: a stale `requestInProgress` makes the next task look
 * busy, leftover `pendingCleanupIds` delete tool results from a conversation
 * that no longer exists.
 *
 * The defaults live in one factory and `reset()` reinstalls the whole factory
 * output, so a newly added field is reset by construction — you cannot add one
 * to `defaults()` and forget the reset, and adding a field to the class without
 * adding it to `defaults()` fails the unit test.
 */

export interface AgentInvocationStateValues {
  /** Number of internal generation recoveries in the current turn. */
  recoveryAttempts: number;
  /** Consecutive text-only responses while structured work remains unfinished. */
  unfinishedWorkContinuations: number;
  /** Tool call IDs queued by cleanup-call, removed once the model responds. */
  pendingCleanupIds: string[];
  /** Whether a request is currently being processed. */
  requestInProgress: boolean;
  /** Whether the agent_end event has already been emitted for this request. */
  agentEndEmitted: boolean;
}

function defaults(): AgentInvocationStateValues {
  return {
    recoveryAttempts: 0,
    unfinishedWorkContinuations: 0,
    pendingCleanupIds: [],
    requestInProgress: false,
    agentEndEmitted: false,
  };
}

export class AgentInvocationState implements AgentInvocationStateValues {
  recoveryAttempts!: number;
  unfinishedWorkContinuations!: number;
  pendingCleanupIds!: string[];
  requestInProgress!: boolean;
  agentEndEmitted!: boolean;

  constructor() {
    this.reset();
  }

  /** Return every field to its initial value. */
  reset(): void {
    Object.assign(this, defaults());
  }

  /** The initial value of every field, for tests and assertions. */
  static defaults(): AgentInvocationStateValues {
    return defaults();
  }
}
