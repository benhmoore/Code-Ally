import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/index.js';
import { materializeToolImageMessages } from '../messageImages.js';

describe('materializeToolImageMessages', () => {
  it('returns the original array when no tool images are present', () => {
    const messages: Message[] = [{ role: 'user', content: 'hello' }];
    expect(materializeToolImageMessages(messages)).toBe(messages);
  });

  it('places combined images after every result in a parallel tool-call run', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'shot', arguments: {} } },
          { id: 'call-2', type: 'function', function: { name: 'inspect', arguments: {} } },
        ],
      },
      { role: 'tool', name: 'shot', tool_call_id: 'call-1', content: 'one', images: ['data:image/png;base64,ONE'] },
      { role: 'tool', name: 'inspect', tool_call_id: 'call-2', content: 'two', images: ['data:image/webp;base64,TWO'] },
      { role: 'assistant', content: 'done' },
    ];

    const normalized = materializeToolImageMessages(messages);

    expect(normalized.map(message => message.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'assistant']);
    expect(normalized[1]?.images).toBeUndefined();
    expect(normalized[2]?.images).toBeUndefined();
    expect(normalized[3]).toMatchObject({
      id: 'tool-images:call-1,call-2',
      images: ['data:image/png;base64,ONE', 'data:image/webp;base64,TWO'],
    });
    expect(messages[1]?.images).toEqual(['data:image/png;base64,ONE']);
  });
});
