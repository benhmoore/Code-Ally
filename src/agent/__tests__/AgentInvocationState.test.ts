import { describe, expect, it } from 'vitest';
import { AgentInvocationState } from '../AgentInvocationState.js';

describe('AgentInvocationState', () => {
  it('starts at documented defaults', () => {
    const state = new AgentInvocationState();
    expect({ ...state }).toEqual({
      recoveryAttempts: 0,
      unfinishedWorkContinuations: 0,
      todoBaselineIds: [],
      pendingCleanupIds: [],
      requestInProgress: false,
      agentEndEmitted: false,
    });
  });

  it('restores every field after a dirty invocation', () => {
    const state = new AgentInvocationState();
    state.recoveryAttempts = 3;
    state.unfinishedWorkContinuations = 1;
    state.todoBaselineIds.push('todo-1');
    state.pendingCleanupIds.push('call-1', 'call-2');
    state.requestInProgress = true;
    state.agentEndEmitted = true;

    state.reset();

    expect({ ...state }).toEqual(AgentInvocationState.defaults());
  });

  it('resets every declared field, including ones added later', () => {
    // Guard against the cross-conversation leak this class exists to prevent: a
    // field added to the class but not to the defaults factory would survive
    // pool reuse and carry state into an unrelated task. Both directions fail
    // here — an extra field on the instance, or a stale value after reset.
    const state = new AgentInvocationState();
    const defaults = AgentInvocationState.defaults();

    expect(Object.keys(state).sort()).toEqual(Object.keys(defaults).sort());

    // Dirty every field generically, whatever its type.
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
      const current = state[key];
      (state as Record<string, unknown>)[key] =
        typeof current === 'number' ? current + 7
          : typeof current === 'boolean' ? !current
            : Array.isArray(current) ? [...current, 'dirty']
              : 'dirty';
    }
    expect({ ...state }).not.toEqual(defaults);

    state.reset();

    for (const key of Object.keys(defaults)) {
      expect((state as unknown as Record<string, unknown>)[key]).toEqual(
        (defaults as unknown as Record<string, unknown>)[key]
      );
    }
  });

  it('hands out a fresh defaults object each call', () => {
    const first = AgentInvocationState.defaults();
    first.pendingCleanupIds.push('leaked');
    expect(AgentInvocationState.defaults().pendingCleanupIds).toEqual([]);
  });

  it('does not share the cleanup queue between resets', () => {
    const state = new AgentInvocationState();
    const beforeReset = state.pendingCleanupIds;
    beforeReset.push('call-1');

    state.reset();
    state.pendingCleanupIds.push('call-2');

    expect(beforeReset).toEqual(['call-1']);
    expect(state.pendingCleanupIds).toEqual(['call-2']);
  });
});
