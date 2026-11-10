import { describe, expect, it } from 'vitest';
import { prepareExactTextEdit } from '../exactTextEdit.js';

describe('exact replacement line evidence', () => {
  it.each([
    ['alpha\nbeta\ngamma\n', 'beta', 'BETA', 2, 2, 2, 2],
    ['alpha\nbeta\ngamma\n', 'beta', 'BETA\ninserted', 2, 2, 2, 3],
    ['alpha\nbeta\ngamma\n', 'beta\n', 'BETA\n', 2, 2, 2, 2],
    ['alpha\nbeta\ngamma\n', 'beta\n', 'BETA', 2, 3, 3, 2],
    ['alpha\nbeta\n', 'beta\n', 'BETA', 2, 2, 3, 2],
    ['alpha\nbeta\n', 'beta\n', '', 2, 2, 3, 2],
    ['alpha\nbeta', 'beta', '', 2, 2, 2, 2],
    ['alpha\r\nbeta\ngamma\r\n', 'beta\ngamma', 'B\nG', 2, 3, 3, 3],
  ])('maps %j / %j -> %j', (source, oldText, newText, start, readEnd, oldEnd, newEnd) => {
    const result = prepareExactTextEdit(source, oldText, newText);
    expect(result.readRanges).toEqual([{ start, end: readEnd }]);
    expect(result.editRanges).toEqual([{ oldStart: start, oldEnd, newStart: start, newEnd }]);
  });
  it('requires observation of the empty source line and maps a multiline initialization', () => {
    const result = prepareExactTextEdit('', '', 'first\nsecond\n');
    expect(result.readRanges).toEqual([{ start: 1, end: 1 }]);
    expect(result.editRanges).toEqual([{ oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 3 }]);
    expect(result.content).toBe('first\nsecond\n');
  });
  it('supports insertion boundaries without requiring a numeric diff anchor', () => {
    const result = prepareExactTextEdit('{\n  value\n}', '{', '{\n  inserted,');
    expect(result.content).toBe('{\n  inserted,\n  value\n}');
    expect(result.readRanges).toEqual([{ start: 1, end: 1 }]);
    expect(result.editRanges).toEqual([{ oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 2 }]);
  });
  it('never broadens matches beyond LF/CRLF equivalence', () => {
    expect(() => prepareExactTextEdit('café\r\n', 'café\n', 'new')).toThrow('not found');
    expect(() => prepareExactTextEdit('  value\n', ' value ', 'new')).toThrow('not found');
  });
});
