import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { TerminalInputStream, parseCursorReport, parseSgrMouseReport } from '../terminalInput.js';

class FakeStdin extends EventEmitter {
  isTTY = true;
  raw: boolean | undefined;
  setEncoding = vi.fn();
  setRawMode = vi.fn((enabled: boolean) => { this.raw = enabled; return this; });
  ref = vi.fn();
  unref = vi.fn();
}

const collect = (stream: TerminalInputStream): string[] => {
  const chunks: string[] = [];
  stream.on('data', (chunk: string | Buffer) => chunks.push(chunk.toString()));
  return chunks;
};

const flushed = () => new Promise((resolve) => setImmediate(resolve));

describe('parseSgrMouseReport', () => {
  it('decodes presses, releases, buttons and modifiers', () => {
    expect(parseSgrMouseReport('\x1b[<0;12;5M')).toEqual({ kind: 'press', button: 'left', column: 12, row: 5, shift: false, alt: false, ctrl: false });
    expect(parseSgrMouseReport('\x1b[<0;12;5m')).toMatchObject({ kind: 'release', button: 'left' });
    expect(parseSgrMouseReport('\x1b[<2;1;1M')).toMatchObject({ button: 'right' });
    expect(parseSgrMouseReport('\x1b[<20;1;1M')).toMatchObject({ button: 'left', shift: true, ctrl: true });
  });

  it('decodes wheel direction', () => {
    expect(parseSgrMouseReport('\x1b[<64;3;4M')).toMatchObject({ kind: 'wheel', wheel: 'up', column: 3, row: 4 });
    expect(parseSgrMouseReport('\x1b[<65;3;4M')).toMatchObject({ kind: 'wheel', wheel: 'down' });
  });
});

describe('parseCursorReport', () => {
  it('decodes the device status report', () => {
    expect(parseCursorReport('\x1b[24;80R')).toEqual({ row: 24, column: 80 });
    expect(parseCursorReport('\x1b[24;80~')).toBeNull();
  });
});

describe('TerminalInputStream', () => {
  it('publishes mouse reports and passes keys through untouched', async () => {
    const source = new FakeStdin();
    const stream = new TerminalInputStream(source as unknown as NodeJS.ReadStream);
    const chunks = collect(stream);
    const mouse = vi.fn();
    stream.onMouse(mouse);

    source.emit('data', 'ab\x1b[<0;7;3M\x1b[Ac');
    await flushed();

    expect(mouse).toHaveBeenCalledWith(expect.objectContaining({ kind: 'press', column: 7, row: 3 }));
    expect(chunks.join('')).toBe('ab\x1b[Ac');
  });

  it('reassembles a report split across chunks', async () => {
    const source = new FakeStdin();
    const stream = new TerminalInputStream(source as unknown as NodeJS.ReadStream);
    const chunks = collect(stream);
    const mouse = vi.fn();
    stream.onMouse(mouse);

    source.emit('data', 'x\x1b[<0;1');
    source.emit('data', '0;2My');
    await flushed();

    expect(mouse).toHaveBeenCalledWith(expect.objectContaining({ column: 10, row: 2 }));
    expect(chunks.join('')).toBe('xy');
  });

  it('releases a held escape that never became a report', async () => {
    vi.useFakeTimers();
    try {
      const source = new FakeStdin();
      const stream = new TerminalInputStream(source as unknown as NodeJS.ReadStream);
      const chunks = collect(stream);

      source.emit('data', '\x1b');
      vi.advanceTimersByTime(40);
      await vi.runAllTimersAsync();

      expect(chunks.join('')).toBe('\x1b');
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers a cursor position request and only then treats CSI R as a report', async () => {
    const source = new FakeStdin();
    const stream = new TerminalInputStream(source as unknown as NodeJS.ReadStream);
    const chunks = collect(stream);
    const write = vi.fn();

    source.emit('data', '\x1b[1;2R');
    await flushed();
    expect(chunks.join('')).toBe('\x1b[1;2R');

    const position = stream.requestCursorPosition(write);
    expect(write).toHaveBeenCalledWith('\x1b[6n');
    source.emit('data', '\x1b[30;1R');
    await expect(position).resolves.toEqual({ row: 30, column: 1 });
  });

  it('rejects an unanswered cursor position request', async () => {
    vi.useFakeTimers();
    try {
      const source = new FakeStdin();
      const stream = new TerminalInputStream(source as unknown as NodeJS.ReadStream);
      const position = stream.requestCursorPosition(() => {}, 50);
      vi.advanceTimersByTime(60);
      await expect(position).rejects.toThrow('cursor position');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards TTY members to the real terminal', () => {
    const source = new FakeStdin();
    const stream = new TerminalInputStream(source as unknown as NodeJS.ReadStream);

    expect(stream.isTTY).toBe(true);
    stream.setRawMode(true);
    expect(source.setRawMode).toHaveBeenCalledWith(true);
    stream.ref();
    stream.unref();
    expect(source.ref).toHaveBeenCalled();
    expect(source.unref).toHaveBeenCalled();
  });
});
