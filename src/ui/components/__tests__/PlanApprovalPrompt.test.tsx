import React from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { expect, it } from 'vitest';
import { PlanApprovalPrompt } from '../PlanApprovalPrompt.js';
class Stdout extends EventEmitter {
  columns = 50;
  rows = 24;
  frames: string[] = [];
  write = (frame: string) => { this.frames.push(frame); return true; };
}
class Stdin extends PassThrough {
  isTTY = true;
  setRawMode = () => this;
  ref = () => this;
  unref = () => this;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

it('allows the complete plan to be reviewed, including wrapped lines beyond the initial viewport', async () => {
  const stdout = new Stdout();
  const stdin = new Stdin();
  const request = { planFilePath: '/tmp/plan.txt', planContent: Array.from({ length: 50 }, (_, i) => `Step ${i + 1}: ${'details '.repeat(9)}`).join('\n') };
  const instance = render(<PlanApprovalPrompt request={request} selectedIndex={0} feedbackText="" onFeedbackTextChange={() => {}} cursorPosition={0} onCursorChange={() => {}} />, {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  try {
    await settle();
    expect(stdout.frames.at(-1)).toContain('Step 1:');
    expect(stdout.frames.at(-1)).not.toContain('Step 50:');
    stdin.write('\x1b[6~');
    await settle();
    expect(stdout.frames.at(-1)).not.toContain('Step 1:');
    stdin.write('\x05');
    await settle();
    expect(stdout.frames.at(-1)).toContain('Step 50:');
    stdin.write('\x01');
    await settle();
    expect(stdout.frames.at(-1)).toContain('Step 1:');
  } finally { instance.unmount(); }
});
