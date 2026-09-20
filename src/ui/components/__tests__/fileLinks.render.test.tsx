import React from 'react';
import { EventEmitter } from 'events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallState } from '@shared/index.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ActivityProvider } from '../../contexts/ActivityContext.js';
import { DiffDisplay } from '../DiffDisplay.js';
import { ToolCallDisplay } from '../ToolCallDisplay.js';

class FakeStdout extends EventEmitter {
  public readonly frames: string[] = [];
  public columns = 100;
  public rows = 30;
  public isTTY = true;

  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
  vi.unstubAllEnvs();
});

const renderToFrames = async (element: React.ReactElement): Promise<string> => {
  const stdout = new FakeStdout();
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  mounted.push(instance);
  await vi.waitFor(() => expect(stdout.frames.length).toBeGreaterThan(0));
  return stdout.frames.at(-1) ?? '';
};

const readCall: ToolCallState = {
  id: 'read-1',
  status: 'success',
  toolName: 'read',
  // Mirrors ReadTool.formatSubtext, which names the file inside the subtext.
  arguments: { file_path: '/tmp/project/src/index.ts', description: 'Read entry point (index.ts - 12 lines)' },
  startTime: 1,
  endTime: 2,
};

describe('file links in the conversation', () => {
  it('links the file name in a tool row when hyperlinks are enabled', async () => {
    vi.stubEnv('FORCE_HYPERLINK', '1');
    const frame = await renderToFrames(
      <ActivityProvider activityStream={new ActivityStream()}>
        <ToolCallDisplay toolCall={readCall} config={{ enable_terminal_hyperlinks: true }} />
      </ActivityProvider>
    );

    expect(frame).toContain('\x1b]8;;file:///tmp/project/src/index.ts\x1b\\');
  });

  it('keeps tool rows plain when the preference is off', async () => {
    vi.stubEnv('FORCE_HYPERLINK', '1');
    const frame = await renderToFrames(
      <ActivityProvider activityStream={new ActivityStream()}>
        <ToolCallDisplay toolCall={readCall} config={{ enable_terminal_hyperlinks: false }} />
      </ActivityProvider>
    );

    expect(frame).not.toContain('\x1b]8;;');
    expect(frame).toContain('Read entry point (index.ts - 12 lines)');
  });

  it('links the diff header path', async () => {
    const frame = await renderToFrames(
      <DiffDisplay oldContent="a\n" newContent="b\n" filePath="/tmp/project/src/index.ts" hyperlinks />
    );

    expect(frame).toContain('\x1b]8;;file:///tmp/project/src/index.ts\x1b\\');
  });
});
