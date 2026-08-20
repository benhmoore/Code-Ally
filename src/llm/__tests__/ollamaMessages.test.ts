import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/index.js';
import { normalizeOllamaMessages } from '../ollamaMessages.js';

describe('normalizeOllamaMessages', () => {
  it('returns an already compatible conversation unchanged', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Stable instructions' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];

    expect(normalizeOllamaMessages(messages)).toBe(messages);
  });

  it('maps late system reminders to user continuations without moving or mutating them', () => {
    const reminder: Message = {
      id: 'reminder-1',
      role: 'system',
      content: '<system-reminder>Current context</system-reminder>',
      metadata: { ephemeral: true },
    };
    const messages: Message[] = [
      { role: 'system', content: 'Stable instructions' },
      { role: 'user', content: 'Build it' },
      { role: 'assistant', content: 'Working' },
      reminder,
    ];

    const normalized = normalizeOllamaMessages(messages);

    expect(normalized.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(normalized[3]).toEqual({ ...reminder, role: 'user' });
    expect(messages[3]).toBe(reminder);
    expect(reminder.role).toBe('system');
  });

  it('combines multiple leading system messages into one', () => {
    const messages: Message[] = [
      { role: 'system', content: 'Stable instructions' },
      { role: 'system', content: 'Session instructions' },
      { role: 'user', content: 'Hello' },
    ];

    const normalized = normalizeOllamaMessages(messages);

    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toMatchObject({
      role: 'system',
      content: 'Stable instructions\n\nSession instructions',
    });
    expect(normalized[1]).toBe(messages[2]);
    expect(messages).toHaveLength(3);
  });

  it('maps every system message to user when the conversation has no leading system message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'system', content: '<system-reminder>Continue</system-reminder>' },
    ];

    expect(normalizeOllamaMessages(messages).map(message => message.role)).toEqual(['user', 'user']);
  });

  it('converts tool-result data URIs to raw base64 for Ollama', () => {
    const messages: Message[] = [
      {
        role: 'tool',
        name: 'browser/screenshot',
        tool_call_id: 'screenshot-1',
        content: 'Screenshot captured',
        images: ['data:image/png;base64,aW1hZ2U='],
      },
    ];

    const normalized = normalizeOllamaMessages(messages);

    expect(normalized).toHaveLength(2);
    expect(normalized[0]).not.toHaveProperty('images');
    expect(normalized[1]).toMatchObject({
      role: 'user',
      images: ['aW1hZ2U='],
    });
    expect(messages[0]!.images).toEqual(['data:image/png;base64,aW1hZ2U=']);
  });

  it('does not send tool images to a model known to be text-only', () => {
    const messages: Message[] = [{
      role: 'tool',
      name: 'browser/screenshot',
      tool_call_id: 'screenshot-1',
      content: 'Screenshot captured',
      images: ['data:image/png;base64,aW1hZ2U='],
    }];

    const normalized = normalizeOllamaMessages(messages, false);

    expect(normalized).toHaveLength(2);
    expect(normalized.every(message => !message.images?.length)).toBe(true);
    expect(normalized[1]?.content).toContain('does not support image input');
    expect(messages[0]?.images).toEqual(['data:image/png;base64,aW1hZ2U=']);
  });

  it('leaves existing raw Ollama image payloads unchanged', () => {
    const message: Message = {
      role: 'user',
      content: 'Inspect this image',
      images: ['aW1hZ2U='],
    };

    const messages = [message];
    expect(normalizeOllamaMessages(messages)).toBe(messages);
    expect(message.images).toEqual(['aW1hZ2U=']);
  });
});
