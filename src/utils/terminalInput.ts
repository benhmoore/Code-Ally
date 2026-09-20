/**
 * Terminal input stream that separates terminal *reports* from keyboard input.
 *
 * With mouse tracking enabled, the terminal writes SGR mouse reports on stdin
 * (`ESC [ < Cb ; Cx ; Cy M` / `m`), and a cursor-position query is answered
 * there too (`ESC [ row ; col R`). Ink's key parser knows neither, so this
 * stream sits between the terminal and Ink: reports are taken out and
 * published as typed events, everything else passes through untouched.
 */

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { CURSOR_POSITION_REQUEST } from './terminal.js';

export type MouseButton = 'left' | 'middle' | 'right' | 'none';

export interface MouseEvent {
  kind: 'press' | 'release' | 'wheel';
  button: MouseButton;
  /** Direction for wheel events. */
  wheel?: 'up' | 'down';
  /** 1-based terminal column. */
  column: number;
  /** 1-based terminal row. */
  row: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface CursorPosition {
  /** 1-based terminal row. */
  row: number;
  /** 1-based terminal column. */
  column: number;
}

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const X10_MOUSE_PATTERN = /^\x1b\[M[\s\S]{3}/;
const CURSOR_REPORT_PATTERN = /^\x1b\[(\d+);(\d+)R/;
/** An ESC-prefixed tail that could still become one of the reports above. */
const PARTIAL_REPORT_PATTERN = /^\x1b(?:\[(?:<[\d;]*|M[\s\S]{0,2}|[\d;]*)?)?$/;
/** How long a partial sequence at a chunk boundary is held before it is passed on. */
const PARTIAL_FLUSH_MS = 30;

const BUTTON_MASK = 0b11;
const SHIFT_FLAG = 4;
const ALT_FLAG = 8;
const CTRL_FLAG = 16;
const WHEEL_FLAG = 64;

/** Decode one SGR mouse report. */
export function parseSgrMouseReport(sequence: string): MouseEvent | null {
  const match = SGR_MOUSE_PATTERN.exec(sequence);
  if (!match) {
    return null;
  }
  const code = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  const released = match[4] === 'm';
  const modifiers = { shift: (code & SHIFT_FLAG) !== 0, alt: (code & ALT_FLAG) !== 0, ctrl: (code & CTRL_FLAG) !== 0 };

  if (code & WHEEL_FLAG) {
    return { kind: 'wheel', button: 'none', wheel: (code & BUTTON_MASK) === 0 ? 'up' : 'down', column, row, ...modifiers };
  }
  const button = (['left', 'middle', 'right', 'none'] as const)[code & BUTTON_MASK] ?? 'none';
  return { kind: released ? 'release' : 'press', button, column, row, ...modifiers };
}

/** Decode a cursor position report. */
export function parseCursorReport(sequence: string): CursorPosition | null {
  const match = CURSOR_REPORT_PATTERN.exec(sequence);
  return match ? { row: Number(match[1]), column: Number(match[2]) } : null;
}

export interface TerminalInputEvents {
  mouse: [event: MouseEvent];
}

/**
 * Readable that Ink consumes in place of process.stdin.
 *
 * TTY-specific members Ink relies on (`isTTY`, `setRawMode`, `ref`, `unref`)
 * are forwarded to the underlying stream so raw mode still applies to the
 * real terminal.
 */
export class TerminalInputStream extends Readable {
  private readonly events = new EventEmitter<TerminalInputEvents>();
  private pending = '';
  private flushTimer: NodeJS.Timeout | undefined;
  private cursorReportWaiters: Array<(position: CursorPosition) => void> = [];

  constructor(private readonly source: NodeJS.ReadStream) {
    super();
    source.setEncoding('utf8');
    source.on('data', this.handleSourceData);
    source.on('end', () => this.push(null));
  }

  get isTTY(): boolean {
    return this.source.isTTY === true;
  }

  setRawMode(enabled: boolean): this {
    this.source.setRawMode?.(enabled);
    return this;
  }

  ref(): this {
    this.source.ref?.();
    return this;
  }

  unref(): this {
    this.source.unref?.();
    return this;
  }

  override _read(): void {
    // Data is pushed as the terminal delivers it; nothing to pull.
  }

  onMouse(listener: (event: MouseEvent) => void): () => void {
    this.events.on('mouse', listener);
    return () => this.events.off('mouse', listener);
  }

  /**
   * Ask the terminal where its cursor is. Resolves with the report, or
   * rejects when the terminal does not answer within `timeoutMs`.
   */
  requestCursorPosition(write: (sequence: string) => void, timeoutMs = 250): Promise<CursorPosition> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cursorReportWaiters = this.cursorReportWaiters.filter((waiter) => waiter !== settle);
        reject(new Error('Terminal did not report its cursor position'));
      }, timeoutMs);
      const settle = (position: CursorPosition) => {
        clearTimeout(timer);
        resolve(position);
      };
      this.cursorReportWaiters.push(settle);
      write(CURSOR_POSITION_REQUEST);
    });
  }

  private readonly handleSourceData = (chunk: string | Buffer): void => {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.consume(this.pending + chunk.toString());
  };

  /** Split `text` into reports (published) and key input (pushed downstream). */
  private consume(text: string): void {
    let passthrough = '';
    let index = 0;

    while (index < text.length) {
      const escape = text.indexOf('\x1b', index);
      if (escape < 0) {
        passthrough += text.slice(index);
        break;
      }
      passthrough += text.slice(index, escape);
      const rest = text.slice(escape);

      const sgr = SGR_MOUSE_PATTERN.exec(rest);
      if (sgr) {
        const event = parseSgrMouseReport(sgr[0]);
        if (event) this.events.emit('mouse', event);
        index = escape + sgr[0].length;
        continue;
      }
      const x10 = X10_MOUSE_PATTERN.exec(rest);
      if (x10) {
        // Legacy encoding only arrives from terminals without SGR support;
        // it carries no usable coordinates beyond 223 columns, so drop it.
        index = escape + x10[0].length;
        continue;
      }
      const cursor = this.cursorReportWaiters.length > 0 ? CURSOR_REPORT_PATTERN.exec(rest) : null;
      if (cursor) {
        const waiter = this.cursorReportWaiters.shift();
        waiter?.(parseCursorReport(cursor[0])!);
        index = escape + cursor[0].length;
        continue;
      }
      if (PARTIAL_REPORT_PATTERN.test(rest)) {
        // The chunk ended inside what may be a report: wait for the rest.
        this.pending = rest;
        this.flushTimer = setTimeout(() => {
          this.flushTimer = undefined;
          const held = this.pending;
          this.pending = '';
          if (held) this.push(held);
        }, PARTIAL_FLUSH_MS);
        if (passthrough) this.push(passthrough);
        return;
      }

      // Any other escape sequence is keyboard input for Ink.
      passthrough += '\x1b';
      index = escape + 1;
    }

    this.pending = '';
    if (passthrough) this.push(passthrough);
  }
}
