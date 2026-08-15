import React from 'react';
import { EventEmitter } from 'events';
import { render } from 'ink';
import { describe, expect, test } from 'vitest';
import { StatusIndicator } from '../StatusIndicator.js';

class FakeStdout extends EventEmitter {
  public frames: string[] = [];
  public columns = 80;
  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function renderFrames(isProcessing: boolean): string[] {
  const stdout = new FakeStdout();
  const instance = render(<StatusIndicator isProcessing={isProcessing} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  instance.unmount();
  return stdout.frames.map(stripAnsi).filter(frame => frame.trim());
}

describe('StatusIndicator layout invariant', () => {
  test('idle state consumes no terminal row', () => {
    expect(renderFrames(false)).toHaveLength(0);
  });

  test('active state is one concise row', () => {
    const frame = renderFrames(true).at(-1) ?? '';
    expect(frame.split('\n')).toHaveLength(1);
    expect(frame).toContain('Thinking');
    expect(frame).toContain('esc interrupt');
  });
});
