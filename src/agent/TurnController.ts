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

export type TurnTerminationReason = 'completed' | 'model_budget' | 'tool_budget' | 'interrupted' | 'failed';

export interface TurnSnapshot {
  state: TurnState;
  startedAt?: number;
  elapsedMs: number;
  modelCalls: number;
  toolCalls: number;
  terminationReason?: TurnTerminationReason;
}

/** Single authority for turn lifecycle and runaway-work budgets. */
export class TurnController {
  private state: TurnState = 'idle';
  private startedAt?: number;
  private modelCalls = 0;
  private toolCalls = 0;
  private terminationReason?: TurnTerminationReason;

  constructor(private readonly limits: { maxModelCalls: number; maxToolCalls: number }) {}

  start(): void {
    this.state = 'preparing';
    this.startedAt = Date.now();
    this.modelCalls = 0;
    this.toolCalls = 0;
    this.terminationReason = undefined;
  }

  beginModelCall(): boolean {
    if (this.modelCalls >= this.limits.maxModelCalls || this.toolCalls >= this.limits.maxToolCalls) {
      this.state = 'finalizing';
      this.terminationReason = this.modelCalls >= this.limits.maxModelCalls ? 'model_budget' : 'tool_budget';
      return false;
    }
    this.modelCalls += 1;
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

  finish(reason: TurnTerminationReason = 'completed'): void {
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
      terminationReason: this.terminationReason,
    };
  }
}
