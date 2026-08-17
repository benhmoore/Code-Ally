import { describe, expect, it } from 'vitest';
import { evictStaleToolOutputs } from '../compaction/ToolOutputEviction.js';
import type { Message } from '../../types/index.js';

// Deterministic estimator for tests: ~4 chars per token.
const estimate = (message: Message) => Math.ceil(message.content.length / 4);

function result(id: string, content: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    role: 'tool',
    name: 'read',
    tool_call_id: `call-${id}`,
    content: `[Tool Call ID: call-${id}]\n${content}`,
    timestamp: 1,
    ...overrides,
  };
}

const bigPayload = 'line of file content\n'.repeat(100); // ~525 tokens

describe('evictStaleToolOutputs', () => {
  it('evicts old large successful results and protects the recent working set', () => {
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'build it', timestamp: 1 },
      result('old-1', bigPayload),
      result('old-2', bigPayload),
      result('new-1', bigPayload),
      result('new-2', bigPayload),
    ];

    const { messages: evicted, evictedCount, reclaimedTokens } = evictStaleToolOutputs(messages, estimate);

    expect(evictedCount).toBe(2);
    expect(reclaimedTokens).toBeGreaterThan(900);
    // Old payloads became honest stubs that keep the call-id line.
    for (const id of ['old-1', 'old-2']) {
      const message = evicted.find(m => m.id === id)!;
      expect(message.metadata?.contentEvicted).toBe(true);
      expect(message.content).toContain(`[Tool Call ID: call-${id}]`);
      expect(message.content).toContain('evicted to reclaim context');
      expect(message.content).toContain('read result');
      expect(message.content).not.toContain('line of file content');
    }
    // The working set and non-tool messages are untouched, by reference.
    expect(evicted.find(m => m.id === 'new-1')).toBe(messages[3]);
    expect(evicted.find(m => m.id === 'new-2')).toBe(messages[4]);
    expect(evicted.find(m => m.id === 'u')).toBe(messages[0]);
    // Input messages were not mutated.
    expect(messages[1]!.content).toContain('line of file content');
    expect(messages[1]!.metadata?.contentEvicted).toBeUndefined();
  });

  it('never evicts errors, small results, or already-evicted stubs', () => {
    const messages: Message[] = [
      result('error', bigPayload, { is_error: true }),
      result('small', 'Created new file /repo/a.ts (306 bytes)'),
      result('stubbed', bigPayload, { metadata: { contentEvicted: true } }),
      result('big-old', bigPayload),
      result('new-1', bigPayload),
      result('new-2', bigPayload),
    ];

    const { messages: evicted, evictedCount } = evictStaleToolOutputs(messages, estimate);

    expect(evictedCount).toBe(1);
    expect(evicted.find(m => m.id === 'big-old')!.metadata?.contentEvicted).toBe(true);
    expect(evicted.find(m => m.id === 'error')!.content).toContain('line of file content');
    expect(evicted.find(m => m.id === 'small')!.content).toContain('Created new file');
  });

  it('reports a no-op when nothing qualifies', () => {
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'hello', timestamp: 1 },
      result('only', bigPayload),
    ];

    const { evictedCount, reclaimedTokens } = evictStaleToolOutputs(messages, estimate);

    expect(evictedCount).toBe(0);
    expect(reclaimedTokens).toBe(0);
  });
});
