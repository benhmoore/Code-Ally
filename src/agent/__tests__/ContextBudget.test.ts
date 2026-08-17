import { describe, expect, it } from 'vitest';
import { ContextBudgetPlanner } from '../context/ContextBudget.js';
import { TokenManager } from '../TokenManager.js';
import type { Message } from '../../types/index.js';

describe('ContextBudgetPlanner', () => {
  it('derives deterministic absolute trigger and target budgets', () => {
    const planner = new ContextBudgetPlanner(new TokenManager(10_000));
    const budget = planner.plan({ messages: [], modelMaxOutput: 2_000 });

    expect(budget.outputReserve).toBe(2_000);
    expect(budget.safetyReserve).toBe(512);
    expect(budget.triggerBudget).toBe(7_488);
    // With no fixed overhead, the whole trigger budget is usable and the
    // post-compaction target is the domain share of it.
    expect(budget.fixedOverhead).toBe(0);
    expect(budget.usableBudget).toBe(7_488);
    expect(budget.domainBudget).toBe(Math.floor(7_488 * 0.6));
    expect(budget.targetBudget).toBe(budget.domainBudget);
    // The domain is split exactly between the tail and the checkpoint.
    expect(budget.retainedTailBudget + budget.checkpointBudget).toBe(budget.domainBudget);
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

  it('anchors the post-compaction target on usable space, not the raw window', () => {
    const tokens = new TokenManager(32_768);
    const planner = new ContextBudgetPlanner(tokens);
    const system: Message = { role: 'system', content: 'prompt '.repeat(4_000) };
    const functions = [{
      type: 'function' as const,
      function: { name: 'noise', description: 'x'.repeat(8_000), parameters: {} },
    }];

    const bare = planner.plan({ messages: [] });
    const loaded = planner.plan({ messages: [system], functions });

    expect(loaded.fixedOverhead).toBeGreaterThan(0);
    expect(loaded.usableBudget).toBe(loaded.triggerBudget - loaded.fixedOverhead);
    // The fixed overhead passes straight through to the target: compaction can
    // never reclaim it, so it must not eat the conversation's share.
    expect(loaded.targetBudget - loaded.fixedOverhead)
      .toBeLessThanOrEqual(bare.targetBudget - bare.fixedOverhead);
    expect(loaded.targetBudget - loaded.fixedOverhead).toBeGreaterThanOrEqual(768);
  });

  it('guarantees post-compaction runway on small context windows', () => {
    for (const windowSize of [16_384, 32_768]) {
      const tokens = new TokenManager(windowSize);
      const planner = new ContextBudgetPlanner(tokens);
      const system: Message = { role: 'system', content: 'prompt '.repeat(2_500) };
      const functions = [{
        type: 'function' as const,
        function: { name: 'tools', description: 'x'.repeat(6_000), parameters: {} },
      }];

      const budget = planner.plan({ messages: [system], functions });

      // Fixture sanity: overhead is meaningful but does not swallow the window.
      expect(budget.fixedOverhead).toBeGreaterThan(1_000);
      expect(budget.usableBudget).toBeGreaterThan(4_000);
      // Runway between the compacted target and the next trigger must be a
      // healthy share of the usable space, or the agent thrashes: it re-reads
      // one file and immediately compacts again.
      expect(budget.triggerBudget - budget.targetBudget)
        .toBeGreaterThanOrEqual(Math.floor(budget.usableBudget * 0.35));
      // Both halves of the domain are guaranteed a share; neither can be zero.
      expect(budget.retainedTailBudget).toBeGreaterThan(0);
      expect(budget.checkpointBudget).toBeGreaterThan(0);
      expect(budget.retainedTailBudget + budget.checkpointBudget).toBe(budget.domainBudget);
    }
  });

  it('caps a single tool result at what can survive the next compaction', () => {
    // The invariant that keeps long tasks moving: any result the harness
    // permits must fit in the retained tail, or the model loses it on every
    // reclaim and loops re-fetching the same content.
    for (const windowSize of [8_192, 16_384, 32_768, 128_000]) {
      const tokens = new TokenManager(windowSize);
      const system: Message = { role: 'system', content: 'prompt '.repeat(2_500) };
      const functions = [{
        type: 'function' as const,
        function: { name: 'tools', description: 'x'.repeat(6_000), parameters: {} },
      }];
      const budget = new ContextBudgetPlanner(tokens).plan({ messages: [system], functions });

      expect(budget.maxToolResultTokens).toBeLessThanOrEqual(budget.retainedTailBudget);
      expect(budget.maxToolResultTokens).toBeLessThan(budget.usableBudget);
      expect(budget.maxToolResultTokens).toBeGreaterThan(0);
    }
  });

  it('stays internally consistent when overhead nearly exhausts the window', () => {
    const tokens = new TokenManager(8_192);
    const system: Message = { role: 'system', content: 'prompt '.repeat(3_000) };
    const functions = [{
      type: 'function' as const,
      function: { name: 'tools', description: 'x'.repeat(12_000), parameters: {} },
    }];

    const budget = new ContextBudgetPlanner(tokens).plan({ messages: [system], functions });

    // Degenerate configs must still produce coherent, non-negative budgets that
    // never promise more than exists; the compactor refuses these separately.
    expect(budget.usableBudget).toBeGreaterThanOrEqual(0);
    expect(budget.domainBudget).toBeLessThanOrEqual(budget.usableBudget);
    expect(budget.retainedTailBudget + budget.checkpointBudget).toBe(budget.domainBudget);
    expect(budget.targetBudget).toBeLessThan(budget.triggerBudget);
  });
});
