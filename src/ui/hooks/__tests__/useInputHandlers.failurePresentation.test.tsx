import React, { useState } from 'react';
import { EventEmitter } from 'node:events';
import { Box, render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../agent/Agent.js';
import { OllamaClient } from '../../../llm/OllamaClient.js';
import { ToolManager } from '../../../tools/ToolManager.js';
import { DEFAULT_CONFIG } from '../../../config/defaults.js';
import { ActivityStream } from '../../../services/ActivityStream.js';
import { ModelCapabilitiesIndex } from '../../../services/ModelCapabilitiesIndex.js';
import type { Message } from '../../../types/index.js';
import type { AppActions } from '../../contexts/AppContext.js';
import { MessageDisplay } from '../../components/MessageDisplay.js';
import { useInputHandlers, type InputHandlers } from '../useInputHandlers.js';
import { useConversationSelector } from '../useConversationSelector.js';

vi.mock('../../../utils/terminal.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../utils/terminal.js')>(),
  sendTerminalNotification: vi.fn(),
}));

class Stdout extends EventEmitter {
  columns = 100;
  rows = 40;
  frames: string[] = [];
  write = (frame: string) => { this.frames.push(frame); return true; };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
function mount(stream = false) {
  vi.spyOn(ModelCapabilitiesIndex.getInstance(), 'load').mockResolvedValue();
  const activityStream = new ActivityStream();
  const client = new OllamaClient({ endpoint: 'http://fixture.invalid', modelName: 'fixture', contextSize: 8192, maxTokens: 1000 });
  const agent = new Agent(client, new ToolManager([]), activityStream, {
    config: { ...DEFAULT_CONFIG, model: 'fixture', stream_responses: stream, context_size: 8192 },
  });
  cleanups.push(() => agent.cleanup());
  const stdout = new Stdout();
  let handlers!: InputHandlers;
  let frontend: Message[] = [];
  function Harness() {
    const [display, setDisplay] = useState<Message[]>([]);
    frontend = display;
    const messages = useConversationSelector(agent.getSession(), view => view.messages);
    handlers = useInputHandlers(null, { id: 'main', kind: 'primary', agent, activityStream, isAvailable: () => true }, {
      addMessage: (message: Message) => setDisplay(previous => [...previous, message]), setContextUsage: () => {},
    } as unknown as AppActions);
    return <Box flexDirection="column">{[...messages, ...display].map((message, index) =>
      <MessageDisplay key={message.id ?? index} message={message}/>)}</Box>;
  }
  const instance = render(<Harness/>, { stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false });
  cleanups.push(() => instance.unmount());
  return { agent, stdout, submit: (text: string) => handlers.handleInput(text), frontend: () => frontend };
}
function brokenStream() {
  let delivered = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (!delivered) {
      delivered = true;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { role: 'assistant', content: 'Retained partial evidence.' }, done: false }) + '\n'));
    } else controller.error(new TypeError('fixture connection terminated'));
  } }, { highWaterMark: 0 }));
}

describe('one owner presents terminal failures', () => {
  it.each(['http400', 'partial'] as const)('renders one canonical error audit for %s through the input hook', async kind => {
    const fetch = vi.fn();
    if (kind === 'http400') fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Fixture request rejected' }), { status: 400 }));
    else fetch.mockResolvedValueOnce(brokenStream()).mockResolvedValueOnce(brokenStream());
    vi.stubGlobal('fetch', fetch);
    const ui = mount(kind === 'partial');
    await ui.submit('Run failure fixture');
    const outcome = ui.agent.getTurnSnapshot();
    expect(outcome.state).toBe('failed');
    expect(outcome.errorAuditId).toBeTruthy();
    const audits = ui.agent.getMessages().filter(message => message.metadata?.isError);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.id).toBe(outcome.errorAuditId);
    expect(ui.frontend()).toHaveLength(0);
    const needle = kind === 'http400' ? 'Fixture request rejected' : 'Model stream failed after one recovery attempt';
    await vi.waitFor(() => expect(plain(ui.stdout.frames.at(-1) ?? '').split(needle)).toHaveLength(2));
    if (kind === 'partial') expect(plain(ui.stdout.frames.at(-1) ?? '')).toContain('Retained partial evidence.');

    // A stale prior audit cannot hide an unrelated error before Agent admission.
    vi.spyOn(ui.agent, 'sendMessage').mockRejectedValueOnce(new Error('Preparation fixture failed'));
    await ui.submit('Try preparation');
    await vi.waitFor(() => expect(ui.frontend()).toHaveLength(1));
    expect(ui.frontend()[0]?.content).toBe('Error: Preparation fixture failed');
  });

  it('keeps interruption presentation visible and distinct from failed audit state', async () => {
    const ui = mount();
    vi.stubGlobal('fetch', vi.fn(async () => {
      ui.agent.interrupt({ kind: 'user_cancel' });
      throw new DOMException('Aborted', 'AbortError');
    }));
    await ui.submit('Cancel fixture');
    expect(ui.agent.getTurnSnapshot()).toMatchObject({ state: 'interrupted', errorAuditId: undefined });
    expect(ui.agent.getMessages().filter(message => message.metadata?.isError)).toHaveLength(0);
    await vi.waitFor(() => expect(ui.frontend()).toHaveLength(1));
    expect(ui.frontend()[0]?.content).toContain('Interrupted');
  });
});
