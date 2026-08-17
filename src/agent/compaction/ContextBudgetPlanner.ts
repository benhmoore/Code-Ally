import type { Message } from '../../types/index.js';
import type { FunctionDefinition } from '../../types/index.js';
import type { TokenManager } from '../TokenManager.js';
import type { ContextBudgetSnapshot } from './types.js';

/** Pure request-budget policy. All thresholds are absolute token counts. */
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
    const targetBudget = Math.max(1, Math.floor(contextWindow * 0.5));
    const schemaTokens = input.functions
      ? this.tokenManager.estimateTokens(JSON.stringify(input.functions))
      : 0;
    const dynamicTokens = input.dynamicContext
      ? this.tokenManager.estimateTokens(input.dynamicContext)
      : 0;
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
      shouldCompact: effectiveInput >= triggerBudget,
    };
  }
}
