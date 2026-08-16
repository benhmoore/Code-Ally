import { describe, expect, it, vi } from 'vitest';
import { TurnController } from '../TurnController.js';

describe('TurnController', () => {
  it('tracks lifecycle and work counters', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(175);
    const turn = new TurnController({ maxModelCalls: 2, maxToolCalls: 3 });
    turn.start();
    expect(turn.beginModelCall()).toBe(true);
    turn.beginToolExecution();
    turn.recordToolCalls(2);
    turn.finish();
    expect(turn.snapshot()).toMatchObject({
      state: 'completed', elapsedMs: 75, modelCalls: 1, toolCalls: 2, terminationReason: 'completed',
    });
    vi.restoreAllMocks();
  });

  it('stops before exceeding model or tool budgets', () => {
    const modelBudget = new TurnController({ maxModelCalls: 1, maxToolCalls: 5 });
    modelBudget.start();
    expect(modelBudget.beginModelCall()).toBe(true);
    expect(modelBudget.beginModelCall()).toBe(false);
    expect(modelBudget.snapshot().terminationReason).toBe('model_budget');

    const toolBudget = new TurnController({ maxModelCalls: 5, maxToolCalls: 1 });
    toolBudget.start();
    toolBudget.recordToolCalls(1);
    expect(toolBudget.beginModelCall()).toBe(false);
    expect(toolBudget.snapshot().terminationReason).toBe('tool_budget');
  });

  it('announces budget exhaustion exactly once per turn', () => {
    // Regression: the turn has many re-entry points into the model loop
    // (continuations, recovery, requirement retries). Each one re-entering after
    // the budget tripped used to append another copy of the stop notice, so the
    // user saw it printed two or more times.
    const turn = new TurnController({ maxModelCalls: 1, maxToolCalls: 5 });
    turn.start();

    expect(turn.beginModelCall()).toBe(true);
    expect(turn.beginModelCall()).toBe(false);

    expect(turn.isBudgetExhausted()).toBe(true);
    expect(turn.claimBudgetNotice()).toBe(true);
    expect(turn.claimBudgetNotice()).toBe(false);
    expect(turn.claimBudgetNotice()).toBe(false);

    // The refusal itself keeps working after the notice is spent.
    expect(turn.beginModelCall()).toBe(false);
  });

  it('lets the next turn announce again', () => {
    const turn = new TurnController({ maxModelCalls: 1, maxToolCalls: 5 });
    turn.start();
    turn.beginModelCall();
    turn.beginModelCall();
    expect(turn.claimBudgetNotice()).toBe(true);

    turn.start();
    expect(turn.isBudgetExhausted()).toBe(false);
    expect(turn.beginModelCall()).toBe(true);
    expect(turn.beginModelCall()).toBe(false);
    expect(turn.claimBudgetNotice()).toBe(true);
  });

  it('reports no budget exhaustion for a clean or interrupted turn', () => {
    const turn = new TurnController({ maxModelCalls: 5, maxToolCalls: 5 });
    turn.start();
    turn.beginModelCall();
    turn.finish('interrupted');
    expect(turn.isBudgetExhausted()).toBe(false);
  });
});
