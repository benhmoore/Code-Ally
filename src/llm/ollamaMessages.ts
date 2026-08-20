import type { Message } from '../types/index.js';
import { prepareMessageImages } from './messageImages.js';

/**
 * Normalize internal conversation history for Ollama's native chat endpoint.
 *
 * Some Ollama model templates reject a system message anywhere except the
 * beginning of the prompt. Code Ally intentionally appends XML-wrapped system
 * reminders during a turn, so the wire representation must adapt without
 * mutating the stored conversation or moving time-sensitive context.
 *
 * Wire invariant:
 * - zero or one system message
 * - when present, the system message is first
 * - later internal system reminders are user continuation messages
 */
export function normalizeOllamaMessages(
  messages: readonly Message[],
  supportsImages?: boolean,
): readonly Message[] {
  messages = prepareMessageImages(messages, supportsImages);
  messages = normalizeOllamaImages(messages);
  let leadingSystemCount = 0;
  while (messages[leadingSystemCount]?.role === 'system') {
    leadingSystemCount++;
  }

  const hasLateSystem = messages.slice(leadingSystemCount).some(message => message.role === 'system');

  if (leadingSystemCount <= 1 && !hasLateSystem) {
    return messages;
  }

  const normalized: Message[] = [];

  if (leadingSystemCount > 0) {
    const leadingSystemMessages = messages.slice(0, leadingSystemCount);
    const firstSystemMessage = leadingSystemMessages[0]!;
    normalized.push(
      leadingSystemCount === 1
        ? firstSystemMessage
        : {
            ...firstSystemMessage,
            content: leadingSystemMessages.map(message => message.content).join('\n\n'),
          }
    );
  }

  for (const message of messages.slice(leadingSystemCount)) {
    normalized.push(message.role === 'system' ? { ...message, role: 'user' } : message);
  }

  return normalized;
}

/**
 * Ollama's native `/api/chat` schema accepts raw base64 strings in
 * `message.images`. Internal messages use data URIs so MIME information is not
 * lost and OpenAI-compatible providers can consume them directly. Remove only
 * a valid base64 data-URI prefix at this provider boundary and leave existing
 * raw payloads unchanged.
 */
function normalizeOllamaImages(messages: readonly Message[]): readonly Message[] {
  let changed = false;
  const normalized = messages.map(message => {
    if (!message.images?.length) return message;

    const images = message.images.map(image => {
      const match = /^data:[^;,]+;base64,(.*)$/s.exec(image);
      if (!match) return image;
      changed = true;
      return match[1]!;
    });

    return images.some((image, index) => image !== message.images![index])
      ? { ...message, images }
      : message;
  });

  return changed ? normalized : messages;
}
