import type { Message } from '../types/index.js';

/** Conversation lifetime is independent of a message's presentation role. */
export function isPersistentMessage(message: Message): boolean {
  return !message.metadata?.ephemeral
    && (message.role !== 'system' || message.metadata?.persistent === true);
}

/** Retain tool outcomes without retaining request-scoped payloads or attachments. */
export function persistentMessage(message: Message): Message | null {
  if (isPersistentMessage(message)) return message;
  if (!message.metadata?.ephemeral || message.role !== 'tool' || !message.tool_call_id) return null;
  return {
    id: message.id,
    timestamp: message.timestamp,
    role: 'tool',
    name: message.name,
    tool_call_id: message.tool_call_id,
    is_error: message.is_error,
    content: `[Tool Call ID: ${message.tool_call_id}]\nEphemeral tool output discarded; this call completed${message.is_error ? ' with an error' : ''}.`,
    metadata: { tool_status: message.metadata.tool_status },
  };
}

export function persistentMessages(messages: readonly Message[]): Message[] {
  return messages.map(persistentMessage).filter((message): message is Message => message !== null);
}
