import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityStream } from '../ActivityStream.js';
import { ConversationViewStore } from '../ConversationViewStore.js';
import { reconstructToolCallsFromMessages } from '../conversationTools.js';
import { ActivityEventType as E, type Message } from '../../types/index.js';

const stores: ConversationViewStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.useRealTimers(); });

function setup(parentId?: string) {
  const stream = new ActivityStream(parentId);
  const messages: Message[] = [];
  const store = new ConversationViewStore(stream, () => messages, items => reconstructToolCallsFromMessages(items, { get: () => null }));
  stores.push(store);
  const emit = (type: E, data: Record<string, unknown> = {}, id = 'event', parent?: string) =>
    stream.emit({ type, id, data, timestamp: Date.now(), parentId: parent });
  return { stream, messages, store, emit };
}

describe.each([undefined, 'child'])('conversation projection (%s)', parent => {
  it('retains live output before subscription and across unsubscribe/re-entry', () => {
    const { store, emit } = setup(parent);
    emit(E.ASSISTANT_CHUNK, { chunk: 'first' });
    expect(store.getSnapshot().streamingContent).toBe('first');
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    emit(E.ASSISTANT_CHUNK, { chunk: ' second' });
    expect(store.getSnapshot().streamingContent).toBe('first second');
    emit(E.MODEL_STREAM_RESET);
    expect(store.getSnapshot().streamingContent).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps cumulative tool output, display flags and diffs through durable completion', () => {
    const { store, messages, emit } = setup(parent);
    emit(E.TOOL_CALL_START, { toolName: 'read', displayIcon: 'x', arguments: {} }, 'tool');
    emit(E.TOOL_EXECUTION_START, {}, 'tool');
    emit(E.TOOL_OUTPUT_CHUNK, { chunk: 'first' }, 'tool');
    emit(E.TOOL_OUTPUT_CHUNK, { chunk: ' second' }, 'tool');
    emit(E.DIFF_PREVIEW, { oldContent: 'old', newContent: 'new', filePath: 'file', operationType: 'edit' }, 'tool');
    expect(store.getSnapshot().activeToolCalls[0]).toMatchObject({ status: 'executing', output: 'first second' });
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'tool', type: 'function', function: { name: 'read', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: 'tool', content: 'wire content', timestamp: 20, metadata: { tool_result: { tool: { success: true, content: 'finished' } } } });
    emit(E.CONVERSATION_MESSAGE_ADDED, { message: messages.at(-1) });
    expect(store.getSnapshot().activeToolCalls[0]).toMatchObject({ status: 'success', output: 'finished', displayIcon: 'x', diffPreview: { newContent: 'new' } });
    emit(E.AGENT_END, { isSpecializedAgent: !!parent });
    expect(store.getSnapshot().activeToolCalls[0]?.status).toBe('success');
  });

  it('retains presentation messages on append, and replaces them on rewind/resume', () => {
    const { store, messages, emit } = setup(parent);
    store.addDisplayMessage({ id: 'notice', role: 'assistant', content: 'notice', timestamp: 1 });
    messages.push({ id: 'user', role: 'user', content: 'hello', timestamp: 2 });
    emit(E.CONVERSATION_MESSAGE_ADDED, { message: messages[0] });
    emit(E.CONVERSATION_MESSAGE_ADDED, { message: messages[0] });
    expect(store.getSnapshot().messages.map(message => message.content)).toEqual(['notice', 'hello']);
    store.refresh(true);
    expect(store.getSnapshot().messages.map(message => message.content)).toEqual(['hello']);
  });

  it('never declares a call successful without a result and settles missing outcomes at turn end', () => {
    const { store, messages, emit } = setup(parent);
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'lost', type: 'function', function: { name: 'read', arguments: '{}' } }] });
    store.refresh();
    expect(store.getSnapshot().activeToolCalls[0]?.status).toBe('pending');
    emit(E.AGENT_END, { interrupted: true, isSpecializedAgent: !!parent });
    expect(store.getSnapshot().activeToolCalls[0]?.status).toBe('cancelled');
  });
});

it('does not let delegated lifecycle events end the primary conversation', () => {
  const { store, emit } = setup();
  emit(E.AGENT_START);
  emit(E.AGENT_END, { isSpecializedAgent: true });
  expect(store.getSnapshot().isThinking).toBe(true);
});

it('releases stream subscriptions and pending notifications on close', () => {
  vi.useFakeTimers();
  const { store, stream, emit } = setup();
  emit(E.ASSISTANT_CHUNK, { chunk: 'retained' });
  store.close();
  expect(stream.getListenerCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  emit(E.ASSISTANT_CHUNK, { chunk: 'ignored' });
  expect(store.getSnapshot().streamingContent).toBe('retained');
});

it('binds lifecycle to the owner even when an unscoped background completion omits its kind', () => {
  const stream = new ActivityStream();
  const store = new ConversationViewStore(stream, () => [], () => [], 'primary');
  stores.push(store);
  stream.emit({ type: E.AGENT_START, id: 'start', timestamp: 1, data: { instanceId: 'primary' } });
  stream.emit({ type: E.AGENT_END, id: 'child-call', timestamp: 2, data: { agentName: 'explore', result: 'done' } });
  expect(store.getSnapshot().isThinking).toBe(true);
  stream.emit({ type: E.AGENT_END, id: 'end', timestamp: 3, data: { instanceId: 'primary' } });
  expect(store.getSnapshot().isThinking).toBe(false);
});
