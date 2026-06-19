import { describe, expect, it } from 'vitest';
import { expandTabsAnsiAware, padAnsiToWidth, stripAnsi, truncateAnsiToWidth, visibleLength } from '../terminalText.js';

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
});
