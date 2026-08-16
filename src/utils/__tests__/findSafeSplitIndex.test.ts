import { describe, expect, it } from 'vitest';
import { findSafeSplitIndex } from '../conversationRecovery.js';
import type { Message } from '../../types/index.js';

function conversation(): Message[] {
  return [
    { role: 'user', content: 'do it' },
    {
      role: 'assistant',
      content: 'calling',
      tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'grep', arguments: {} } },
        { id: 'call-b', type: 'function', function: { name: 'read', arguments: {} } },
      ],
    },
    { role: 'tool', name: 'grep', tool_call_id: 'call-a', content: 'a' },
    { role: 'tool', name: 'read', tool_call_id: 'call-b', content: 'b' },
    { role: 'assistant', content: 'done' },
  ];
}

describe('findSafeSplitIndex', () => {
  it('leaves a candidate that is already a legal boundary untouched', () => {
    const messages = conversation();
    expect(findSafeSplitIndex(messages, 0)).toBe(0);
    expect(findSafeSplitIndex(messages, 1)).toBe(1);
    expect(findSafeSplitIndex(messages, 4)).toBe(4);
    expect(findSafeSplitIndex(messages, 5)).toBe(5);
  });

  it('moves a candidate inside a tool block back to the parent assistant call', () => {
    const messages = conversation();
    expect(findSafeSplitIndex(messages, 2)).toBe(1);
    expect(findSafeSplitIndex(messages, 3)).toBe(1);
  });

  it('never returns a negative index and clamps out-of-range candidates', () => {
    const messages = conversation();
    expect(findSafeSplitIndex(messages, -10)).toBe(0);
    expect(findSafeSplitIndex(messages, 999)).toBe(messages.length);
    expect(findSafeSplitIndex(messages, Number.NaN)).toBe(0);
    expect(findSafeSplitIndex([], 3)).toBe(0);
  });

  it('stops at 0 when history begins with parentless tool results', () => {
    // Retaining everything discards nothing, so it cannot orphan anything.
    const messages: Message[] = [
      { role: 'tool', tool_call_id: 'orphan-1', content: 'x' },
      { role: 'tool', tool_call_id: 'orphan-2', content: 'y' },
      { role: 'assistant', content: 'ok' },
    ];
    expect(findSafeSplitIndex(messages, 1)).toBe(0);
    expect(findSafeSplitIndex(messages, 2)).toBe(2);
  });

  it('is idempotent — re-snapping a snapped index is a no-op', () => {
    const messages = conversation();
    for (let i = -1; i <= messages.length + 1; i++) {
      const once = findSafeSplitIndex(messages, i);
      expect(findSafeSplitIndex(messages, once)).toBe(once);
      expect(once).toBeGreaterThanOrEqual(0);
      expect(once).toBeLessThanOrEqual(messages.length);
    }
  });
});
