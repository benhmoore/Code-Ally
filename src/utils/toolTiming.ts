import type { ToolCallState } from '@shared/index.js';

export interface ToolCallTiming {
  /** Time before execution began: validation, forms, supervision, and any human approval. */
  preExecutionMs: number;
  /** Time spent executing after TOOL_EXECUTION_START. */
  executionMs: number;
  /** End-to-end time from tool-call creation through completion. */
  totalMs: number;
}

/**
 * Derive one canonical timing breakdown for live, resumed, and debug views.
 * A call without executionStartTime has not begun execution; all elapsed time
 * belongs to validation, forms, supervision, or human approval.
 */
export function getToolCallTiming(call: ToolCallState, now: number = Date.now()): ToolCallTiming {
  const end = call.endTime ?? now;
  const executionStart = call.executionStartTime;
  return {
    preExecutionMs: Math.max(0, (executionStart ?? end) - call.startTime),
    executionMs: executionStart === undefined ? 0 : Math.max(0, end - executionStart),
    totalMs: Math.max(0, end - call.startTime),
  };
}
