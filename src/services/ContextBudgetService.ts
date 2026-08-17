import type { ContextBudgetSnapshot } from '../agent/context/ContextBudget.js';

/**
 * Live per-agent view of the input budget.
 *
 * Tools must size their output against the space actually available to
 * conversation content, not against the raw context window: on a small window
 * the fixed request overhead (system prompt + tool schemas) can be nearly half
 * of it, so a "20% of context" cap can exceed the entire working budget. Only
 * the owning agent knows its overhead, so it publishes here each turn and
 * tools read the snapshot for their scope.
 *
 * Sub-agents publish under their own instance ID, matching how read state and
 * the read cache are scoped, so a delegated agent never sizes its reads
 * against its parent's budget.
 */
export class ContextBudgetService {
  private snapshots = new Map<string, ContextBudgetSnapshot>();

  publish(agentId: string, snapshot: ContextBudgetSnapshot): void {
    this.snapshots.set(agentId, snapshot);
  }

  get(agentId: string): ContextBudgetSnapshot | null {
    return this.snapshots.get(agentId) ?? null;
  }

  clear(agentId: string): void {
    this.snapshots.delete(agentId);
  }
}
