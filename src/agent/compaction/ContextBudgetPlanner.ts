import type { Message } from '../../types/index.js';
import type { FunctionDefinition } from '../../types/index.js';
import type { TokenManager } from '../TokenManager.js';
import type { ContextBudgetSnapshot } from './types.js';

/** Fraction of the usable (post-overhead) budget a compacted conversation may keep. */
const DOMAIN_BUDGET_RATIO = 0.35;
/** Minimum post-compaction domain budget so a checkpoint is never squeezed to nothing. */
const MIN_DOMAIN_BUDGET = 768;
/** Portion of the domain budget the raw retained tail may occupy (the rest is checkpoint room). */
const RETAINED_TAIL_SHARE = 0.6;

/**
 * Pure request-budget policy. All thresholds are absolute token counts.
 *
 * Every derived budget is anchored on the *usable* budget — the input tokens
 * left after the fixed request overhead (system prompt, tool schemas, dynamic
 * context, calibration) that compaction can never reclaim. Sizing targets from
 * the raw window instead silently starves small (16–32k) contexts: the fixed
 * overhead consumes the whole allowance and each compaction frees less than
 * the last until the agent thrashes.
 */
export class ContextBudgetPlanner {
  constructor(private readonly tokenManager: TokenManager) {}

  plan(input: {
    messages: readonly Message[];
    functions?: readonly FunctionDefinition[];
    dynamicContext?: string;
    modelMaxOutput?: number;
    exactInput?: number;
  }): ContextBudgetSnapshot {
    const contextWindow = this.tokenManager.getContextSize();
    const outputReserve = Math.min(
      input.modelMaxOutput ?? Number.MAX_SAFE_INTEGER,
      Math.max(2048, Math.floor(contextWindow * 0.12)),
    );
    const safetyReserve = Math.max(512, Math.floor(contextWindow * 0.05));
    const triggerBudget = Math.max(
      1,
      Math.min(
        Math.floor(contextWindow * 0.8),
        contextWindow - outputReserve - safetyReserve,
      ),
    );
    const schemaTokens = input.functions
      ? this.tokenManager.estimateTokens(JSON.stringify(input.functions))
      : 0;
    const dynamicTokens = input.dynamicContext
      ? this.tokenManager.estimateTokens(input.dynamicContext)
      : 0;
    const firstMessage = input.messages[0];
    const systemTokens = firstMessage?.role === 'system'
      ? this.tokenManager.estimateMessageTokens(firstMessage)
      : 0;
    const fixedOverhead = schemaTokens
      + dynamicTokens
      + systemTokens
      + this.tokenManager.getCalibrationOverhead();
    const usableBudget = Math.max(0, triggerBudget - fixedOverhead);
    const domainBudget = Math.min(
      usableBudget,
      Math.max(MIN_DOMAIN_BUDGET, Math.floor(usableBudget * DOMAIN_BUDGET_RATIO)),
    );
    const targetBudget = Math.max(
      1,
      Math.min(triggerBudget - 1, fixedOverhead + domainBudget),
    );
    const retainedTailBudget = Math.max(1, Math.floor(domainBudget * RETAINED_TAIL_SHARE));
    const estimatedInput = Math.max(0, this.tokenManager.estimateMessagesTokens(input.messages)
      + schemaTokens
      + dynamicTokens
      + this.tokenManager.getCalibrationOverhead());
    const effectiveInput = input.exactInput ?? estimatedInput;

    return {
      contextWindow,
      estimatedInput,
      ...(input.exactInput === undefined ? {} : { exactInput: input.exactInput }),
      outputReserve,
      safetyReserve,
      triggerBudget,
      targetBudget,
      fixedOverhead,
      usableBudget,
      domainBudget,
      retainedTailBudget,
      shouldCompact: effectiveInput >= triggerBudget,
    };
  }
}
