import React from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { expect, test, vi } from 'vitest';
import { ToolFormWizard } from '../ToolFormWizard.js';
import type { FormRequest } from '../../../types/index.js';

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  frames: string[] = [];
  write = (frame: string) => { this.frames.push(frame); return true; };
}
class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode = () => this;
  ref = () => this;
  unref = () => this;
}
test.each([80, 40])('single freeform question avoids duplicate labels at %i columns', async columns => {
  const stdout = new FakeStdout();
  stdout.columns = columns;
  const stdin = new FakeStdin();
  const request = { schema: { title: 'Fixture text', description: 'What label should I use?', fields: [{ name: 'Fixture text', label: 'Fixture text', description: 'What label should I use?', type: 'string', required: true }] } } as FormRequest;
  const view = render(<ToolFormWizard request={request} fieldIndex={0} values={{}} errors={{}} queueLength={1} onFieldIndexChange={vi.fn()} onValueChange={vi.fn()} onErrorChange={vi.fn()} onComplete={vi.fn()} onCancel={vi.fn()} />, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: stdout as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false });
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    const frame = stdout.frames.at(-1)!.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    expect(frame.match(/Fixture text/g)).toHaveLength(1);
    expect(frame.match(/What label should I use\?/g)).toHaveLength(1);
    expect(frame).not.toContain('(string)');
    if (columns === 40) expect(frame).toContain('enter next · tab move · esc cancel');
  } finally { view.unmount(); stdin.end(); }
});
