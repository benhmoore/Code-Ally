/**
 * Tests for the tool_call/tool_result pairing invariant.
 *
 * Providers reject a message array where an assistant tool call has no result,
 * or a result has no call. Several ordinary paths can break it — most often
 * ephemeral read results, which are pruned at end of turn while the assistant
 * message that requested them survives.
 */

import { describe, it, expect } from 'vitest';
import { reconcileToolCallPairs, recoverConversation } from '../conversationRecovery.js';
import { Message } from '../../types/index.js';

const assistantCalling = (...ids: string[]): Message => ({
  id: `a-${ids.join('-')}`,
  role: 'assistant',
  content: '',
  tool_calls: ids.map(id => ({
    id,
    type: 'function' as const,
    function: { name: 'read', arguments: '{}' },
  })),
  timestamp: 1,
});

const toolResult = (id: string): Message => ({
  id: `t-${id}`,
  role: 'tool',
  tool_call_id: id,
  name: 'read',
  content: '{"success":true}',
  timestamp: 2,
});

const user = (content: string): Message => ({ id: `u-${content}`, role: 'user', content, timestamp: 0 });

/** Every call answered exactly once, every result owned by a call. */
const isWellPaired = (messages: Message[]): boolean => {
  const called = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) called.add(tc.id);
  }
  const answered = messages.filter(m => m.role === 'tool').map(m => m.tool_call_id!);
  const everyCallAnswered = [...called].every(id => answered.includes(id));
  const everyResultOwned = answered.every(id => called.has(id));
  const noDuplicates = new Set(answered).size === answered.length;
  return everyCallAnswered && everyResultOwned && noDuplicates;
};

describe('reconcileToolCallPairs', () => {
  it('leaves an already-paired conversation untouched', () => {
    const messages = [user('hi'), assistantCalling('c1'), toolResult('c1')];
    const result = reconcileToolCallPairs(messages);

    expect(result).toHaveLength(3);
    expect(result.every((m, i) => m === messages[i])).toBe(true);
  });

  // The ordinary-use case: a read marked ephemeral is pruned at end of turn,
  // leaving the assistant call unanswered on the next request.
  it('synthesizes a result when an ephemeral tool result was pruned', () => {
    const messages = [user('read it'), assistantCalling('c1'), user('now what?')];
    const result = reconcileToolCallPairs(messages);

    expect(isWellPaired(result)).toBe(true);
    const synthetic = result.find(m => m.role === 'tool');
    expect(synthetic?.tool_call_id).toBe('c1');
    expect(synthetic?.is_error).toBe(true);
  });

  it('places the synthesized result immediately after its call', () => {
    const messages = [assistantCalling('c1'), user('next')];
    const result = reconcileToolCallPairs(messages);

    expect(result[0]?.role).toBe('assistant');
    expect(result[1]?.role).toBe('tool');
    expect(result[1]?.tool_call_id).toBe('c1');
    expect(result[2]?.role).toBe('user');
  });

  it('answers only the unanswered calls in a partially-executed batch', () => {
    const messages = [assistantCalling('c1', 'c2', 'c3'), toolResult('c2')];
    const result = reconcileToolCallPairs(messages);

    expect(isWellPaired(result)).toBe(true);
    // The real result survives; it is not replaced by a synthetic one.
    expect(result.find(m => m.tool_call_id === 'c2')?.content).toBe('{"success":true}');
    expect(result.filter(m => m.role === 'tool')).toHaveLength(3);
  });

  // Emergency truncation keeps a token-budgeted suffix with no pairing check,
  // so history can begin with a result whose parent call is gone.
  it('drops a result whose parent call is missing', () => {
    const messages = [toolResult('orphan'), user('hello')];
    const result = reconcileToolCallPairs(messages);

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('user');
    expect(isWellPaired(result)).toBe(true);
  });

  it('preserves the assistant message rather than deleting it', () => {
    // Deleting would rewrite earlier history and break the cacheable prefix.
    const assistant = assistantCalling('c1');
    const result = reconcileToolCallPairs([assistant]);

    expect(result).toContain(assistant);
  });

  it('is idempotent', () => {
    const messages = [assistantCalling('c1', 'c2'), toolResult('c1'), toolResult('gone')];
    const once = reconcileToolCallPairs(messages);
    const twice = reconcileToolCallPairs(once);

    expect(twice).toHaveLength(once.length);
    expect(twice.every((m, i) => m === once[i])).toBe(true);
    expect(isWellPaired(twice)).toBe(true);
  });

  it('handles a drop and a synthesis that cancel out in count', () => {
    const messages = [assistantCalling('c1'), toolResult('orphan')];
    const result = reconcileToolCallPairs(messages);

    expect(result).toHaveLength(2);
    expect(isWellPaired(result)).toBe(true);
    expect(result.find(m => m.role === 'tool')?.tool_call_id).toBe('c1');
  });

  it('handles an empty conversation', () => {
    expect(reconcileToolCallPairs([])).toEqual([]);
  });
});

describe('recoverConversation change tracking', () => {
  it('reports an unchanged conversation and preserves its message references', () => {
    const messages = [
      user('hello'),
      { id: 'a', role: 'assistant', content: 'done', timestamp: 1 } as Message,
    ];

    const result = recoverConversation(messages);

    expect(result.changed).toBe(false);
    expect(result.messages.every((message, index) => message === messages[index])).toBe(true);
  });

  it('detects a same-length drop and synthesis', () => {
    const messages = [assistantCalling('c1'), toolResult('orphan')];

    const result = recoverConversation(messages);

    expect(result.messages).toHaveLength(messages.length);
    expect(result.changed).toBe(true);
    expect(result.messages.find(message => message.role === 'tool')?.tool_call_id).toBe('c1');
  });
});
