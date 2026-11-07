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
  it('owns one exact inline permission audit per call across re-entry and persisted restore', () => {
    const { store, messages, emit } = setup(parent);
    emit(E.TOOL_CALL_START, { toolName: 'read', arguments: {} }, 'first');
    emit(E.TOOL_CALL_START, { toolName: 'read', arguments: {} }, 'second');
    const decision = { toolName: 'read', verdict: 'ask', reason: 'Authorization unclear', source: 'reviewer', reviewerModel: 'decision:4b', timestamp: 100 };
    emit(E.TOOL_PERMISSION_DECISION, { decision }, 'second');
    emit(E.TOOL_PERMISSION_DECISION, { decision }, 'second');
    const unsubscribe = store.subscribe(() => {});
    unsubscribe();
    expect(store.getSnapshot().activeToolCalls.find(call => call.id === 'first')?.permissionDecision).toBeUndefined();
    expect(store.getSnapshot().activeToolCalls.find(call => call.id === 'second')?.permissionDecision).toEqual(decision);
    expect(store.getSnapshot().activeToolCalls).toHaveLength(2);
    messages.push({ id: 'assistant', role: 'assistant', content: '', tool_calls: [
      { id: 'second', type: 'function', function: { name: 'read', arguments: {} } },
    ] }, { id: 'result', role: 'tool', tool_call_id: 'second', content: 'ok', metadata: {
      tool_permission: { second: decision as any },
    } });
    store.refresh(true);
    expect(store.getSnapshot().activeToolCalls).toHaveLength(1);
    expect(store.getSnapshot().activeToolCalls[0]?.permissionDecision).toEqual(decision);
  });

  it('owns nested interjections and acknowledgments across subscriptions and transcript refresh', () => {
    const { store, messages, stream, emit } = setup(parent);
    emit(E.TOOL_CALL_START, { toolName: 'agent', arguments: {} }, 'tool');
    const event = { id: 'direction-event', type: E.USER_INTERJECTION, parentId: 'tool', timestamp: 100,
      data: { message: 'Preserve the public API.' } };
    stream.emit(event);
    stream.emit(event);
    const unsubscribe = store.subscribe(() => {});
    unsubscribe();
    stream.emit({ id: 'ack', type: E.INTERJECTION_ACKNOWLEDGMENT, parentId: 'tool', timestamp: 101,
      data: { acknowledgment: 'I will preserve it.' } });
    stream.emit({ id: 'ack', type: E.INTERJECTION_ACKNOWLEDGMENT, parentId: 'tool', timestamp: 101,
      data: { acknowledgment: 'I will preserve it.' } });
    messages.push({ id: 'assistant', role: 'assistant', content: '', tool_calls: [{ id: 'tool', type: 'function', function: { name: 'agent', arguments: {} } }] });
    messages.push({ id: 'direction-message', role: 'user', content: 'Preserve the public API.', timestamp: 100,
      metadata: { isInterjection: true, parentId: 'tool' } });
    store.refresh();
    expect(store.getSnapshot().activeToolCalls[0]?.interjections).toHaveLength(1);
    expect(store.getSnapshot().activeToolCalls[0]?.acknowledgments).toEqual([{ id: 'ack', message: 'I will preserve it.', timestamp: 101 }]);
    store.refresh(true);
    expect(store.getSnapshot().activeToolCalls[0]?.interjections).toEqual([{ id: 'direction-message', message: 'Preserve the public API.', timestamp: 100 }]);
    expect(store.getSnapshot().activeToolCalls[0]?.acknowledgments).toBeUndefined();
  });

  it('projects a persisted nested interjection append without rebuilding the complete transcript', () => {
    const { store, emit } = setup(parent);
    emit(E.TOOL_CALL_START, { toolName: 'agent', arguments: {} }, 'tool');
    emit(E.CONVERSATION_MESSAGE_ADDED, { message: { id: 'direction', role: 'user', content: 'Submitted text plus hook', timestamp: 100,
      metadata: { isInterjection: true, parentId: 'tool', submittedContent: 'Submitted text' } } });
    expect(store.getSnapshot().activeToolCalls[0]?.interjections).toEqual([{ id: 'direction', message: 'Submitted text', timestamp: 100 }]);
  });

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

  it('keeps user expansion choices through streamed and reconstructed tool updates', () => {
    const { store, messages, emit } = setup(parent);
    emit(E.TOOL_CALL_START, { toolName: 'read', arguments: {}, collapsed: true }, 'tool');
    store.toggleToolCallExpanded('tool');
    emit(E.TOOL_OUTPUT_CHUNK, { chunk: 'live output' }, 'tool');
    expect(store.getSnapshot().activeToolCalls[0]?.expanded).toBe(true);
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'tool', type: 'function', function: { name: 'read', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: 'tool', content: 'finished' });
    store.refresh();
    expect(store.getSnapshot().activeToolCalls[0]?.expanded).toBe(true);
    store.setToolCallsExpanded(false);
    expect(store.getSnapshot().activeToolCalls[0]?.expanded).toBe(false);
    store.toggleToolCallExpanded('missing');
    expect(store.getSnapshot().activeToolCalls).toHaveLength(1);
  });

  it('owns status, token usage, and compaction transitions without a frontend reducer', () => {
    const { store, emit } = setup(parent);
    store.setContextUsage(42);
    emit(E.STATUS_MESSAGE, { message: 'retry one' }, 'retry');
    emit(E.STATUS_MESSAGE, { message: 'retry two' }, 'retry');
    emit(E.COMPACTION_START);
    expect(store.getSnapshot()).toMatchObject({ contextUsage: 42, isCompacting: true });
    emit(E.COMPACTION_COMPLETE, { oldContextUsage: 42, newContextUsage: 10, threshold: 80 });
    expect(store.getSnapshot()).toMatchObject({ contextUsage: 10, isCompacting: false,
      statusMessages: [{ id: 'retry', message: 'retry two' }],
      compactionNotices: [{ oldContextUsage: 42, threshold: 80 }],
    });
    emit(E.COMPACTION_START);
    emit(E.COMPACTION_COMPLETE, { error: true });
    expect(store.getSnapshot().isCompacting).toBe(false);
    expect(store.getSnapshot().compactionNotices).toHaveLength(1);
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

it('keeps generation estimates scoped and available across view subscriptions, resetting on retry and history replacement', () => {
  const { store, stream } = setup();
  const send = (type: E, timestamp: number, data: Record<string, unknown> = {}, parentId?: string) =>
    stream.emit({ type, timestamp, data, parentId, id: 'rate' });
  send(E.MODEL_REQUEST_START, 0);
  send(E.THOUGHT_CHUNK, 5000, { thinking: true });
  send(E.THOUGHT_CHUNK, 10000, { chunk: 'first' });
  send(E.ASSISTANT_CHUNK, 12000, { chunk: 'a'.repeat(160) });
  expect(store.getSnapshot().generationRate).toBe(20);
  send(E.ASSISTANT_CHUNK, 13000, { chunk: 'a'.repeat(4000) }, 'different-agent');
  expect(store.getSnapshot().generationRate).toBe(20);
  send(E.MODEL_REQUEST_END, 14000);
  send(E.TOOL_OUTPUT_CHUNK, 16000, { chunk: 'output'.repeat(1000) });
  expect(store.getSnapshot().generationRate).toBe(20);
  send(E.MODEL_STREAM_RESET, 20000);
  expect(store.getSnapshot().generationRate).toBeUndefined();
  send(E.ASSISTANT_CHUNK, 22000, { chunk: 'first' });
  send(E.ASSISTANT_CHUNK, 24000, { chunk: 'a'.repeat(80) });
  expect(store.getSnapshot().generationRate).toBe(10);
  store.refresh(true);
  expect(store.getSnapshot().generationRate).toBeUndefined();
});

it('projects appended records incrementally and preserves unrelated settled rows', () => {
  const stream = new ActivityStream();
  const messages: Message[] = [];
  const reconstruct = vi.fn((items: Message[]) => reconstructToolCallsFromMessages(items, { get: () => null }));
  const store = new ConversationViewStore(stream, () => messages, reconstruct);
  stores.push(store);
  for (let index = 0; index < 500; index++) {
    const message: Message = { id: `message-${index}`, role: 'user', content: `${index}` };
    messages.push(message);
    stream.emit({ type: E.CONVERSATION_MESSAGE_ADDED, id: `append-${index}`, timestamp: index, data: { message } });
  }
  expect(reconstruct).toHaveBeenCalledTimes(1);
  stream.emit({ type: E.TOOL_CALL_START, id: 'done', timestamp: 500, data: { toolName: 'read', arguments: {} } });
  stream.emit({ type: E.TOOL_CALL_END, id: 'done', timestamp: 501, data: { success: true, result: { success: true, content: 'finished' } } });
  const settled = store.getSnapshot().activeToolCalls[0];
  const message: Message = { id: 'next', role: 'user', content: 'next' };
  messages.push(message);
  stream.emit({ type: E.CONVERSATION_MESSAGE_ADDED, id: 'next-event', timestamp: 502, data: { message } });
  expect(store.getSnapshot().activeToolCalls[0]).toBe(settled);
  expect(reconstruct).toHaveBeenCalledTimes(1);
});
