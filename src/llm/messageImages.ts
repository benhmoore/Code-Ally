import type { Message } from '../types/index.js';

/**
 * Convert images attached to tool results into ordinary multimodal user turns.
 *
 * Provider protocols agree on user-image input but differ on whether a tool
 * result may itself contain an image. Keep the internal association on the
 * tool message, then materialize one user turn after each consecutive run of
 * tool results. Waiting until the end of the run preserves the required
 * assistant -> all tool results ordering for parallel tool calls.
 */
export function materializeToolImageMessages(messages: readonly Message[]): readonly Message[] {
  if (!messages.some(message => message.role === 'tool' && message.images?.length)) {
    return messages;
  }

  const normalized: Message[] = [];

  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role !== 'tool') {
      normalized.push(message);
      index++;
      continue;
    }

    const images: string[] = [];
    const sources: string[] = [];
    const callIds: string[] = [];

    while (index < messages.length && messages[index]!.role === 'tool') {
      const toolMessage = messages[index]!;
      if (toolMessage.images?.length) {
        images.push(...toolMessage.images);
        sources.push(toolMessage.name ?? 'tool');
        if (toolMessage.tool_call_id) callIds.push(toolMessage.tool_call_id);
        const { images: _images, ...textOnlyMessage } = toolMessage;
        normalized.push(textOnlyMessage);
      } else {
        normalized.push(toolMessage);
      }
      index++;
    }

    if (images.length > 0) {
      normalized.push({
        id: `tool-images:${callIds.join(',')}`,
        role: 'user',
        content: `Image attachment${images.length === 1 ? '' : 's'} returned by ${[...new Set(sources)].join(', ')}. Inspect the image content directly; do not try to read a temporary file path from the textual tool result.`,
        images,
      });
    }
  }

  return normalized;
}
