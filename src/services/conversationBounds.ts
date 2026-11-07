import type { Message, ToolCallState } from '../types/index.js';

const LIVE_MESSAGE_LIMIT = 500;
const LIVE_MESSAGE_BYTES = 4 * 1024 * 1024;
const COMPLETED_TOOL_LIMIT = 500;
const TOOL_BYTES = 64 * 1024;
const MESSAGE_BYTES = LIVE_MESSAGE_BYTES - 1024;
const messageProjections = new WeakMap<Message, Message>();
const messageSizes = new WeakMap<Message, number>();
const toolProjections = new WeakMap<ToolCallState, ToolCallState>();

/** Bound every presentation field, including nested metadata and attachments. */
function project(value: unknown, budget: number, depth = 0): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) <= budget) return value;
    const count = Math.max(0, Math.floor((budget - 64) / 16));
    return `${value.slice(0, count)}\n… content omitted …\n${count ? value.slice(-count) : ''}`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 8 || budget < 128) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    const selected = value.slice(0, 32);
    return selected.map(item => project(item, Math.floor(budget / Math.max(1, selected.length)) - 16, depth + 1));
  }
  const entries = Object.entries(value).slice(0, 64);
  const share = Math.max(0, Math.floor(budget / Math.max(1, entries.length)) - 1024);
  return Object.fromEntries(entries.map(([key, child]) => [key.slice(0, 128), project(child, share, depth + 1)]));
}

function boundMessage(source: Message): Message {
  const cached = messageProjections.get(source);
  if (cached) return cached;
  const content = source.role === 'user' ? source.metadata?.submittedContent ?? source.content : source.content;
  const submitted = content === source.content ? source : { ...source, content };
  let result = submitted;
  if (Buffer.byteLength(JSON.stringify(submitted)) > MESSAGE_BYTES) {
    result = project(submitted, MESSAGE_BYTES) as Message;
    result.role = source.role;
    result.id = source.id;
    result.timestamp = source.timestamp;
  }
  messageProjections.set(source, result);
  messageSizes.set(result, Buffer.byteLength(JSON.stringify(result)));
  return result;
}

export function boundVisibleMessages(messages: readonly Message[]): Message[] {
  const result: Message[] = [];
  let bytes = 2;
  for (let index = messages.length - 1; index >= 0 && result.length < LIVE_MESSAGE_LIMIT; index--) {
    const source = messages[index]!;
    if (source.role === 'system' || source.role === 'tool') continue;
    const message = boundMessage(source);
    const size = (messageSizes.get(message) ?? Buffer.byteLength(JSON.stringify(message))) + 1;
    if (bytes + size > LIVE_MESSAGE_BYTES) break;
    result.push(message);
    bytes += size;
  }
  return result.reverse();
}

function boundTool(call: ToolCallState): ToolCallState {
  const cached = toolProjections.get(call);
  if (cached) return cached;
  let result = call;
  if (Buffer.byteLength(JSON.stringify(call)) > TOOL_BYTES) {
    result = {
      ...project(call, TOOL_BYTES) as ToolCallState,
      id: call.id, toolName: call.toolName, status: call.status, startTime: call.startTime,
    };
  }
  toolProjections.set(call, result);
  toolProjections.set(result, result);
  return result;
}

export function boundToolCalls(calls: ToolCallState[]): ToolCallState[] {
  const running = calls.filter(call => !['success', 'error', 'cancelled'].includes(call.status));
  const completed = calls.filter(call => ['success', 'error', 'cancelled'].includes(call.status)).slice(-COMPLETED_TOOL_LIMIT);
  return [...completed, ...running].map(boundTool);
}
