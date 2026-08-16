/**
 * Tests for atomicWriteFile - the single durable-write path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../atomicFile.js';

describe('atomicWriteFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-file-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('writes content to a new file', async () => {
    const file = path.join(dir, 'new.txt');
    await atomicWriteFile(file, 'hello');
    expect(await fs.readFile(file, 'utf-8')).toBe('hello');
  });

  it('replaces existing content', async () => {
    const file = path.join(dir, 'existing.txt');
    await fs.writeFile(file, 'old', 'utf-8');
    await atomicWriteFile(file, 'new');
    expect(await fs.readFile(file, 'utf-8')).toBe('new');
  });

  it('leaves no temp files behind on success', async () => {
    const file = path.join(dir, 'clean.txt');
    await atomicWriteFile(file, 'data');
    expect(await fs.readdir(dir)).toEqual(['clean.txt']);
  });

  it('applies the mode option to a newly created file', async () => {
    const file = path.join(dir, 'secret.json');
    await atomicWriteFile(file, '{"token":"abc"}', { mode: 0o600 });

    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(file, 'utf-8')).toBe('{"token":"abc"}');
  });

  it('honors an explicit mode even when the target already exists with a looser mode', async () => {
    const file = path.join(dir, 'tighten.json');
    await fs.writeFile(file, 'old', { encoding: 'utf-8', mode: 0o644 });

    await atomicWriteFile(file, 'new', { mode: 0o600 });

    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('preserves the existing file mode when no mode option is given', async () => {
    const file = path.join(dir, 'preserved.txt');
    await fs.writeFile(file, 'old', 'utf-8');
    await fs.chmod(file, 0o640);

    await atomicWriteFile(file, 'new');

    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o640);
  });

  it('defaults to 0o600 for a brand-new file with no mode option', async () => {
    const file = path.join(dir, 'defaulted.txt');
    await atomicWriteFile(file, 'data');

    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('propagates errors and leaves no temp file when the directory does not exist', async () => {
    const file = path.join(dir, 'missing-subdir', 'file.txt');
    await expect(atomicWriteFile(file, 'data')).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
