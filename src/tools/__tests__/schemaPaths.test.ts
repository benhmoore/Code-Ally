import { describe, it, expect } from 'vitest';
import { collectLocalPaths } from '../schemaPaths.js';
import type { ParameterSchema } from '../../types/index.js';

const objectSchema = (properties: Record<string, ParameterSchema>) =>
  ({ type: 'object' as const, properties });

describe('collectLocalPaths', () => {
  it('collects a marked string parameter', () => {
    const schema = objectSchema({
      file_path: { type: 'string', format: 'local-path' },
      content: { type: 'string' },
    });
    expect(collectLocalPaths({ file_path: '/a/b.ts', content: '/not/a/path' }, schema)).toEqual([
      '/a/b.ts',
    ]);
  });

  it('ignores unmarked parameters even when they look like paths', () => {
    const schema = objectSchema({ pattern: { type: 'string' } });
    expect(collectLocalPaths({ pattern: '/etc/*' }, schema)).toEqual([]);
  });

  // Regression: marking the array while it also declares `items` must not be a
  // silent no-op. This shape is the common one, and failing to collect here
  // fails OPEN — the path would reach the filesystem unauthorized.
  it('collects entries of a marked array that also declares items', () => {
    const schema = objectSchema({
      file_paths: {
        type: 'array',
        format: 'local-path',
        items: { type: 'string' },
      },
    });
    expect(collectLocalPaths({ file_paths: ['/a.ts', '/b.ts'] }, schema)).toEqual([
      '/a.ts',
      '/b.ts',
    ]);
  });

  it('collects entries of a marked array with no items schema', () => {
    const schema = objectSchema({
      paths: { type: 'array', format: 'local-path' },
    });
    expect(collectLocalPaths({ paths: ['/a', '/b'] }, schema)).toEqual(['/a', '/b']);
  });

  it('collects entries when only items carry the mark', () => {
    const schema = objectSchema({
      paths: { type: 'array', items: { type: 'string', format: 'local-path' } },
    });
    expect(collectLocalPaths({ paths: ['/a', '/b'] }, schema)).toEqual(['/a', '/b']);
  });

  it('does not double-count when both the array and its items are marked', () => {
    const schema = objectSchema({
      paths: {
        type: 'array',
        format: 'local-path',
        items: { type: 'string', format: 'local-path' },
      },
    });
    expect(collectLocalPaths({ paths: ['/a'] }, schema)).toEqual(['/a', '/a']);
  });

  it('descends into nested object properties', () => {
    const schema = objectSchema({
      target: {
        type: 'object',
        properties: {
          dir: { type: 'string', format: 'local-path' },
          label: { type: 'string' },
        },
      },
    });
    expect(collectLocalPaths({ target: { dir: '/x', label: '/y' } }, schema)).toEqual(['/x']);
  });

  it('skips absent, blank, and non-string values', () => {
    const schema = objectSchema({
      a: { type: 'string', format: 'local-path' },
      b: { type: 'string', format: 'local-path' },
      c: { type: 'string', format: 'local-path' },
    });
    expect(collectLocalPaths({ b: '   ', c: 42 }, schema)).toEqual([]);
  });

  it('returns nothing when the tool declares no schema properties', () => {
    expect(collectLocalPaths({ anything: '/etc' }, objectSchema({}))).toEqual([]);
  });
});
