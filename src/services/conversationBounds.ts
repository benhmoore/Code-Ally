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

export function boundVisibleMessages(messages: readonly Message[]): Message[] {
  const result: Message[] = [];
  let bytes = 0;
  // Stop before reading and cloning discarded history. The durable transcript
  // can grow independently of this fixed-size live projection.
  for (let index = messages.length - 1; index >= 0 && result.length < LIVE_MESSAGE_LIMIT; index--) {
    const source = messages[index]!;
    if (source.role === 'system' || source.role === 'tool') continue;
    const message = { ...source, content: truncateMiddle(
      source.role === 'user' ? source.metadata?.submittedContent ?? source.content : source.content,
      1024 * 1024) ?? '' };
    const size = Buffer.byteLength(JSON.stringify(message));
    if (result.length > 0 && bytes + size > LIVE_MESSAGE_BYTES) break;
    result.push(message);
    bytes += size;
  }
  return result.reverse();
}

function compactSettledTool(call: ToolCallState): ToolCallState {
  if (!['success', 'error', 'cancelled'].includes(call.status)) return call;
  const output = truncateMiddle(call.output);
  const error = truncateMiddle(call.error);
  const thinking = truncateMiddle(call.thinking);
  const content = truncateMiddle(call.result?.content);
  const resultError = call.result ? truncateMiddle(call.result.error) ?? '' : undefined;
  const oldContent = call.diffPreview ? truncateMiddle(call.diffPreview.oldContent) ?? '' : undefined;
  const newContent = call.diffPreview ? truncateMiddle(call.diffPreview.newContent) ?? '' : undefined;
  // Settled rows should retain identity while an unrelated tool streams. This
  // keeps memoized history from rendering again on every live update.
  if (output === call.output && error === call.error && thinking === call.thinking
    && content === call.result?.content && resultError === call.result?.error
    && oldContent === call.diffPreview?.oldContent && newContent === call.diffPreview?.newContent) return call;
  return {
    ...call,
    output,
    error,
    thinking,
    result: call.result ? {
      ...call.result,
      content,
      error: resultError!,
    } : undefined,
    diffPreview: call.diffPreview ? {
      ...call.diffPreview,
      oldContent: oldContent!,
      newContent: newContent!,
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

