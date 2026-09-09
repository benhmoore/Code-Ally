import type { Message } from '../types/index.js';

/** Conversation lifetime is independent of a message's presentation role. */
export function isPersistentMessage(message: Message): boolean {
  return !message.metadata?.ephemeral
    && (message.role !== 'system' || message.metadata?.persistent === true);
}
