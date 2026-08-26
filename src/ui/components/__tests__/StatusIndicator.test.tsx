import React from 'react';
import { EventEmitter } from 'events';
import { render } from 'ink';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { StatusIndicator } from '../StatusIndicator.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ActivityEventType } from '@shared/index.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';

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

const BLINK_GLYPHS = UI_SYMBOLS.SPINNER.BLINK;
const ARC_GLYPHS = UI_SYMBOLS.SPINNER.ARC;
// The indicator sits at a fixed column (the row has one space of padding).
// Trimming would lose it entirely on the blink's blank frames, and matching
// anywhere in the row would be meaningless: '·' is also the row's separator.
const indicatorOf = (frame: string): string => frame.charAt(1);
// The blink's "off" frame is a blank, so a missing indicator would satisfy
// BLINK_GLYPHS on its own; pair it with proof the spinner is not there.
const expectBlinking = (frame: string): void => {
  expect(BLINK_GLYPHS).toContain(indicatorOf(frame));
  expect(ARC_GLYPHS).not.toContain(indicatorOf(frame));
};

/**
 * A request that has been sent but has produced nothing yet is a different state
 * from one that is streaming, and the row has to say so: prefill on a large
 * prompt can run for minutes behind an identical spinner, which reads as a hang.
 */
describe('StatusIndicator request phase', () => {
  let activityStream: ActivityStream;
  let stdout: FakeStdout;
  let instance: ReturnType<typeof render>;

  beforeEach(async () => {
    activityStream = new ActivityStream();
    ServiceRegistry.getInstance().registerInstance('activity_stream', activityStream);
    stdout = new FakeStdout();
    instance = render(<StatusIndicator isProcessing={true} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    // Let the component's subscribe effect run before any event is emitted.
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  afterEach(() => {
    instance.unmount();
  });

  // Ink renders the state change on its own schedule; one macrotask is not
  // always enough for the frame to be written.
  const lastFrame = async (): Promise<string> => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return stripAnsi(stdout.frames.at(-1) ?? '');
  };

  const emit = (type: ActivityEventType, data: Record<string, unknown>): void => {
    activityStream.emit({ id: `evt-${type}`, type, timestamp: Date.now(), data } as never);
  };

  test('blinks while the request is out with no output yet', async () => {
    emit(ActivityEventType.MODEL_REQUEST_START, {});

    expectBlinking(await lastFrame());
  });

  test('switches to the spinner once real output arrives', async () => {
    emit(ActivityEventType.MODEL_REQUEST_START, {});
    await lastFrame();

    emit(ActivityEventType.ASSISTANT_CHUNK, { chunk: 'Hello' });

    expect(ARC_GLYPHS).toContain(indicatorOf(await lastFrame()));
  });

  test('keeps blinking for synthetic status events that carry no output', async () => {
    emit(ActivityEventType.MODEL_REQUEST_START, {});
    // The "Thinking..." indicator is emitted by the agent itself, not the model.
    emit(ActivityEventType.THOUGHT_CHUNK, { text: 'Thinking...', thinking: true });

    expectBlinking(await lastFrame());
  });

  test('returns to waiting-for-output when transport starts a replacement attempt', async () => {
    emit(ActivityEventType.MODEL_REQUEST_START, {});
    emit(ActivityEventType.ASSISTANT_CHUNK, { chunk: 'abandoned' });
    expect(ARC_GLYPHS).toContain(indicatorOf(await lastFrame()));

    emit(ActivityEventType.MODEL_STREAM_RESET, { reason: 'Stream timeout', attempt: 1 });

    expectBlinking(await lastFrame());
  });

  test('stops blinking when the request settles without output', async () => {
    emit(ActivityEventType.MODEL_REQUEST_START, {});
    await lastFrame();

    emit(ActivityEventType.MODEL_REQUEST_END, {});

    expect(ARC_GLYPHS).toContain(indicatorOf(await lastFrame()));
  });
});
