import React from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Box, Text, render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { BottomAlignedLayout } from '../BottomAlignedLayout.js';
import { ConversationView } from '../ConversationView.js';
import { TerminalContext, deriveWidths } from '../../contexts/TerminalContext.js';
import { InputPrompt } from '../InputPrompt.js';
import type { Message } from '../../../types/index.js';
import type { CompletionProvider } from '../../../services/CompletionProvider.js';

class Stdout extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true;
  frames: string[] = [];
  write = (value: string) => { this.frames.push(value); return true; };
}
class Stdin extends PassThrough {
  isTTY = true;
  setRawMode = () => this;
  ref = () => this;
  unref = () => this;
}
const mounts: Array<{ unmount: () => void }> = [];
afterEach(() => mounts.splice(0).forEach(instance => instance.unmount()));
const settle = () => new Promise(resolve => setTimeout(resolve, 80));
const strip = (value: string) => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function surface(messages: Message[] = [], options: { rows?: number; columns?: number; stream?: string; draft?: string; footer?: React.ReactNode } = {}) {
  return <TerminalContext.Provider value={deriveWidths(options.columns ?? 80, options.rows ?? 24)}>
    <BottomAlignedLayout historyKey={0} footer={options.footer ?? <Box flexDirection="column">
      <Text>READY</Text><InputPrompt prominent onSubmit={() => {}} bufferValue={options.draft ?? ''} onBufferChange={() => {}}/><Text>MODEL</Text>
    </Box>}>
      <ConversationView messages={messages} streamingContent={options.stream} staticRemountKey={0} config={{ model: 'test' }}/>
    </BottomAlignedLayout>
  </TerminalContext.Provider>;
}
function mount(node: React.ReactElement, debug = true) {
  const stdout = new Stdout();
  const stdin = new Stdin();
  const instance = render(node, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, debug,
    exitOnCtrlC: false, patchConsole: false });
  mounts.push(instance);
  return { stdout, stdin, instance };
}

describe('bottom interaction layout', () => {
  it('anchors idle and short-history controls while preserving the newly committed message', async () => {
    const { stdout, instance } = mount(surface());
    await settle();
    const idle = strip(stdout.frames.findLast(frame => strip(frame).trim().length > 0)!).split('\n');
    expect(idle.findIndex(line => line.includes('MODEL'))).toBe(22);
    instance.rerender(surface([{ id: 'one', role: 'user', content: 'FIRST MESSAGE' }]));
    await settle();
    const committed = strip(stdout.frames.findLast(frame => strip(frame).trim().length > 0)!).split('\n');
    expect(committed.filter(line => line.includes('FIRST MESSAGE'))).toHaveLength(1);
    expect(committed.findIndex(line => line.includes('MODEL'))).toBe(22);
  });

  it('keeps actual live frames below terminal height and never reprints committed history during streaming', async () => {
    const messages: Message[] = Array.from({ length: 50 }, (_, i) => ({ id: String(i), role: 'user', content: `HISTORY ${i}`, timestamp: i }));
    const { stdout, instance } = mount(surface(messages), false);
    await settle();
    const start = stdout.frames.length;
    for (let i = 0; i < 4; i++) {
      instance.rerender(surface(messages, { stream: 'stream '.repeat(400 + i) }));
      await settle();
    }
    const updates = stdout.frames.slice(start).join('');
    expect(updates).not.toContain('\x1b[2J');
    expect(updates).not.toContain('\x1b[3J');
    expect(updates).not.toContain('HISTORY 0');
    expect(updates).toContain('MODEL');
    instance.rerender(surface(messages, { rows: 14, columns: 50, stream: 'stream '.repeat(500) }));
    await settle();
    expect(stdout.frames.slice(start).map(strip).join('')).not.toMatch(/MODEL[^\n]*stream/);
  });

  it('keeps long drafts and modal controls within a small resized viewport', async () => {
    const { stdout, instance } = mount(surface([], { draft: 'draft\n'.repeat(100) }));
    await settle();
    instance.rerender(surface([], { rows: 12, columns: 40, draft: 'draft\n'.repeat(100) }));
    await settle();
    const small = strip(stdout.frames.findLast(frame => strip(frame).trim().length > 0)!).split('\n');
    expect(small.findIndex(line => line.includes('MODEL'))).toBe(10);
    instance.rerender(surface([], { rows: 12, columns: 40,
      footer: <Box flexDirection="column"><Text>{'Modal\n'.repeat(6)}</Text><Text>APPROVE / CANCEL</Text></Box> }));
    await settle();
    const modal = strip(stdout.frames.findLast(frame => strip(frame).trim().length > 0)!).split('\n');
    expect(modal.findIndex(line => line.includes('APPROVE / CANCEL'))).toBe(10);
  });

  it('remeasures locally opened completion menus without moving the footer offscreen', async () => {
    const completionProvider = { getCompletions: async () => Array.from({ length: 20 }, (_, i) => ({
      value: `command${i}`, type: 'command', insertText: `/command${i}`,
    })) } as unknown as CompletionProvider;
    const { stdout, stdin } = mount(surface([], { rows: 14, columns: 50, footer:
      <Box flexDirection="column"><Text>READY</Text>
        <InputPrompt prominent onSubmit={() => {}} completionProvider={completionProvider}/>
        <Text>MODEL</Text>
      </Box> }));
    await settle();
    stdin.write('/co');
    await new Promise(resolve => setTimeout(resolve, 250));
    const opened = strip(stdout.frames.findLast(frame => strip(frame).trim().length > 0)!);
    expect(opened).toContain('command0');
    expect(opened.split('\n').findIndex(line => line.includes('MODEL'))).toBe(12);
    stdin.write('\u001b');
    await settle();
    const closed = strip(stdout.frames.findLast(frame => strip(frame).trim().length > 0)!);
    expect(closed).not.toContain('command0');
    expect(closed.split('\n').findIndex(line => line.includes('MODEL'))).toBe(12);
  });
});
