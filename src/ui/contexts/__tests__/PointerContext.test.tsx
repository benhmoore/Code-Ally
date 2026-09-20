import React from 'react';
import { EventEmitter } from 'node:events';
import { Box, Text, render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalInputStream } from '@utils/terminalInput.js';
import { MOUSE_TRACKING_DISABLE, MOUSE_TRACKING_ENABLE } from '@utils/terminal.js';
import { PointerProvider } from '../PointerContext.js';
import { Clickable } from '../../components/Clickable.js';

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 30;
  isTTY = true;
  write = (): boolean => true;
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

/**
 * A three-line live region: a heading, then two clickable rows. With the
 * cursor reported on row 13, the region occupies rows 10-12.
 */
function mountRegion(tracking = true) {
  const source = new FakeStdin();
  const input = new TerminalInputStream(source as unknown as NodeJS.ReadStream);
  const written: string[] = [];
  const write = (sequence: string) => { written.push(sequence); };
  const first = vi.fn();
  const second = vi.fn();

  const instance = render(
    <PointerProvider input={input} tracking={tracking} write={write} terminalRows={() => 30}>
      <Box flexDirection="column">
        <Text>Choose</Text>
        <Clickable onPress={first}><Text>first option</Text></Clickable>
        <Clickable onPress={second}><Text>second option</Text></Clickable>
      </Box>
    </PointerProvider>,
    { stdout: new FakeStdout() as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false }
  );
  mounted.push(instance);

  // The terminal only reports clicks once tracking is on, so a click waits
  // for the enable sequence, then answers the cursor query with row 13.
  const click = async (row: number, column: number) => {
    await vi.waitFor(() => expect(written).toContain(MOUSE_TRACKING_ENABLE));
    const queries = written.filter((sequence) => sequence === '\x1b[6n').length;
    source.emit('data', `\x1b[<0;${column};${row}M`);
    await vi.waitFor(() => expect(written.filter((sequence) => sequence === '\x1b[6n').length).toBe(queries + 1));
    source.emit('data', '\x1b[13;1R');
  };

  return { written, first, second, click, source };
}

describe('PointerProvider', () => {
  it('turns tracking on while active and off again afterwards', async () => {
    const { written } = mountRegion();
    await vi.waitFor(() => expect(written).toContain(MOUSE_TRACKING_ENABLE));

    mounted.pop()!.unmount();
    expect(written.at(-1)).toBe(MOUSE_TRACKING_DISABLE);
  });

  it('activates the row under a click, resolved against the reported cursor', async () => {
    const { first, second, click } = mountRegion();

    await click(11, 3);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(second).not.toHaveBeenCalled();

    await click(12, 1);
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
  });

  it('ignores clicks outside every target and buttons other than the left one', async () => {
    const { first, second, click, source, written } = mountRegion();

    await click(10, 1);
    source.emit('data', '\x1b[<2;3;11M');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(written.filter((sequence) => sequence === '\x1b[6n')).toHaveLength(1);
  });

  it('never asks for the cursor when tracking is off', async () => {
    const { written, source } = mountRegion(false);
    source.emit('data', '\x1b[<0;3;11M');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(written).not.toContain(MOUSE_TRACKING_ENABLE);
    expect(written).not.toContain('\x1b[6n');
  });
});
