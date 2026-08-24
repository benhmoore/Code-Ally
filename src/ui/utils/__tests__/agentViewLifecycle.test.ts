import { describe, expect, it } from 'vitest';
import type { Message, ToolCallState } from '@shared/index.js';
import {
  finalizeToolCallsAtAgentEnd,
  reconcileRecordedToolCalls,
  reconcileRestoredToolCalls,
  shouldRestoreMainView,
} from '../agentViewLifecycle.js';

describe('shouldRestoreMainView', () => {
  it('keeps the primary and running child views stable', () => {
    expect(shouldRestoreMainView('main', null)).toBe(false);
    expect(shouldRestoreMainView('agent-1', 'running')).toBe(false);
  });

  it.each(['done', 'error', 'cancelled', null] as const)(
    'restores main when an entered child is %s',
    (status) => expect(shouldRestoreMainView('agent-1', status)).toBe(true),
  );
});

describe('reconcileRestoredToolCalls', () => {
  const liveCall: ToolCallState = {
    id: 'task-1',
    status: 'executing',
    toolName: 'agent',
    arguments: {},
    startTime: 10,
    agentModel: 'child-model',
  };

  const assistantMessage: Message = {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'task-1',
      type: 'function',
      function: { name: 'agent', arguments: '{}' },
    }],
  };

  it('uses the reconstructed terminal state once a result is in history', () => {
    const completed: ToolCallState = {
      ...liveCall,
      status: 'success',
      output: 'audit complete',
      endTime: 20,
    };
    const messages: Message[] = [
      assistantMessage,
      { role: 'tool', content: 'result', tool_call_id: 'task-1' },
    ];

    expect(reconcileRestoredToolCalls(messages, [completed], [liveCall])).toEqual([completed]);
  });

  it('preserves live metadata when returning before the result arrives', () => {
    const incompleteReconstruction: ToolCallState = {
      ...liveCall,
      status: 'success',
      agentModel: undefined,
    };

    expect(reconcileRestoredToolCalls(
      [assistantMessage],
      [incompleteReconstruction],
      [liveCall],
    )).toEqual([liveCall]);
  });

  it('marks newly discovered result-less calls as executing', () => {
    const reconstructed: ToolCallState = { ...liveCall, status: 'success' };

    expect(reconcileRestoredToolCalls([assistantMessage], [reconstructed], [])[0])
      .toMatchObject({ id: 'task-1', status: 'executing', endTime: undefined });
  });
});

describe('finalizeToolCallsAtAgentEnd', () => {
  const executing: ToolCallState = {
    id: 'wait-1', status: 'executing', toolName: 'wait', arguments: { all: true }, startTime: 10,
  };

  it('uses a recorded result instead of overwriting a queued success', () => {
    const recorded: ToolCallState = { ...executing, status: 'success', endTime: 20, output: 'done' };

    expect(finalizeToolCallsAtAgentEnd([executing], [recorded], 30)).toEqual([recorded]);
  });

  it('marks only result-less non-terminal calls as errors', () => {
    expect(finalizeToolCallsAtAgentEnd([executing], [], 30)[0]).toMatchObject({
      id: 'wait-1', status: 'error', endTime: 30, error: 'Tool did not report completion',
    });
  });
});

describe('reconcileRecordedToolCalls', () => {
  it('settles only calls backed by durable tool-result messages', () => {
    const live = [
      { id: 'done', toolName: 'read', status: 'executing', startTime: 1 },
      { id: 'running', toolName: 'task', status: 'executing', startTime: 2 },
    ] as ToolCallState[];
    const recorded = [
      { id: 'done', toolName: 'read', status: 'success', startTime: 1, endTime: 3 },
      { id: 'running', toolName: 'task', status: 'success', startTime: 2, endTime: 3 },
    ] as ToolCallState[];
    const messages = [
      { role: 'tool', tool_call_id: 'done', content: 'ok' },
    ] as Message[];

    const result = reconcileRecordedToolCalls(messages, live, recorded);
    expect(result[0]).toEqual(recorded[0]);
    expect(result[1]).toBe(live[1]);
  });
});
