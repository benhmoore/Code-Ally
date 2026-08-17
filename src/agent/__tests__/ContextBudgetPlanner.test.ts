import { describe, expect, it } from 'vitest';
import { ContextBudgetPlanner } from '../compaction/ContextBudgetPlanner.js';
import { TokenManager } from '../TokenManager.js';

describe('ContextBudgetPlanner', () => {
  it('derives deterministic absolute trigger and target budgets', () => {
    const planner = new ContextBudgetPlanner(new TokenManager(10_000));
    const budget = planner.plan({ messages: [], modelMaxOutput: 2_000 });

    expect(budget.outputReserve).toBe(2_000);
    expect(budget.safetyReserve).toBe(512);
    expect(budget.triggerBudget).toBe(7_488);
    expect(budget.targetBudget).toBe(5_000);
  });

  it('uses exact provider input as the decision value near the boundary', () => {
    const planner = new ContextBudgetPlanner(new TokenManager(10_000));
    const below = planner.plan({ messages: [], modelMaxOutput: 1_000, exactInput: 7_999 });
    const at = planner.plan({ messages: [], modelMaxOutput: 1_000, exactInput: 8_000 });

    expect(below.triggerBudget).toBe(8_000);
    expect(below.shouldCompact).toBe(false);
    expect(at.shouldCompact).toBe(true);
  });

  it('includes calibrated provider/template overhead in local estimates', () => {
    const tokens = new TokenManager(10_000);
    tokens.calibrate(1_000, 1_500);
    const budget = new ContextBudgetPlanner(tokens).plan({ messages: [] });

    expect(budget.estimatedInput).toBe(500);
  });
});
