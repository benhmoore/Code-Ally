import React from 'react';
import { EventEmitter } from 'node:events';
import { render, Text } from 'ink';
import { expect, it, vi } from 'vitest';
import { ActivityStream } from '@services/ActivityStream.js';
import { ConversationViewStore, type ConversationViewSnapshot } from '@services/ConversationViewStore.js';
import { ActivityEventType as E } from '@shared/index.js';
import { DEFAULT_CONFIG } from '@config/defaults.js';
import { AppProvider, useAppContext } from '../../contexts/AppContext.js';
import { frozenConversation, useConversationSelector, selectActivity, shallowEqual, type ConversationSource } from '../useConversationSelector.js';

class Stdout extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true;
  write = () => true;
}
const options = () => ({ stdout: new Stdout() as unknown as NodeJS.WriteStream,
  debug: true, exitOnCtrlC: false, patchConsole: false });
const text = (snapshot: ConversationViewSnapshot) => snapshot.streamingContent;

it('streams text without rerendering application controls or activity-only subscribers', async () => {
  const stream = new ActivityStream();
  const store = new ConversationViewStore(stream, () => [], () => []);
  stream.emit({ type: E.AGENT_START, id: 'start', timestamp: 0, data: {} });
  let controls = 0;
  let textValue: string | undefined;
  function LiveText() {
    textValue = useConversationSelector(store, text);
    return <Text>{textValue}</Text>;
  }
  function Controls() {
    useAppContext();
    useConversationSelector(store, selectActivity, shallowEqual);
    controls++;
    return <LiveText/>;
  }
  const instance = render(<AppProvider initialConfig={DEFAULT_CONFIG} conversationStore={store}><Controls/></AppProvider>, options());
  try {
    await vi.waitFor(() => expect(controls).toBeGreaterThan(0));
    const before = controls;
    for (let i = 0; i < 3; i++) {
      stream.emit({ type: E.ASSISTANT_CHUNK, id: String(i), timestamp: i, data: { chunk: 'next' } });
      await vi.waitFor(() => expect(textValue).toBe('next'.repeat(i + 1)));
    }
    expect(controls).toBe(before);
    stream.emit({ type: E.AGENT_END, id: 'end', timestamp: 4, data: {} });
    await vi.waitFor(() => expect(controls).toBeGreaterThan(before));
  } finally { instance.unmount(); store.close(); }
});

it('switches subscriptions without retaining another conversation and freezes completed views', async () => {
  const firstStream = new ActivityStream();
  const secondStream = new ActivityStream();
  const first = new ConversationViewStore(firstStream, () => [], () => []);
  const second = new ConversationViewStore(secondStream, () => [], () => []);
  let value: string | undefined;
  let renders = 0;
  function Surface({ source }: { source: ConversationSource }) {
    value = useConversationSelector(source, text);
    renders++;
    return null;
  }
  const emit = (stream: ActivityStream, chunk: string) => stream.emit({ type: E.ASSISTANT_CHUNK, id: chunk, timestamp: 1, data: { chunk } });
  const instance = render(<Surface source={first}/>, options());
  try {
    emit(firstStream, 'first');
    await vi.waitFor(() => expect(value).toBe('first'));
    instance.rerender(<Surface source={second}/>);
    await vi.waitFor(() => expect(value).toBeUndefined());
    emit(secondStream, 'second');
    await vi.waitFor(() => expect(value).toBe('second'));
    const frozen = frozenConversation(second.getSnapshot());
    instance.rerender(<Surface source={frozen}/>);
    await new Promise(resolve => setTimeout(resolve, 0));
    const count = renders;
    emit(firstStream, '-ignored');
    emit(secondStream, '-pooled-reuse');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(value).toBe('second');
    expect(renders).toBe(count);
  } finally { instance.unmount(); first.close(); second.close(); }
});
