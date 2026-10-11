export type TurnState =
  | 'idle'
  | 'preparing'
  | 'generating'
  | 'executing'
  | 'recovering'
  | 'finalizing'
  | 'completed'
  | 'interrupted'
  | 'failed';

export type TurnTerminationReason = 'completed' | 'model_budget' | 'tool_budget' | 'no_progress' | 'interrupted' | 'failed';

export interface TurnSnapshot {
  state: TurnState;
  startedAt?: number;
  elapsedMs: number;
  modelCalls: number;
  toolCalls: number;
  modelCallsWithoutProgress: number;
  terminationReason?: TurnTerminationReason;
}

/** Single authority for turn lifecycle and runaway-work budgets. */
export class TurnController {
  private state: TurnState = 'idle';
  private startedAt?: number;
  private modelCalls = 0;
  private toolCalls = 0;
  private terminationReason?: TurnTerminationReason;
  private budgetNoticeEmitted = false;
  private callsWithoutProgress = 0;
  private readonly progressFingerprints = new Set<string>();

  constructor(private readonly limits: { maxModelCalls: number; maxToolCalls: number; maxCallsWithoutProgress?: number }) {}

  start(): void {
    this.state = 'preparing';
    this.startedAt = Date.now();
    this.modelCalls = 0;
    this.toolCalls = 0;
    this.terminationReason = undefined;
    this.budgetNoticeEmitted = false;
    this.callsWithoutProgress = 0;
    this.progressFingerprints.clear();
  }

  /**
   * Claim the right to tell the user the turn hit its budget. True exactly once
   * per turn.
   *
   * Once a budget trips, `beginModelCall` refuses every subsequent call — but
   * the turn has thirteen re-entry points into the model loop (continuations,
   * recovery, requirement retries), and any of them re-entering would otherwise
   * produce another copy of the same notice. The user sees the explanation once;
   * the refusal itself keeps working.
   */
  claimBudgetNotice(): boolean {
    if (this.budgetNoticeEmitted) return false;
    this.budgetNoticeEmitted = true;
    return true;
  }

  /** Whether a budget has tripped and the turn is winding down. */
  isBudgetExhausted(): boolean {
    return this.terminationReason === 'model_budget' || this.terminationReason === 'tool_budget' || this.terminationReason === 'no_progress';
  }

  /** Only new successful tool evidence or external direction replenishes progress. */
  recordProgress(fingerprint: string): boolean {
    if (this.progressFingerprints.has(fingerprint)) return false;
    this.progressFingerprints.add(fingerprint);
    // A turn is already bounded by its execution budget; retain enough history
    // to reject repeated successful reads throughout several execution epochs.
    if (this.progressFingerprints.size > 4096) this.progressFingerprints.delete(this.progressFingerprints.values().next().value!);
    this.callsWithoutProgress = 0;
    return true;
  }

  acceptDirection(): void {
    this.callsWithoutProgress = 0;
  }

  beginModelCall(): boolean {
    if (this.callsWithoutProgress >= (this.limits.maxCallsWithoutProgress ?? Infinity)) {
      this.state = 'finalizing';
      this.terminationReason = 'no_progress';
      return false;
    }
    if (this.modelCalls >= this.limits.maxModelCalls || this.toolCalls >= this.limits.maxToolCalls) {
      this.state = 'finalizing';
      this.terminationReason = this.modelCalls >= this.limits.maxModelCalls ? 'model_budget' : 'tool_budget';
      return false;
    }
    this.modelCalls += 1;
    this.callsWithoutProgress += 1;
    this.state = 'generating';
    return true;
  }

  beginToolExecution(): void {
    this.state = 'executing';
  }

  recordToolCalls(count: number): void {
    this.toolCalls += Math.max(0, count);
  }

  recover(): void {
    this.state = 'recovering';
  }

  /** Begin a fresh safety-budget epoch without ending the durable objective. */
  rollover(): void {
    this.modelCalls = 0;
    this.toolCalls = 0;
    this.terminationReason = undefined;
    this.budgetNoticeEmitted = false;
    this.state = 'preparing';
  }

  finish(reason: TurnTerminationReason = 'completed'): void {
    if (reason === 'completed' && this.isBudgetExhausted()) return;
    this.terminationReason = reason;
    this.state = reason === 'completed' ? 'completed' : reason === 'interrupted' ? 'interrupted' : reason === 'failed' ? 'failed' : 'finalizing';
  }

  snapshot(): TurnSnapshot {
    return {
      state: this.state,
      startedAt: this.startedAt,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      modelCallsWithoutProgress: this.callsWithoutProgress,
      terminationReason: this.terminationReason,
    };
  }
}
