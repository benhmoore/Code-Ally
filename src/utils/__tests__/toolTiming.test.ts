import { describe, expect, it } from 'vitest';
import type { ToolCallState } from '@shared/index.js';
import { getToolCallTiming } from '../toolTiming.js';

const call = (overrides: Partial<ToolCallState> = {}): ToolCallState => ({
  id: 'call-1',
  status: 'success',
  toolName: 'bash',
  arguments: {},
  startTime: 1_000,
  endTime: 101_000,
  ...overrides,
});

describe('getToolCallTiming', () => {
  it('separates pre-execution waiting from command execution', () => {
    expect(getToolCallTiming(call({ executionStartTime: 99_000 }))).toEqual({
      preExecutionMs: 98_000,
      executionMs: 2_000,
      totalMs: 100_000,
    });
  });

  it('attributes the full interval to pre-execution when execution never started', () => {
    expect(getToolCallTiming(call())).toEqual({
      preExecutionMs: 100_000,
      executionMs: 0,
      totalMs: 100_000,
    });
  });

  it('uses the supplied current time for a running call', () => {
    expect(getToolCallTiming(call({ endTime: undefined, executionStartTime: 3_000 }), 8_000)).toEqual({
      preExecutionMs: 2_000,
      executionMs: 5_000,
      totalMs: 7_000,
    });
  });
});
