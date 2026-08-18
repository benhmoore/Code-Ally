import type { FunctionDefinition, Message } from '../../types/index.js';
import type { TokenManager } from '../TokenManager.js';

/**
 * How the input budget is divided once fixed request overhead is paid.
 *
 * `usableBudget` — the tokens actually available to conversation content — is
 * the only meaningful denominator. Sizing anything from the raw context window
 * silently starves small (16-32k) contexts, where the system prompt and tool
 * schemas can consume nearly half the window before a single message is sent.
 *
 * The domain (post-compaction conversation) is split so that both halves have
 * a guaranteed share: the retained raw tail and the checkpoint. The remaining
 * usable space is runway — room to work before the next reclaim.
 */
const DOMAIN_SHARE_OF_USABLE = 0.6;
const TAIL_SHARE_OF_DOMAIN = 0.6;
const MIN_DOMAIN_BUDGET = 768;
/**
 * Share of the retained tail a single tool result may occupy. Parallel tool
 * calls are retained as one unit with their assistant message, so a result
 * sized to the entire tail cannot actually be kept.
 */
const SINGLE_RESULT_SHARE_OF_TAIL = 0.5;

export interface ContextBudgetSnapshot {
  contextWindow: number;
  estimatedInput: number;
  exactInput?: number;
  outputReserve: number;
  safetyReserve: number;
  /** Input ceiling that triggers reclaim. */
  triggerBudget: number;
  /** Total input a compacted request should land at (overhead + domain). */
  targetBudget: number;
  /**
   * Tokens every request pays regardless of conversation content: system
   * prompt, tool schemas, dynamic context, and calibrated provider overhead.
   * Reclaim can never recover these.
   */
  fixedOverhead: number;
  /** Input tokens available to conversation content (trigger - fixed). */
  usableBudget: number;
  /** Post-reclaim conversation budget: retained tail + checkpoint. */
  domainBudget: number;
  /** The raw retained tail's guaranteed share of the domain. */
  retainedTailBudget: number;
  /** The checkpoint's guaranteed share of the domain. */
  checkpointBudget: number;
  /**
   * Ceiling for a single tool result.
   *
   * A fraction of the retained-tail budget rather than all of it, because the
   * unit that must survive a reclaim is not one result: a safe split keeps an
   * assistant message together with every result of its parallel tool calls.
   * Sizing one result to the whole tail therefore guarantees the group
   * overflows and the tail is dropped — the model then loses its work on every
   * reclaim and loops re-fetching it.
   */
  maxToolResultTokens: number;
  /** Aggregate ceiling for non-truncatable results in one tool-call group. */
  maxToolBatchTokens: number;
  shouldCompact: boolean;
}

/**
 * Share of the input budget that tool schemas may occupy.
 *
 * Schemas are paid on every request and cannot be reclaimed, so they compete
 * directly with the conversation. A quarter is generous on a large window
 * (where nothing needs deferring at all) and is the ceiling that keeps a small
 * window workable.
 */
const TOOL_SCHEMA_SHARE_OF_TRIGGER = 0.25;

/** The fixed reserves and reclaim ceiling, independent of conversation content. */
export function requestCeilings(contextWindow: number, modelMaxOutput?: number): {
  outputReserve: number;
  safetyReserve: number;
  triggerBudget: number;
} {
  const outputReserve = Math.min(
    modelMaxOutput ?? Number.MAX_SAFE_INTEGER,
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
  return { outputReserve, safetyReserve, triggerBudget };
}

/**
 * Token ceiling for the tool schemas sent with a request. Computed without
 * reference to the schemas themselves, so tool exposure can be decided before
 * the request budget is planned.
 */
export function toolSchemaBudget(contextWindow: number, modelMaxOutput?: number): number {
  const { triggerBudget } = requestCeilings(contextWindow, modelMaxOutput);
  return Math.max(256, Math.floor(triggerBudget * TOOL_SCHEMA_SHARE_OF_TRIGGER));
}

export interface ContextBudgetInput {
  messages: readonly Message[];
  functions?: readonly FunctionDefinition[];
  dynamicContext?: string;
  modelMaxOutput?: number;
  exactInput?: number;
}

/** Pure request-budget policy. All thresholds are absolute token counts. */
export class ContextBudgetPlanner {
  constructor(private readonly tokenManager: TokenManager) {}

  plan(input: ContextBudgetInput): ContextBudgetSnapshot {
    const contextWindow = this.tokenManager.getContextSize();
    const { outputReserve, safetyReserve, triggerBudget } =
      requestCeilings(contextWindow, input.modelMaxOutput);

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
    // Derive both halves from the clamped domain so they always sum to it,
    // even when the window is too small to honour the nominal minimum.
    const domainBudget = Math.min(
      usableBudget,
      Math.max(MIN_DOMAIN_BUDGET, Math.floor(usableBudget * DOMAIN_SHARE_OF_USABLE)),
    );
    const retainedTailBudget = Math.max(1, Math.floor(domainBudget * TAIL_SHARE_OF_DOMAIN));
    const checkpointBudget = Math.max(1, domainBudget - retainedTailBudget);
    const targetBudget = Math.max(
      1,
      Math.min(triggerBudget - 1, fixedOverhead + domainBudget),
    );

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
      checkpointBudget,
      maxToolResultTokens: Math.max(1, Math.floor(retainedTailBudget * SINGLE_RESULT_SHARE_OF_TAIL)),
      maxToolBatchTokens: retainedTailBudget,
      shouldCompact: effectiveInput >= triggerBudget,
    };
  }
}
