/** Lossless text boundary shared by prepared editors and permission eligibility. */
export function assertTextEditContent(text: string): void {
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
export function decodeTextEditSource(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) throw new Error('Source is not valid UTF-8');
  assertTextEditContent(text);
  return text;
}
