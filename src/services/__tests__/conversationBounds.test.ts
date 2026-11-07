import { describe, expect, it } from 'vitest';
import type { Message, ToolCallState } from '../../types/index.js';
import { boundVisibleMessages, boundToolCalls } from '../conversationBounds.js';

describe('live conversation bounds', () => {
  it('bounds nested arguments, display payloads, attachments and reasoning without mutating sources', () => {
    const bulk = '\u0000é😀'.repeat(500_000);
    const call = {
      id: 'large', toolName: 'write', status: 'success', startTime: 1,
      arguments: { content: bulk }, result: { success: true, display_content: bulk, images: [{ data: bulk }] },
    } as ToolCallState;
    const bounded = boundToolCalls([call])[0]!;
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(64 * 1024);
    expect(call.arguments.content).toBe(bulk);
    const messages = boundVisibleMessages([{ id: 'latest', role: 'assistant', content: 'done', thinking: bulk, metadata: { payload: bulk }, images: [{ data: bulk }] } as Message]);
    expect(messages).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it('preserves settled row identity after output has been bounded', () => {
    const call = { id: 'done', status: 'success', output: 'x'.repeat(100_000) } as ToolCallState;
    const first = boundToolCalls([call])[0]!;
    expect(first.output!.length).toBeLessThanOrEqual(64 * 1024);
    expect(call.output).toHaveLength(100_000);
    const running = { id: 'live', status: 'running', output: 'chunk' } as ToolCallState;
    const next = boundToolCalls([first, running]);
    expect(next[0]).toBe(first);
    expect(next[1]).toBe(running);
  });
  it('does not hydrate discarded old content when the visible tail is full', () => {
    const old: Message = { role: 'user', get content(): string { throw new Error('Old history was hydrated'); } };
    const tail: Message[] = Array.from({ length: 500 }, (_, index) => ({ role: 'assistant', content: `${index}` }));
    expect(boundVisibleMessages([old, ...tail])).toEqual(tail);
    expect(tail[0]?.content).toBe('0');
  });

  it('excludes tool/system records and displays original user submissions', () => {
    const messages: Message[] = [
      { role: 'system', content: 'internal' },
      { role: 'user', content: 'expanded', metadata: { submittedContent: 'original' } },
      { role: 'tool', content: 'tool output' },
      { role: 'assistant', content: 'answer' },
    ];
    expect(boundVisibleMessages(messages).map(message => message.content)).toEqual(['original', 'answer']);
    expect(messages[1]?.content).toBe('expanded');
  });

  it('bounds UTF-8 bytes while retaining the newest visible message', () => {
    const content = 'é'.repeat(1024 * 1024);
    const messages: Message[] = [
      { id: 'old', role: 'assistant', content },
      { id: 'new', role: 'assistant', content },
    ];
    const visible = boundVisibleMessages(messages);
    expect(visible.map(message => message.id)).toEqual(['new']);
    expect(Buffer.byteLength(JSON.stringify(visible))).toBeLessThan(4 * 1024 * 1024);
  });
});
