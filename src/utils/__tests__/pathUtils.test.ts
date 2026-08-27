import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectFilesAndImages } from '../pathUtils.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; file: string; directory: string; spacedFile: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ally-path-paste-'));
  temporaryDirectories.push(root);
  const file = join(root, 'workflow.json');
  const directory = join(root, 'tasks');
  const spacedFile = join(root, 'workflow notes.md');
  await mkdir(directory);
  await writeFile(file, '{}\n');
  await writeFile(spacedFile, '# Notes\n');
  return { root, file, directory, spacedFile };
}

describe('detectFilesAndImages', () => {
  it('classifies a paste containing only valid paths', async () => {
    const { file, directory, spacedFile } = await fixture();

    expect(detectFilesAndImages(`${file} "${spacedFile}" ${directory}`)).toEqual({
      directories: [directory],
      images: [],
      files: [file, spacedFile],
    });
  });

  it('does not extract an existing path from prose', async () => {
    const { directory } = await fixture();
    const prose = `Build the project in ${directory} and verify every requirement.`;

    expect(detectFilesAndImages(prose)).toEqual({ directories: [], images: [], files: [] });
  });

  it('does not partially consume a mixed valid and invalid path list', async () => {
    const { file } = await fixture();

    expect(detectFilesAndImages(`${file} ./missing.json`)).toEqual({ directories: [], images: [], files: [] });
  });

  it('does not consume an unterminated quoted path', async () => {
    const { spacedFile } = await fixture();

    expect(detectFilesAndImages(`"${spacedFile}`)).toEqual({ directories: [], images: [], files: [] });
  });
});
