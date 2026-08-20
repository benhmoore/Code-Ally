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

const UNSUPPORTED_IMAGE_NOTICE =
  'The active model does not support image input, so the image attachment was not included in this request. Do not claim to have visually inspected it; use non-visual evidence or switch to a vision-capable model.';

/**
 * Prepare every image-bearing message for a provider request.
 *
 * Tool protocols cannot reliably carry image blocks in tool-result messages,
 * so those attachments first become ordinary user turns. When the selected
 * model is known to be text-only, preserve the stored attachment and omit it
 * only from the wire copy, leaving an explicit notice in its place. This keeps
 * conversation state lossless and prevents a screenshot's textual success
 * message from being mistaken for visual access.
 */
export function prepareMessageImages(
  messages: readonly Message[],
  supportsImages: boolean | undefined = undefined,
): readonly Message[] {
  const materialized = materializeToolImageMessages(messages);
  if (supportsImages !== false || !materialized.some(message => message.images?.length)) {
    return materialized;
  }

  return materialized.map(message => {
    if (!message.images?.length) return message;
    const { images: _images, ...textOnlyMessage } = message;
    return {
      ...textOnlyMessage,
      content: message.content
        ? `${message.content}\n\n${UNSUPPORTED_IMAGE_NOTICE}`
        : UNSUPPORTED_IMAGE_NOTICE,
    };
  });
}

/** True only when a failed multimodal request explicitly identifies image input. */
export function isImageInputRejection(error: unknown, requestContainedImages: boolean): boolean {
  if (!requestContainedImages) return false;
  const candidate = error as { message?: unknown; httpStatus?: unknown; status?: unknown };
  const message = String(candidate?.message ?? error).toLowerCase();
  const statusValue = candidate?.httpStatus ?? candidate?.status;
  const status = typeof statusValue === 'number' ? statusValue : undefined;
  const explicitReason =
    message.includes('cannot decode or download image')
    || message.includes('does not support images')
    || message.includes('does not support image input')
    || message.includes('vision is not supported');

  return explicitReason || ([400, 415].includes(status ?? 0) && message.includes('image'));
}
