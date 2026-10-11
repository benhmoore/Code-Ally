import type { Message, ToolCallState } from '../types/index.js';

const LIVE_MESSAGE_LIMIT = 500;
const LIVE_MESSAGE_BYTES = 4 * 1024 * 1024;
const COMPLETED_TOOL_LIMIT = 500;
const TOOL_TEXT_LIMIT = 64 * 1024;

function truncateMiddle(value: string | undefined, max = TOOL_TEXT_LIMIT): string | undefined {
  if (!value || value.length <= max) return value;
  const half = Math.floor((max - 80) / 2);
  return `${value.slice(0, half)}\n… ${value.length - half * 2} characters omitted …\n${value.slice(-half)}`;
}

export function boundVisibleMessages(messages: Message[]): Message[] {
  const visible = messages
    .filter(message => message.role !== 'system' && message.role !== 'tool')
    .map(message => ({ ...message, content: truncateMiddle(
      message.role === 'user' ? message.metadata?.submittedContent ?? message.content : message.content,
      1024 * 1024) ?? '' }));
  const result: Message[] = [];
  let bytes = 0;
  for (let index = visible.length - 1; index >= 0 && result.length < LIVE_MESSAGE_LIMIT; index--) {
    const message = visible[index]!;
    const size = Buffer.byteLength(JSON.stringify(message));
    if (result.length > 0 && bytes + size > LIVE_MESSAGE_BYTES) break;
    result.push(message);
    bytes += size;
  }
  return result.reverse();
}

function compactSettledTool(call: ToolCallState): ToolCallState {
  if (!['success', 'error', 'cancelled'].includes(call.status)) return call;
  return {
    ...call,
    output: truncateMiddle(call.output),
    error: truncateMiddle(call.error),
    thinking: truncateMiddle(call.thinking),
    result: call.result ? {
      ...call.result,
      content: truncateMiddle(call.result.content),
      error: truncateMiddle(call.result.error) ?? '',
    } : undefined,
    diffPreview: call.diffPreview ? {
      ...call.diffPreview,
      oldContent: truncateMiddle(call.diffPreview.oldContent) ?? '',
      newContent: truncateMiddle(call.diffPreview.newContent) ?? '',
    } : undefined,
  };
}

export function boundToolCalls(calls: ToolCallState[]): ToolCallState[] {
  const running = calls.filter(call => !['success', 'error', 'cancelled'].includes(call.status));
  const completed = calls.filter(call => ['success', 'error', 'cancelled'].includes(call.status))
    .slice(-COMPLETED_TOOL_LIMIT)
    .map(compactSettledTool);
  const ids = new Set(running.map(call => call.id));
  return [...completed.filter(call => !ids.has(call.id)), ...running];
}

