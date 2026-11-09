import { describe, expect, it } from 'vitest';
import { decodeExactTextSource, replaceExactText } from '../exactTextReplacement.js';

describe('logical-newline exact replacement', () => {
  it('matches LF arguments against CRLF source and preserves the source style', () => {
    const result = replaceExactText('prefix\r\nalpha\r\nbeta\r\nsuffix\r\n', 'alpha\nbeta', 'ALPHA\nBETA');
    expect(result.content).toBe('prefix\r\nALPHA\r\nBETA\r\nsuffix\r\n');
    expect(result.start).toBe(8);
    expect(result.end).toBe(19);
  });
  it('matches CRLF arguments against LF source without changing the file style', () => {
    expect(replaceExactText('a\nb\n', 'a\r\nb', 'A\r\nB').content).toBe('A\nB\n');
  });
  it('uses matched-region style and preserves every outside byte in mixed-EOL files', () => {
    const source = 'before\nstart\r\nend\nafter\r\n';
    expect(replaceExactText(source, 'start\nend', 'one\ntwo\nthree').content).toBe(
      'before\none\r\ntwo\r\nthree\nafter\r\n'
    );
    expect(replaceExactText(source, 'end', 'one\ntwo').content).toBe('before\nstart\r\none\ntwo\nafter\r\n');
  });
  it('uses LF when neither match nor file contains a newline', () => {
    expect(replaceExactText('target', 'target', 'a\nb').content).toBe('a\nb');
  });
  it.each([
    ['a\nb--a\r\nb', 'a\nb'],
    ['aaa', 'aa'],
    ['a\na\r\na', 'a\na'],
  ])('rejects ambiguous logical matches including overlaps', (source, old) => {
    expect(() => replaceExactText(source, old, 'new')).toThrow('multiple locations');
  });
  it('does not equate Unicode normalization, whitespace, or lone carriage returns', () => {
    for (const old of ['café', ' café', 'café\n'])
      expect(() => replaceExactText('café\r', old, 'new')).toThrow('not found');
    expect(() => replaceExactText('a  b', 'a b', 'new')).toThrow('not found');
  });
  it('locates a multiline edit late in a large mixed-EOL Unicode document without disturbing its boundaries', () => {
    const prefix = 'entry café 🦊\r\nsecondary 東京\n'.repeat(20000);
    const suffix = '\nuntouched Ω\r\n'.repeat(10000);
    const target = 'unique first\r\nunique second';
    const result = replaceExactText(
      prefix + target + suffix,
      'unique first\nunique second',
      'updated first\nupdated second'
    );
    expect(result.start).toBe(prefix.length);
    expect(result.end).toBe(prefix.length + target.length);
    expect(result.content).toBe(prefix + 'updated first\r\nupdated second' + suffix);
  });
  it('rejects invalid UTF-8, binary NUL and invalid Unicode arguments', () => {
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('a\0b')])
      expect(() => decodeExactTextSource(bytes)).toThrow();
    for (const old of ['\ud800', '\udc00', 'a\0b']) expect(() => replaceExactText('source', old, 'new')).toThrow();
    expect(() => replaceExactText('source', 'source', '\ud800')).toThrow();
  });
  it('preserves a BOM and valid Unicode byte-for-byte and rejects logical no-ops', () => {
    const source = '\ufeffcafé 🦊\r\n';
    expect(decodeExactTextSource(Buffer.from(source))).toBe(source);
    expect(() => replaceExactText(source, 'café 🦊\n', 'café 🦊\r\n')).toThrow('no changes');
  });
});
