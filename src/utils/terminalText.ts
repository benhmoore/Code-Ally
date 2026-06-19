/**
 * ANSI-aware helpers for terminal text layout.
 *
 * Ink and chalk strings can contain escape sequences that should not count
 * toward visible width. These helpers keep truncation and padding stable for
 * highlighted code and other styled terminal output.
 */

const ANSI_SEQUENCE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SEQUENCE_AT_START_PATTERN = /^\x1b\[[0-?]*[ -/]*[@-~]/;
const ANSI_RESET = '\x1b[0m';

/**
 * Remove ANSI escape sequences from a terminal string.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE_PATTERN, '');
}

/**
 * Expand tabs while preserving ANSI escape sequences.
 */
export function expandTabsAnsiAware(text: string, tabWidth: number = 4): string {
  let result = '';
  let column = 0;
  let index = 0;

  while (index < text.length) {
    const remaining = text.slice(index);
    const ansiMatch = remaining.match(ANSI_SEQUENCE_AT_START_PATTERN);

    if (ansiMatch?.[0]) {
      result += ansiMatch[0];
      index += ansiMatch[0].length;
      continue;
    }

    const char = readCodePoint(text, index);
    if (!char) {
      break;
    }

    if (char === '\t') {
      const spacesToAdd = tabWidth - (column % tabWidth);
      result += ' '.repeat(spacesToAdd);
      column += spacesToAdd;
    } else {
      result += char;
      column += getCharacterWidth(char);
    }

    index += char.length;
  }

  return result;
}

/**
 * Return display width for a terminal string, excluding ANSI sequences.
 */
export function visibleLength(text: string, tabWidth: number = 4): number {
  const expanded = expandTabsAnsiAware(text, tabWidth);
  let width = 0;

  for (const char of stripAnsi(expanded)) {
    width += getCharacterWidth(char);
  }

  return width;
}

/**
 * Pad a styled string to a visible width.
 */
export function padAnsiToWidth(text: string, width: number, tabWidth: number = 4): string {
  const expanded = expandTabsAnsiAware(text, tabWidth);
  const paddingNeeded = Math.max(0, width - visibleLength(expanded, tabWidth));
  return expanded + ' '.repeat(paddingNeeded);
}

/**
 * Truncate a styled string to a visible width without cutting ANSI sequences.
 */
export function truncateAnsiToWidth(text: string, width: number, ellipsis: string = '...'): string {
  if (width <= 0) {
    return '';
  }

  const expanded = expandTabsAnsiAware(text);
  if (visibleLength(expanded) <= width) {
    return expanded;
  }

  const ellipsisWidth = visibleLength(ellipsis);
  const contentWidth = Math.max(0, width - ellipsisWidth);
  let result = '';
  let usedWidth = 0;
  let index = 0;
  let sawAnsi = false;

  while (index < expanded.length && usedWidth < contentWidth) {
    const remaining = expanded.slice(index);
    const ansiMatch = remaining.match(ANSI_SEQUENCE_AT_START_PATTERN);

    if (ansiMatch?.[0]) {
      sawAnsi = true;
      result += ansiMatch[0];
      index += ansiMatch[0].length;
      continue;
    }

    const char = readCodePoint(expanded, index);
    if (!char) {
      break;
    }

    const charWidth = getCharacterWidth(char);
    if (usedWidth + charWidth > contentWidth) {
      break;
    }

    result += char;
    usedWidth += charWidth;
    index += char.length;
  }

  return result + ellipsis + (sawAnsi ? ANSI_RESET : '');
}

function getCharacterWidth(char: string): number {
  if (char === '\n' || char === '\r') {
    return 0;
  }

  if (/[\u0300-\u036f]/.test(char)) {
    return 0;
  }

  if (isWideCodePoint(char.codePointAt(0) ?? 0)) {
    return 2;
  }

  return 1;
}

function readCodePoint(text: string, index: number): string | undefined {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) {
    return undefined;
  }

  return String.fromCodePoint(codePoint);
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff))
  );
}
