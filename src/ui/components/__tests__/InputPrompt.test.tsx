import React, { useState } from 'react';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { render } from 'ink';
import { describe, expect, test, vi } from 'vitest';
import { InputPrompt } from '../InputPrompt.js';

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
});
