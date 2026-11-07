import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUGGY_SOURCE, createCodingFixture, verifyCodingFixture } from '../localCodingFixture.js';

describe('independent coding smoke verification', () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ally-coding-fixture-test-'));
    await createCodingFixture(workspace);
  });
  afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

  it('resolves the real worker import graph from a fixture cwd without calling a model', async () => {
    const worker = fileURLToPath(new URL('../localCodingRunner.ts', import.meta.url));
    const execute = promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), worker], {
      cwd: workspace,
      env: {
        ...process.env,
        ALLY_DATA_DIR: join(workspace, 'data'),
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      },
      timeout: 10_000,
    });
    await expect(execute).rejects.toThrow('Coding worker requires an isolated workspace');
  });

  it('accepts the real worker environment through a symlinked fixture path', async () => {
    const childDirectory = join(workspace, 'child');
    const alias = join(workspace, 'alias');
    const data = join(workspace, 'data');
    await Promise.all([mkdir(childDirectory), mkdir(data)]);
    await symlink(childDirectory, alias, 'dir');
    const result = await promisify(execFile)(process.execPath, [
      '--import', import.meta.resolve('tsx'),
      fileURLToPath(new URL('../localCodingRunner.ts', import.meta.url)), '--check-environment',
    ], {
      cwd: alias,
      env: {
        ...process.env,
        ALLY_CODING_WORKSPACE: alias,
        ALLY_DATA_DIR: data,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      },
      timeout: 10_000,
    });
    expect(result.stdout).toContain('Worker environment ready.');
  });

  it('rejects the initial buggy source', async () => {
    const result = await verifyCodingFixture(workspace);
    expect(result.sourceChanged).toBe(false);
    expect(result.testsUnchanged).toBe(true);
    expect(result.independentTestsPassed).toBe(false);
  });

  it('accepts the inclusive repair including reversed and negative ranges', async () => {
    await writeFile(join(workspace, 'range.js'), BUGGY_SOURCE.replace('end - start;', 'end - start + 1;'));
    const result = await verifyCodingFixture(workspace);
    expect(result.sourceChanged).toBe(true);
    expect(result.testsUnchanged).toBe(true);
    expect(result.independentTestsPassed).toBe(true);
  });

  it('detects test tampering and independently rejects a hardcoded public-test answer', async () => {
    await writeFile(join(workspace, 'range.js'), 'export function rangeSize() { return 3; }\n');
    await writeFile(join(workspace, 'range.test.js'), '// removed failing test\n');
    const result = await verifyCodingFixture(workspace);
    expect(result.testsUnchanged).toBe(false);
    expect(result.independentTestsPassed).toBe(false);
  });
});
