import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallState } from '@shared/index.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { TerminalInputStream } from '@utils/terminalInput.js';
import { MOUSE_TRACKING_ENABLE } from '@utils/terminal.js';
import { ActivityProvider } from '../../contexts/ActivityContext.js';
import { PointerProvider } from '../../contexts/PointerContext.js';
import { ToolCallDisplay } from '../ToolCallDisplay.js';

class FakeStdout extends EventEmitter {
  public readonly frames: string[] = [];
  columns = 100;
  rows = 30;
  isTTY = true;
  write = (frame: string): boolean => { this.frames.push(frame); return true; };
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  setEncoding = (): this => this;
  setRawMode = (): this => this;
  ref = (): this => this;
  unref = (): this => this;
}

const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

const quietRead = (overrides: Partial<ToolCallState> = {}): ToolCallState => ({
  id: 'read-1',
  status: 'success',
  toolName: 'read',
  arguments: { description: 'Read config' },
  output: 'line one of the file\nline two of the file',
  hideOutput: true,
  startTime: 1,
  endTime: 2,
  ...overrides,
});

const mount = (element: React.ReactElement) => {
  const stdout = new FakeStdout();
  const instance = render(element, { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  mounted.push(instance);
  return stdout;
};

describe('ToolCallDisplay expansion', () => {
  it('keeps quiet output hidden until the call is opened', async () => {
    const closed = mount(
      <ActivityProvider activityStream={new ActivityStream()}>
        <ToolCallDisplay toolCall={quietRead()} />
      </ActivityProvider>
    );
    await vi.waitFor(() => expect(closed.frames.at(-1)).toContain('Read config'));
    expect(closed.frames.at(-1)).not.toContain('line one of the file');

    const open = mount(
      <ActivityProvider activityStream={new ActivityStream()}>
        <ToolCallDisplay toolCall={quietRead({ expanded: true })} />
      </ActivityProvider>
    );
    await vi.waitFor(() => expect(open.frames.at(-1)).toContain('line one of the file'));
  });

  it('toggles the call when its header row is clicked', async () => {
    const source = new FakeStdin();
    const input = new TerminalInputStream(source as unknown as NodeJS.ReadStream);
    const written: string[] = [];
    const onToggle = vi.fn();

    mount(
      <PointerProvider input={input} tracking write={(sequence) => { written.push(sequence); }} terminalRows={() => 30}>
        <ActivityProvider activityStream={new ActivityStream()}>
          <ToolCallDisplay toolCall={quietRead()} onToggle={onToggle} />
        </ActivityProvider>
      </PointerProvider>
    );
    await vi.waitFor(() => expect(written).toContain(MOUSE_TRACKING_ENABLE));

    // The row is the region's first line; the cursor rests below a 1-line region on row 21.
    source.emit('data', '\x1b[<0;4;20M');
    await vi.waitFor(() => expect(written).toContain('\x1b[6n'));
    source.emit('data', '\x1b[21;1R');

    await vi.waitFor(() => expect(onToggle).toHaveBeenCalledWith('read-1'));
  });
});
