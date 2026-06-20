import { describe, expect, it } from 'vitest';
import { expandTabsAnsiAware, padAnsiToWidth, stripAnsi, truncateAnsiToWidth, visibleLength, wrapAnsiText } from '../terminalText.js';

describe('terminalText', () => {
  it('strips ANSI escape sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[39m plain')).toBe('red plain');
  });

  it('calculates visible length without ANSI sequences', () => {
    expect(visibleLength('\x1b[32mconst\x1b[39m value')).toBe(11);
  });

  it('expands tabs while preserving ANSI sequences', () => {
    expect(expandTabsAnsiAware('a\t\x1b[31mb\x1b[39m')).toBe('a   \x1b[31mb\x1b[39m');
  });

  it('pads styled strings to a visible width', () => {
    const padded = padAnsiToWidth('\x1b[32mok\x1b[39m', 5);

    expect(stripAnsi(padded)).toBe('ok   ');
    expect(visibleLength(padded)).toBe(5);
  });

  it('truncates without cutting ANSI sequences', () => {
    const truncated = truncateAnsiToWidth('\x1b[32mconst value\x1b[39m', 8);

    expect(stripAnsi(truncated)).toBe('const...');
    expect(visibleLength(truncated)).toBe(8);
    expect(truncated).toContain('\x1b[0m');
  });

  it('counts wide characters as two columns', () => {
    expect(visibleLength('世界')).toBe(4);
  });

  describe('wrapAnsiText', () => {
    it('wraps at word boundaries, never mid-word', () => {
      expect(wrapAnsiText('hello world foo', 8)).toEqual(['hello', 'world', 'foo']);
      expect(wrapAnsiText('hello world foo', 11)).toEqual(['hello world', 'foo']);
    });

    it('keeps every visual line within the target width', () => {
      const lines = wrapAnsiText('the quick brown fox jumps over the lazy dog', 12);
      for (const line of lines) {
        expect(visibleLength(line)).toBeLessThanOrEqual(12);
      }
    });

    it('hard-breaks words longer than the full width', () => {
      expect(wrapAnsiText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    });

    it('preserves blank lines between hard line breaks', () => {
      expect(wrapAnsiText('a\n\nb', 10)).toEqual(['a', '', 'b']);
    });

    it('ignores ANSI sequences when measuring width', () => {
      const wrapped = wrapAnsiText('\x1b[31mhello\x1b[39m world', 5);
      expect(wrapped.map(stripAnsi)).toEqual(['hello', 'world']);
    });

    it('treats wide characters as two columns', () => {
      expect(wrapAnsiText('世界ab', 4)).toEqual(['世界', 'ab']);
    });

    it('preserve mode keeps all characters (concatenation invariant)', () => {
      const input = 'the quick brown fox jumps over';
      for (const width of [4, 7, 10, 15]) {
        const wrapped = wrapAnsiText(input, width, { preserveWhitespace: true });
        expect(wrapped.join('')).toBe(input);
        for (const line of wrapped) {
          expect(visibleLength(line)).toBeLessThanOrEqual(width);
        }
      }
    });

    it('preserve mode keeps a trailing space addressable', () => {
      expect(wrapAnsiText('ab ', 2, { preserveWhitespace: true })).toEqual(['ab', ' ']);
    });

    it('returns the input split on newlines for non-positive width', () => {
      expect(wrapAnsiText('a\nb', 0)).toEqual(['a', 'b']);
    });

    it('does not expand tabs when expandTabs is false', () => {
      expect(wrapAnsiText('a\tb', 10, { expandTabs: false })).toEqual(['a\tb']);
    });
  });
});
