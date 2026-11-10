/** Exact text replacement with LF/CRLF treated as the same logical newline. */
export interface ExactTextReplacement {
  content: string;
  /** Offsets in the original UTF-16 string, before replacement. */
  start: number;
  end: number;
  newline: '\n' | '\r\n';
}

function validateText(text: string): void {
  if (text.includes('\0')) throw new Error('NUL-containing binary text cannot be edited');
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Text contains an invalid Unicode surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Text contains an invalid Unicode surrogate');
  }
}

/** Decode without silently replacing invalid bytes or removing a UTF-8 BOM. */
export function decodeExactTextSource(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) throw new Error('Source is not valid UTF-8');
  validateText(text);
  return text;
}

/**
 * Empty oldText names the sole insertion point only when source is empty.
 * Only newline encoding is equivalent: no trimming, Unicode normalization, or fuzzy matching.
 * Inserted newlines use the first newline in the matched region, otherwise the first
 * file newline, otherwise LF. Bytes outside the matched raw slice remain untouched.
 */
export function replaceExactText(source: string, oldText: string, newText: string): ExactTextReplacement {
  for (const text of [source, oldText, newText]) validateText(text);
  if (!oldText.length && source.length) throw new Error('Empty old_text is allowed only for an empty file');
  const normalized = source.replace(/\r\n/g, '\n');
  const needle = oldText.replace(/\r\n/g, '\n');
  const index = normalized.indexOf(needle);
  if (index < 0) throw new Error('old_text was not found exactly; re-read the target');
  if (needle.length && normalized.indexOf(needle, index + 1) >= 0)
    throw new Error('old_text matches multiple locations; include unique surrounding text');
  let start = index;
  let end = index + needle.length;
  if (normalized.length !== source.length) {
    // Map just the two match boundaries; avoid per-code-unit offset tables.
    let rawPosition = 0;
    let logicalPosition = 0;
    const logicalEnd = end;
    while (logicalPosition < logicalEnd) {
      if (logicalPosition === index) start = rawPosition;
      rawPosition += source[rawPosition] === '\r' && source[rawPosition + 1] === '\n' ? 2 : 1;
      logicalPosition++;
    }
    end = rawPosition;
  }
  const region = source.slice(start, end);
  const newline = (region.match(/\r\n|\n/)?.[0] ?? source.match(/\r\n|\n/)?.[0] ?? '\n') as '\n' | '\r\n';
  const replacement = newText.replace(/\r\n/g, '\n').replace(/\n/g, newline);
  const content = source.slice(0, start) + replacement + source.slice(end);
  if (content === source) throw new Error('Replacement makes no changes');
  return { content, start, end, newline };
}
