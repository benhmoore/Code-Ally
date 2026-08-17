import React, { useState } from 'react';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { render } from 'ink';
import { describe, expect, test, vi } from 'vitest';
import { InputPrompt } from '../InputPrompt.js';
import type { CompletionProvider } from '../../../services/CompletionProvider.js';
import type { CommandHistory } from '../../../services/CommandHistory.js';

class FakeStdout extends EventEmitter {
  public frames: string[] = [];
  public columns = 80;
  public rows = 24;
  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

class FakeStdin extends PassThrough {
  public isTTY = true;
  setRawMode = (): this => this;
  ref = (): this => this;
  unref = (): this => this;
}

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

const ControlledPrompt: React.FC = () => {
  const [buffer, setBuffer] = useState('');
  return (
    <InputPrompt
      onSubmit={() => {}}
      bufferValue={buffer}
      onBufferChange={setBuffer}
    />
  );
};

describe('InputPrompt controlled buffer', () => {
  test('typing advances the local and preserved buffers without an update loop', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const instance = render(<ControlledPrompt />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    await settle();
    stdin.write('a');
    await settle();

    const frame = stdout.frames.map(stripAnsi).findLast(value => value.includes('a')) ?? '';
    expect(frame).toContain('> a');
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('Maximum update depth exceeded');

    instance.unmount();
    consoleError.mockRestore();
  });

  test('completion navigation owns vertical arrows without moving the cursor', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const calls: Array<{ input: string; cursor: number }> = [];
    const completionProvider = {
      getCompletions: vi.fn(async (input: string, cursor: number) => {
        calls.push({ input, cursor });
        return [
          { value: 'model', type: 'option' as const },
          { value: 'reasoning_effort', type: 'option' as const },
        ];
      }),
    } as unknown as CompletionProvider;
    const instance = render(
      <InputPrompt onSubmit={() => {}} completionProvider={completionProvider} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    stdin.write('/config set ');
    await new Promise(resolve => setTimeout(resolve, 200));
    calls.length = 0;
    stdin.write('\u001b[A');
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(calls.every(call => call.cursor === '/config set '.length)).toBe(true);
    instance.unmount();
  });

  test('history mode keeps Down assigned to newer history even at cursor start', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const getPrevious = vi.fn(() => ({ command: '/config set ', index: 0 }));
    const getNext = vi.fn(() => null);
    const commandHistory = {
      getPrevious,
      getNext,
      addCommand: vi.fn(),
      save: vi.fn(async () => {}),
    } as unknown as CommandHistory;
    const completionProvider = {
      getCompletions: vi.fn(async () => [{ value: 'model', type: 'option' as const }]),
    } as unknown as CompletionProvider;
    const instance = render(
      <InputPrompt
        onSubmit={() => {}}
        commandHistory={commandHistory}
        completionProvider={completionProvider}
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    await settle();
    stdin.write('\u001b[A');
    await settle();
    stdin.write('\u001b[B');
    await settle();

    expect(getPrevious).toHaveBeenCalledOnce();
    expect(getNext).toHaveBeenCalledWith(0);
    instance.unmount();
  });
});
