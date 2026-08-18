import { describe, expect, it } from 'vitest';
import { evictStaleToolOutputs } from '../compaction/ToolOutputEviction.js';
import type { Message } from '../../types/index.js';

// Deterministic estimator for tests: ~4 chars per token.
const estimate = (message: Message) => Math.ceil(message.content.length / 4);
const estimateFull = (message: Message) => Math.ceil(JSON.stringify(message).length / 4);

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

  it('evicts bulky arguments from old successful writes while preserving an API outline', () => {
    const source = [
      'export class World {',
      '  getBlock(x, y, z) { return 0; }',
      '  setBlock(x, y, z, value) { return value; }',
      '}',
      'export function createWorld() { return new World(); }',
      'const filler = "' + 'x'.repeat(2_000) + '";',
    ].join('\n');
    const messages: Message[] = [{
      id: 'assistant-old', role: 'assistant', content: '', timestamp: 1,
      tool_calls: [{ id: 'call-old', type: 'function', function: {
        name: 'write', arguments: { file_path: '/repo/world.js', content: source },
      } }],
    }, result('old', 'Created new file /repo/world.js (2200 bytes)', {
      name: 'write', tool_call_id: 'call-old',
    }), result('new-1', bigPayload), result('new-2', bigPayload)];

    const reclaimed = evictStaleToolOutputs(messages, estimateFull);
    const call = reclaimed.messages[0]!.tool_calls![0]!;
    const args = call.function.arguments;

    expect(reclaimed.evictedCount).toBeGreaterThanOrEqual(1);
    expect(reclaimed.reclaimedTokens).toBeGreaterThan(300);
    expect(args.file_path).toBe('/repo/world.js');
    expect(args.content).not.toContain('x'.repeat(100));
    expect(args.content).toContain('export class World');
    expect(args.content).toContain('getBlock(x, y, z)');
    expect(reclaimed.messages[0]!.metadata?.toolArgumentsEvicted).toBe(true);
    // The durable input array remains untouched.
    expect(messages[0]!.tool_calls![0]!.function.arguments.content).toBe(source);
  });

  it('prioritizes exported callables over long runs of exported constants', () => {
    const constants = Array.from({ length: 20 }, (_, index) => `export const VALUE_${index} = ${index};`).join('\n');
    const source = `${constants}\nexport function isSolid(id) { return id > 0; }\nexport class Registry {}`;
    const messages: Message[] = [{
      id: 'assistant-old', role: 'assistant', content: '', timestamp: 1,
      tool_calls: [{ id: 'call-old', type: 'function', function: {
        name: 'write', arguments: { file_path: '/repo/blocks.js', content: source },
      } }],
    }, result('old', 'created', { name: 'write', tool_call_id: 'call-old' }), result('new-1', bigPayload), result('new-2', bigPayload)];

    const compacted = evictStaleToolOutputs(messages, estimateFull);
    const outline = compacted.messages[0]!.tool_calls![0]!.function.arguments.content as string;

    expect(outline).toContain('export function isSolid(id)');
    expect(outline).toContain('export class Registry');
  });

  it('does not evict arguments for failed or recent mutations', () => {
    const source = 'export const value = 1;\n' + 'x'.repeat(2_000);
    const assistant = (id: string): Message => ({
      id: `assistant-${id}`, role: 'assistant', content: '', timestamp: 1,
      tool_calls: [{ id: `call-${id}`, type: 'function', function: {
        name: 'write', arguments: { file_path: `/repo/${id}.js`, content: source },
      } }],
    });
    const messages = [
      assistant('failed'), result('failed', 'permission denied', {
        name: 'write', tool_call_id: 'call-failed', is_error: true,
      }),
      assistant('recent-1'), result('recent-1', 'ok', { name: 'write', tool_call_id: 'call-recent-1' }),
      assistant('recent-2'), result('recent-2', 'ok', { name: 'write', tool_call_id: 'call-recent-2' }),
    ];

    const reclaimed = evictStaleToolOutputs(messages, estimateFull);
    expect(reclaimed.messages.find(message => message.id === 'assistant-failed')!
      .tool_calls![0]!.function.arguments.content).toBe(source);
    expect(reclaimed.messages.find(message => message.id === 'assistant-recent-1')!
      .tool_calls![0]!.function.arguments.content).toBe(source);
  });
});
