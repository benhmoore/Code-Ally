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
});
