import { describe, expect, it } from 'vitest';
import { shouldRestoreMainView } from '../agentViewLifecycle.js';

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
