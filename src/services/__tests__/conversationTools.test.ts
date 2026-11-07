import { describe, expect, it } from 'vitest';
import { reconstructToolCallsFromMessages } from '../conversationTools.js';
import type { Message } from '../../types/index.js';

describe('persisted nested tool directions', () => {
  it('restores exact submitted interjections in order without replay or duplicate rows', () => {
    const direction: Message = { id: 'direction', role: 'user', content: 'user text plus hook', timestamp: 2,
      metadata: { isInterjection: true, parentId: 'tool', submittedContent: 'Exact user text' } };
    const messages: Message[] = [direction, direction,
      { id: 'call', role: 'assistant', content: '', timestamp: 1, tool_calls: [{ id: 'tool', type: 'function', function: { name: 'agent', arguments: {} } }] },
      { id: 'next', role: 'user', content: 'Next direction', timestamp: 3, metadata: { isInterjection: true, parentId: 'tool' } },
      { id: 'root', role: 'user', content: 'Root-only direction', timestamp: 4, metadata: { isInterjection: true, parentId: 'root' } },
    ];
    const restored = reconstructToolCallsFromMessages(JSON.parse(JSON.stringify(messages)), { get: () => null });
    expect(restored[0]?.interjections).toEqual([
      { id: 'direction', message: 'Exact user text', timestamp: 2 },
      { id: 'next', message: 'Next direction', timestamp: 3 },
    ]);
    expect(restored[0]?.acknowledgments).toBeUndefined();
  });
});
