/**
 * Tests for TodoList rendered output
 *
 * Renders the component through Ink into a fake stdout and asserts on the
 * plain-text frame: row order, status glyphs, and that the checkbox column
 * lines up for every status (the in-progress arrow must not shift its row).
 */

import { describe, test, expect } from 'vitest';
import React from 'react';
import { EventEmitter } from 'events';
import { render } from 'ink';
import { TodoList } from '../TodoList.js';
import type { TodoItem } from '@services/TodoManager.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';

class FakeStdout extends EventEmitter {
  public frames: string[] = [];
  public columns = 60;
  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

/** Strip ANSI escape sequences so we can assert on visible columns */
const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;]*m/g, '');

function renderToLines(todos: TodoItem[]): string[] {
  const stdout = new FakeStdout();
  const instance = render(<TodoList todos={todos} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  instance.unmount();
  const lastFrame = stdout.frames[stdout.frames.length - 1] ?? '';
  return stripAnsi(lastFrame).split('\n').filter(line => line.trim() !== '');
}

const todo = (task: string, status: TodoItem['status']): TodoItem =>
  ({ task, status }) as TodoItem;

describe('TodoList', () => {
  test('renders one row per todo, in the given order', () => {
    const lines = renderToLines([
      todo('First task', 'completed'),
      todo('Second task', 'in_progress'),
      todo('Third task', 'pending'),
    ]);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('First task');
    expect(lines[1]).toContain('Second task');
    expect(lines[2]).toContain('Third task');
  });

  test('uses the correct glyph per status', () => {
    const lines = renderToLines([
      todo('Done', 'completed'),
      todo('Doing', 'in_progress'),
      todo('Later', 'pending'),
    ]);

    expect(lines[0]).toContain(UI_SYMBOLS.TODO.CHECKED);
    expect(lines[1]).toContain(UI_SYMBOLS.NAVIGATION.ARROW_RIGHT);
    expect(lines[1]).toContain(UI_SYMBOLS.TODO.UNCHECKED);
    expect(lines[2]).toContain(UI_SYMBOLS.TODO.UNCHECKED);
    expect(lines[2]).not.toContain(UI_SYMBOLS.NAVIGATION.ARROW_RIGHT);
  });

  test('checkbox column aligns across all statuses', () => {
    const lines = renderToLines([
      todo('Done', 'completed'),
      todo('Doing', 'in_progress'),
      todo('Later', 'pending'),
    ]);

    const checkboxColumns = lines.map(line => {
      const checked = line.indexOf(UI_SYMBOLS.TODO.CHECKED);
      return checked !== -1 ? checked : line.indexOf(UI_SYMBOLS.TODO.UNCHECKED);
    });

    expect(checkboxColumns.every(col => col === checkboxColumns[0])).toBe(true);
  });

  test('renders nothing for an empty list', () => {
    const lines = renderToLines([]);
    expect(lines).toHaveLength(0);
  });
});
