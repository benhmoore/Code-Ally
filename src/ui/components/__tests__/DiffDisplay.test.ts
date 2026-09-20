/**
 * Tests for DiffDisplay helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  applySyntaxHighlightingToDiffLines,
  generateDiffLines,
  groupIntoHunks,
  pairDiffRows,
  resolveDiffLayout,
  resolveDiffSyntaxTheme,
  type DiffLine,
} from '../DiffDisplay.js';

describe('generateDiffLines', () => {
  it('generates additions and removals with line numbers', () => {
    const lines = generateDiffLines('const answer = 41;\n', 'const answer = 42;\nconst label = "ok";\n', 'answer.ts');

    const removed = lines.find(line => line.type === 'remove');
    const added = lines.filter(line => line.type === 'add');

    expect(removed).toMatchObject({
      type: 'remove',
      content: 'const answer = 41;',
      lineNumber: 1,
    });
    expect(added[0]).toMatchObject({
      type: 'add',
      content: 'const answer = 42;',
      newLineNumber: 1,
    });
    expect(added[1]).toMatchObject({
      type: 'add',
      content: 'const label = "ok";',
      newLineNumber: 2,
    });
  });

  it('honors the requested context line count', () => {
    const oldContent = ['one', 'two', 'three', 'four', 'five'].join('\n');
    const newContent = ['one', 'two', 'changed', 'four', 'five'].join('\n');

    const lines = generateDiffLines(oldContent, newContent, 'sample.txt', 0);

    expect(lines.filter(line => line.type === 'context')).toHaveLength(0);
    expect(lines.some(line => line.type === 'remove' && line.content === 'three')).toBe(true);
    expect(lines.some(line => line.type === 'add' && line.content === 'changed')).toBe(true);
  });
});

describe('groupIntoHunks', () => {
  it('keeps hunk headers attached to their hunk', () => {
    const lines = generateDiffLines('one\ntwo\n', 'one\nchanged\n', 'sample.txt');
    const hunks = groupIntoHunks(lines);

    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.header?.content).toMatch(/^@@ /);
    expect(hunks[0]?.lines.some(line => line.type === 'add')).toBe(true);
  });
});

describe('applySyntaxHighlightingToDiffLines', () => {
  it('adds highlighted content using old and new line numbers', () => {
    const oldContent = 'const oldValue = 1;\nconst stable = true;\n';
    const newContent = 'const newValue = 2;\nconst stable = true;\n';
    const lines = generateDiffLines(oldContent, newContent, 'sample.ts');

    const highlighted = applySyntaxHighlightingToDiffLines(lines, oldContent, newContent, 'sample.ts', {
      enabled: true,
      theme: 'monokai',
      maxBytes: 10_000,
    });

    const removed = highlighted.find(line => line.type === 'remove');
    const added = highlighted.find(line => line.type === 'add');
    const context = highlighted.find(line => line.type === 'context');

    expect(removed?.highlightedContent).toContain('oldValue');
    expect(added?.highlightedContent).toContain('newValue');
    expect(context?.highlightedContent).toContain('stable');
  });

  it('skips highlighting when disabled', () => {
    const lines = generateDiffLines('old\n', 'new\n', 'sample.py');

    expect(
      applySyntaxHighlightingToDiffLines(lines, 'old\n', 'new\n', 'sample.py', {
        enabled: false,
        theme: 'monokai',
        maxBytes: 10_000,
      })
    ).toBe(lines);
  });

  it('skips highlighting when content exceeds the byte budget', () => {
    const lines = generateDiffLines('old\n', 'new\n', 'sample.py');

    expect(
      applySyntaxHighlightingToDiffLines(lines, 'old\n', 'new\n', 'sample.py', {
        enabled: true,
        theme: 'monokai',
        maxBytes: 1,
      })
    ).toBe(lines);
  });
});

describe('resolveDiffSyntaxTheme', () => {
  it('maps built-in diff themes to syntax themes', () => {
    expect(resolveDiffSyntaxTheme('auto')).toBe('monokai');
    expect(resolveDiffSyntaxTheme('dark')).toBe('monokai');
    expect(resolveDiffSyntaxTheme('light')).toBe('github');
    expect(resolveDiffSyntaxTheme('minimal')).toBeUndefined();
  });

  it('passes custom themes through', () => {
    expect(resolveDiffSyntaxTheme('dracula')).toBe('dracula');
  });
});

describe('pairDiffRows', () => {
  const line = (type: DiffLine['type'], content: string, lineNumber?: number, newLineNumber?: number): DiffLine => ({ type, content, lineNumber, newLineNumber });

  it('faces each removed line with its replacement and keeps context on both sides', () => {
    const rows = pairDiffRows([
      line('context', 'a', 1, 1),
      line('remove', 'b', 2),
      line('remove', 'c', 3),
      line('add', 'B', undefined, 2),
      line('context', 'd', 4, 3),
    ]);

    expect(rows).toEqual([
      { left: line('context', 'a', 1, 1), right: line('context', 'a', 1, 1) },
      { left: line('remove', 'b', 2), right: line('add', 'B', undefined, 2) },
      { left: line('remove', 'c', 3), right: undefined },
      { left: line('context', 'd', 4, 3), right: line('context', 'd', 4, 3) },
    ]);
  });

  it('spans headers and meta lines across both columns', () => {
    const rows = pairDiffRows([line('meta', '\\ No newline at end of file'), line('add', 'x', undefined, 1)]);
    expect(rows[0]).toEqual({ full: line('meta', '\\ No newline at end of file') });
    expect(rows[1]).toEqual({ left: undefined, right: line('add', 'x', undefined, 1) });
  });
});

describe('resolveDiffLayout', () => {
  it('goes side by side only when auto has the width for it', () => {
    expect(resolveDiffLayout('auto', 119)).toBe('unified');
    expect(resolveDiffLayout('auto', 120)).toBe('side-by-side');
    expect(resolveDiffLayout(undefined, 200)).toBe('side-by-side');
  });

  it('honours an explicit layout at any width', () => {
    expect(resolveDiffLayout('unified', 200)).toBe('unified');
    expect(resolveDiffLayout('side-by-side', 60)).toBe('side-by-side');
  });
});
