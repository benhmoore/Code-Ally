import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/index.js';
import {
  isImageInputRejection,
  materializeToolImageMessages,
  prepareMessageImages,
} from '../messageImages.js';

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

  it('omits images only from the wire copy for a text-only model', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Inspect this', images: ['data:image/png;base64,USER'] },
      { role: 'tool', name: 'shot', tool_call_id: 'call-1', content: 'captured', images: ['data:image/png;base64,TOOL'] },
    ];

    const normalized = prepareMessageImages(messages, false);

    expect(normalized).toHaveLength(3);
    expect(normalized.every(message => !message.images?.length)).toBe(true);
    expect(normalized[0]?.content).toContain('does not support image input');
    expect(normalized[2]?.content).toContain('Do not claim to have visually inspected');
    expect(messages[0]?.images).toEqual(['data:image/png;base64,USER']);
    expect(messages[1]?.images).toEqual(['data:image/png;base64,TOOL']);
  });

  it('preserves image input when support is unknown', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Inspect this', images: ['data:image/png;base64,USER'] },
    ];

    expect(prepareMessageImages(messages)[0]?.images).toEqual(messages[0]?.images);
  });

  it('recognizes explicit image rejection without treating generic server failures as image errors', () => {
    expect(isImageInputRejection(
      { httpStatus: 400, message: 'model does not support images' },
      true,
    )).toBe(true);
    expect(isImageInputRejection(
      { httpStatus: 500, message: 'system message must be at the beginning' },
      true,
    )).toBe(false);
    expect(isImageInputRejection(
      { httpStatus: 400, message: 'model does not support images' },
      false,
    )).toBe(false);
  });
});
