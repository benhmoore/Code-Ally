import React from 'react';
import { EventEmitter } from 'events';
import { render } from 'ink';
import { describe, expect, test } from 'vitest';
import { ProgressIndicator, SPINNER_FRAMES, type SpinnerType } from '../ProgressIndicator.js';

class FakeStdout extends EventEmitter {
  public frames: string[] = [];
  public columns = 40;
  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function renderFrame(type: SpinnerType = 'default', text?: string): string {
  const stdout = new FakeStdout();
  const instance = render(<ProgressIndicator type={type} text={text} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  instance.unmount();
  return stripAnsi(stdout.frames.findLast(frame => stripAnsi(frame).trim()) ?? '');
}

describe('ProgressIndicator', () => {
  test.each(Object.keys(SPINNER_FRAMES) as SpinnerType[])('renders a valid %s frame', type => {
    expect(SPINNER_FRAMES[type]).toContain(renderFrame(type).trim());
  });

  test('renders text beside the spinner on one row', () => {
    const frame = renderFrame('arc', 'Working');
    expect(frame).toContain('Working');
    expect(frame.split('\n')).toHaveLength(1);
  });

  test('every animated style has multiple frames', () => {
    for (const frames of Object.values(SPINNER_FRAMES)) {
      expect(frames.length).toBeGreaterThan(1);
    }
  });
});
