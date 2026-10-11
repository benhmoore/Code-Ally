import React, { useEffect } from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { expect, it } from 'vitest';
import { AppProvider, useAppContext, type AppContextValue } from '../AppContext.js';
import { DEFAULT_CONFIG } from '../../../config/defaults.js';
import { ActivityStream } from '../../../services/ActivityStream.js';
import { ConversationViewStore } from '../../../services/ConversationViewStore.js';
import { ActivityEventType, type Message } from '../../../types/index.js';

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true;
  write = (): boolean => true;
}

it('exposes the authoritative runtime to application consumers and keeps notices across remounts', async () => {
  const stream = new ActivityStream();
  const messages: Message[] = [{ id: 'user', role: 'user', content: 'hello', timestamp: 1 }];
  const store = new ConversationViewStore(stream, () => messages, () => []);
  let context: AppContextValue | undefined;
  const Harness = () => {
    const value = useAppContext();
    useEffect(() => { context = value; }, [value]);
    return null;
  };
  const mount = () => render(<AppProvider initialConfig={DEFAULT_CONFIG} conversationStore={store}><Harness /></AppProvider>, {
    stdout: new FakeStdout() as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  let instance = mount();
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(context?.state.messages[0]?.content).toBe('hello');
    context!.actions.addMessage({ role: 'assistant', content: 'notice', timestamp: 2 });
    stream.emit({ id: 'start', type: ActivityEventType.AGENT_START, timestamp: 3, data: {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(context?.state.isThinking).toBe(true);
    expect(context?.state.messages.map(message => message.content)).toEqual(['hello', 'notice']);
    instance.unmount();
    messages.push({ id: 'reply', role: 'assistant', content: 'reply', timestamp: 4 });
    stream.emit({ id: 'message', type: ActivityEventType.CONVERSATION_MESSAGE_ADDED, timestamp: 4, data: { message: messages[1]! } });
    stream.emit({ id: 'end', type: ActivityEventType.AGENT_END, timestamp: 5, data: {} });
    instance = mount();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(context?.state.messages.map(message => message.content)).toEqual(['hello', 'notice', 'reply']);
    expect(context?.state.isThinking).toBe(false);
  } finally {
    instance.unmount();
    store.close();
  }
});
