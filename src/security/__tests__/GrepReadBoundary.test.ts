import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyAutoAction } from '../AutoActionPolicy.js';
import { authorizeAutoGrepRead } from '../GrepReadBoundary.js';
import { GrepTool } from '../../tools/GrepTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';

let directory: string;
let root: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ally-auto-grep-')));
  root = path.join(directory, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'normal.txt'), 'needle ordinary\n');
  for (const name of ['.env', 'credentials.json', 'private.key']) {
    await writeFile(path.join(root, name), 'needle protected\n');
  }
  for (const name of ['.aws', '.ally-sessions']) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, 'history.txt'), 'needle protected\n');
  }
  await writeFile(path.join(directory, 'outside.txt'), 'needle outside\n');
  await symlink(path.join(directory, 'outside.txt'), path.join(root, 'alias.txt'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function approve(args: Record<string, unknown>) {
  const decision = await classifyAutoAction({ toolName: 'grep', args, workspaceRoot: root });
  expect(decision.kind).toBe('allow');
  expect(decision.grepRead).toBeDefined();
  authorizeAutoGrepRead(args, decision.grepRead!);
}

describe('Auto grep execution boundary', () => {
  it('enforces protected exclusions after user globs and ignores execution-capable ripgrep config', async () => {
    const marker = path.join(directory, 'executed');
    const hook = path.join(directory, 'hook');
    await writeFile(hook, `#!/bin/sh\nprintf called > '${marker}'\n/bin/cat "$1"\n`);
    await chmod(hook, 0o755);
    const config = path.join(directory, 'rg-config');
    await writeFile(config, `--pre=${hook}\n--hidden\n`);
    vi.stubEnv('RIPGREP_CONFIG_PATH', config);
    const args = { pattern: 'needle', path: root, glob: '*', output_mode: 'content' };
    await approve(args);
    const result = await new GrepTool(new ActivityStream()).execute(args);
    expect(result.success).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('ordinary');
    expect(serialized).not.toContain('protected');
    expect(serialized).not.toContain('needle outside');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses changed arguments without falling back to an unrestricted search', async () => {
    const args = { pattern: 'needle', path: root, glob: '*' };
    await approve(args);
    args.path = directory;
    const result = await new GrepTool(new ActivityStream()).execute(args);
    expect(result.error_type).toBe('policy_denied');
  });

  it('refuses a target symlink that leaves the workspace after approval', async () => {
    const alias = path.join(root, 'selected.txt');
    await symlink(path.join(root, 'normal.txt'), alias);
    const args = { pattern: 'needle', path: alias };
    await approve(args);
    await unlink(alias);
    await symlink(path.join(directory, 'outside.txt'), alias);
    const result = await new GrepTool(new ActivityStream()).execute(args);
    expect(result.error_type).toBe('policy_denied');
  });
});
