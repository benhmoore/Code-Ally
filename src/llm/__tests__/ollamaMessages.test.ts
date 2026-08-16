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
});
