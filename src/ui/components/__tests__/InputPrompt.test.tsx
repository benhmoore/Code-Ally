import React, { useState } from 'react';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { render } from 'ink';
import { describe, expect, test, vi } from 'vitest';
import { InputPrompt } from '../InputPrompt.js';
import type { CompletionProvider } from '../../../services/CompletionProvider.js';
import type { CommandHistory } from '../../../services/CommandHistory.js';
import type { Agent } from '../../../agent/Agent.js';

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
  test('preserves pasted prose containing an existing path as literal input', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const submitted: string[] = [];
    const instance = render(
      <InputPrompt onSubmit={value => { submitted.push(value); }} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );
    const message = `Build the project in ${process.cwd()} and verify it.`;

    stdin.write(message);
    await settle();
    stdin.write('\r');
    await settle();

    expect(submitted).toEqual([message]);
    instance.unmount();
  });

  test('retains explicit @ paths as the eager attachment contract', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const onSubmit = vi.fn();
    const instance = render(<InputPrompt onSubmit={onSubmit} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    const message = `Inspect @${process.cwd()}`;

    stdin.write(message);
    await settle();
    stdin.write('\r');
    await settle();

    expect(onSubmit).toHaveBeenCalledWith(message, { directories: [process.cwd()] });
    instance.unmount();
  });

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

  test('enter submits when the selected suggestion is already fully typed', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const submitted: string[] = [];
    const completionProvider = {
      getCompletions: vi.fn(async (input: string) => {
        const match = input.match(/context_size=(\d*)$/);
        if (!match) return [];
        return ['32768'].filter(value => value.startsWith(match[1])).map(value => ({
          value,
          type: 'option' as const,
          insertText: `context_size=${value}`,
        }));
      }),
    } as unknown as CompletionProvider;
    const instance = render(
      <InputPrompt onSubmit={value => { submitted.push(value); }} completionProvider={completionProvider} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    stdin.write('/config set context_size=32768');
    await new Promise(resolve => setTimeout(resolve, 200));
    stdin.write('\r');
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(submitted).toEqual(['/config set context_size=32768']);
    instance.unmount();
  });

  test('keeps the suggestion surface mounted while refreshed results are pending', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const completionProvider = {
      getCompletions: vi.fn(async (input: string) => [{
        value: input === '/co' ? 'config' : 'clear',
        type: 'command' as const,
        insertText: input === '/co' ? '/config' : '/clear',
        replaceStart: 0,
        replaceEnd: input.length,
      }]),
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

    stdin.write('/c');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(stripAnsi(stdout.frames.at(-1) ?? '')).toContain('clear');

    stdin.write('o');
    await settle();

    const pendingFrame = stripAnsi(stdout.frames.at(-1) ?? '');
    expect(pendingFrame).toContain('clear');

    await new Promise(resolve => setTimeout(resolve, 200));
    const refreshedFrame = stripAnsi(stdout.frames.at(-1) ?? '');
    expect(refreshedFrame).toContain('config');
    instance.unmount();
  });

  test('refreshes a stale menu before accepting with Tab', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const onBufferChange = vi.fn();
    const completionProvider = {
      getCompletions: vi.fn(async (input: string) => [{
        value: input === '/co' ? 'config' : 'clear',
        type: 'command' as const,
        insertText: input === '/co' ? '/config' : '/clear',
        enterBehavior: 'submit' as const,
        replaceStart: 0,
        replaceEnd: input.length,
      }]),
    } as unknown as CompletionProvider;
    const instance = render(
      <InputPrompt
        onSubmit={() => {}}
        onBufferChange={onBufferChange}
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

    stdin.write('/c');
    await new Promise(resolve => setTimeout(resolve, 200));
    stdin.write('o');
    await settle();
    stdin.write('\t');
    await settle();

    expect(completionProvider.getCompletions).toHaveBeenLastCalledWith('/co', 3);
    expect(onBufferChange).toHaveBeenLastCalledWith('/config ');
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

  test('Tab accepts a suggestion without also inserting editor whitespace', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const onSubmit = vi.fn();
    const onBufferChange = vi.fn();
    const completionProvider = {
      getCompletions: vi.fn(async (input: string) => [{
        value: 'example',
        type: 'command' as const,
        insertText: '/example',
        enterBehavior: 'submit' as const,
        replaceStart: 0,
        replaceEnd: input.length,
      }]),
    } as unknown as CompletionProvider;
    const instance = render(
      <InputPrompt
        onSubmit={onSubmit}
        onBufferChange={onBufferChange}
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

    stdin.write('/ex');
    await new Promise(resolve => setTimeout(resolve, 200));
    stdin.write('\t');
    await settle();

    expect(onBufferChange).toHaveBeenLastCalledWith('/example ');
    expect(stripAnsi(stdout.frames.at(-1) ?? '')).toContain('/ /example');
    expect(onSubmit).not.toHaveBeenCalled();
    instance.unmount();
  });

  test('Enter accepts an argument suggestion without submitting the command', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const onSubmit = vi.fn();
    const onBufferChange = vi.fn();
    const completionProvider = {
      getCompletions: vi.fn(async (input: string) => [{
        value: 'model',
        type: 'option' as const,
        insertText: 'model=',
        replaceStart: '/config set '.length,
        replaceEnd: input.length,
        continueInput: true,
      }]),
    } as unknown as CompletionProvider;
    const instance = render(
      <InputPrompt
        onSubmit={onSubmit}
        onBufferChange={onBufferChange}
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

    stdin.write('/config set mo');
    await new Promise(resolve => setTimeout(resolve, 200));
    stdin.write('\r');
    await settle();

    expect(onBufferChange).toHaveBeenLastCalledWith('/config set model=');
    expect(stripAnsi(stdout.frames.at(-1) ?? '')).toContain('/ /config set model=');
    expect(onSubmit).not.toHaveBeenCalled();
    instance.unmount();
  });

  test('Enter runs a complete slash-command suggestion', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const onSubmit = vi.fn();
    const completionProvider = {
      getCompletions: vi.fn(async (input: string) => [{
        value: 'clear',
        type: 'command' as const,
        insertText: '/clear',
        enterBehavior: 'submit' as const,
        replaceStart: 0,
        replaceEnd: input.length,
      }]),
    } as unknown as CompletionProvider;
    const instance = render(
      <InputPrompt onSubmit={onSubmit} completionProvider={completionProvider} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    stdin.write('/cl');
    await new Promise(resolve => setTimeout(resolve, 200));
    stdin.write('\r');
    await settle();

    expect(onSubmit).toHaveBeenCalledWith('/clear', undefined);
    instance.unmount();
  });

  test('ignores stale async completion results after the buffer changes', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    let resolveFirst: ((value: Array<{ value: string; type: 'command' }>) => void) | undefined;
    const completionProvider = {
      getCompletions: vi.fn((input: string) => {
        if (input === '/a') {
          return new Promise<Array<{ value: string; type: 'command' }>>(resolve => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve([]);
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

    stdin.write('/a');
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(resolveFirst).toBeDefined();
    stdin.write('b');
    await settle();
    resolveFirst?.([{ value: 'agent', type: 'command' }]);
    await settle();

    expect(stripAnsi(stdout.frames.at(-1) ?? '')).not.toContain('suggestion');
    instance.unmount();
  });

  test('history restores the draft even when the recalled command has completions', async () => {
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

    stdin.write('draft');
    await settle();
    stdin.write('\u001b[A');
    await new Promise(resolve => setTimeout(resolve, 200));
    stdin.write('\u001b[B');
    await settle();

    expect(getNext).toHaveBeenCalledWith(0);
    expect(stripAnsi(stdout.frames.at(-1) ?? '')).toContain('> draft');
    instance.unmount();
  });

  test('Escape dismisses suggestions without interrupting on the same keypress', async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const interrupt = vi.fn();
    const agent = {
      isProcessing: () => true,
      interrupt,
    } as unknown as Agent;
    const completionProvider = {
      getCompletions: vi.fn(async () => [{ value: 'config', type: 'command' as const }]),
    } as unknown as CompletionProvider;
    const instance = render(
      <InputPrompt onSubmit={() => {}} completionProvider={completionProvider} agent={agent} />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );

    stdin.write('/co');
    await new Promise(resolve => setTimeout(resolve, 200));
    stdin.write('\u001b');
    await settle();

    expect(interrupt).not.toHaveBeenCalled();
    expect(stripAnsi(stdout.frames.at(-1) ?? '')).not.toContain('suggestion');
    instance.unmount();
  });
});
