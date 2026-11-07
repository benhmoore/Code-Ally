import React from 'react';
import { PassThrough } from 'node:stream';
import { Text, render } from 'ink';
import { describe, expect, it } from 'vitest';
import { TerminalProvider } from '../../contexts/TerminalContext.js';
import { useTerminalWidth } from '../../hooks/useTerminalWidth.js';
import { useTerminalRows } from '../../hooks/useTerminalRows.js';

class Output extends PassThrough {
  columns = 61;
  rows = 17;
  isTTY = true;
  frames = '';
  constructor() {
    super();
    this.on('data', chunk => { this.frames += String(chunk); });
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 60));
function Dimensions() {
  return <Text>{useTerminalWidth()}x{useTerminalRows()}</Text>;
}

describe('terminal measurements', () => {
  it('shares one subscription across provider and fallback consumers on the configured Ink output', async () => {
    const stdout = new Output();
    const instance = render(<><Dimensions/><TerminalProvider>{Array.from({ length: 20 }, (_, index) => <Dimensions key={index}/>)}</TerminalProvider></>, {
      stdout, stdin: new PassThrough(), debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await settle();
      // Ink owns one listener; provider and fallback consumers share the other.
      expect(stdout.listenerCount('resize')).toBe(2);
      expect(stdout.frames).toContain('61x17');
      stdout.columns = 49;
      stdout.rows = 12;
      stdout.emit('resize');
      await settle();
      expect(stdout.frames).toContain('49x12');
    } finally { instance.unmount(); }
    expect(stdout.listenerCount('resize')).toBe(0);
  });

  it('shares out-of-provider measurements and releases their subscription', async () => {
    const stdout = new Output();
    const instance = render(<>{Array.from({ length: 20 }, (_, index) => <Dimensions key={index}/>)}</>, {
      stdout, stdin: new PassThrough(), debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await settle();
      expect(stdout.listenerCount('resize')).toBe(2);
      stdout.columns = 35;
      stdout.rows = 9;
      stdout.emit('resize');
      await settle();
      expect(stdout.frames).toContain('35x9');
    } finally { instance.unmount(); }
    expect(stdout.listenerCount('resize')).toBe(0);
    stdout.columns = 27;
    const remounted = render(<Dimensions/>, {
      stdout, stdin: new PassThrough(), debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    try {
      await settle();
      expect(stdout.frames).toContain('27x9');
      expect(stdout.listenerCount('resize')).toBe(2);
    } finally { remounted.unmount(); }
    expect(stdout.listenerCount('resize')).toBe(0);
  });
});
