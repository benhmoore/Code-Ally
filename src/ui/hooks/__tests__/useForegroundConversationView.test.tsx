import React, { useEffect } from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from '@agent/Agent.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ActivityEventType, type Message } from '@shared/index.js';
import {
  type ForegroundConversationView,
  useForegroundConversationView,
} from '../useForegroundConversationView.js';

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true;
  write = (): boolean => true;
}

const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
  const registry = ServiceRegistry.getInstance() as any;
  registry._services.clear();
  registry._descriptors.clear();
});

describe('useForegroundConversationView', () => {
  it('projects child messages and live chunks without mutating root state', async () => {
    const stream = new ActivityStream('child-call');
    const messages: Message[] = [{ role: 'user', content: 'child task' }];
    let processing = true;
    const child = {
      getMessages: () => messages,
      getActivityStream: () => stream,
      isProcessing: () => processing,
    } as Agent;
    const observed: Array<ForegroundConversationView | null> = [];

    const Harness = () => {
      const view = useForegroundConversationView('child-id', child);
      useEffect(() => { observed.push(view); }, [view]);
      return null;
    };

    const instance = render(<Harness />, {
      stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    mounted.push(instance);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observed.at(-1)?.messages).toEqual(messages);
    expect(observed.at(-1)?.isThinking).toBe(true);

    messages.push({ role: 'user', content: 'follow-up' });
    stream.emit({
      id: 'message-added',
      type: ActivityEventType.CONVERSATION_MESSAGE_ADDED,
      timestamp: Date.now(),
      data: { message: messages.at(-1)! },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed.at(-1)?.messages.at(-1)?.content).toBe('follow-up');

    stream.emit({
      id: 'display-error',
      type: ActivityEventType.CONVERSATION_DISPLAY_MESSAGE,
      timestamp: Date.now(),
      data: { message: { role: 'assistant', content: 'route-local error' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed.at(-1)?.messages.at(-1)?.content).toBe('route-local error');

    stream.emit({
      id: 'chunk',
      type: ActivityEventType.ASSISTANT_CHUNK,
      timestamp: Date.now(),
      data: { chunk: 'working' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed.at(-1)?.streamingContent).toBe('working');

    stream.emit({
      id: 'retry-boundary',
      type: ActivityEventType.MODEL_STREAM_RESET,
      timestamp: Date.now(),
      data: { reason: 'Stream timeout', attempt: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed.at(-1)?.streamingContent).toBeUndefined();

    stream.emit({
      id: 'replacement-chunk',
      type: ActivityEventType.ASSISTANT_CHUNK,
      timestamp: Date.now(),
      data: { chunk: 'replacement' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed.at(-1)?.streamingContent).toBe('replacement');

    messages.push({ role: 'assistant', content: 'done' });
    processing = false;
    stream.emit({
      id: 'complete',
      type: ActivityEventType.ASSISTANT_MESSAGE_COMPLETE,
      timestamp: Date.now(),
      data: { content: 'done' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observed.at(-1)?.messages).toEqual(messages);
    expect(observed.at(-1)?.streamingContent).toBeUndefined();
    expect(observed.at(-1)?.isThinking).toBe(false);

    stream.emit({
      id: 'clear',
      type: ActivityEventType.CONVERSATION_CLEAR,
      timestamp: Date.now(),
      data: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed.at(-1)?.messages).toEqual([]);
  });
});
