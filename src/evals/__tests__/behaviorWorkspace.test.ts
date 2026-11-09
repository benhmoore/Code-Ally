import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseTool } from '../../tools/BaseTool.js';
import { assertFixturePath, confineFixtureTools } from '../behaviorWorkspace.js';

describe('behavior fixture path confinement', () => {
  let root: string;
  let workspace: string;
  let outside: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'behavior-workspace-test-')));
    workspace = join(root, 'workspace');
    outside = join(root, 'outside');
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await writeFile(join(workspace, 'inside.txt'), 'inside');
    await writeFile(join(outside, 'secret.txt'), 'outside');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const tool = (name: string) => ({
    name,
    execute: vi.fn(async () => ({ success: true })),
    validateBeforePermission: vi.fn(async () => undefined),
  });
  it('allows existing and future nested paths inside the real workspace', async () => {
    await expect(assertFixturePath(workspace, 'inside.txt')).resolves.toBeUndefined();
    await expect(assertFixturePath(workspace, 'new/deep/file.txt')).resolves.toBeUndefined();
    await expect(assertFixturePath(workspace, workspace)).resolves.toBeUndefined();
  });
  it('rejects lexical escapes and sibling directories sharing the workspace prefix', async () => {
    for (const path of ['../outside/secret.txt', join(outside, 'secret.txt'), `${workspace}-other/file.txt`]) {
      await expect(assertFixturePath(workspace, path)).rejects.toThrow('outside');
    }
  });
  it('rejects existing symlink targets and future paths beneath an outside symlink', async () => {
    await symlink(outside, join(workspace, 'escape'), 'dir');
    await expect(assertFixturePath(workspace, 'escape/secret.txt')).rejects.toThrow('outside');
    await expect(assertFixturePath(workspace, 'escape/new/deep/file.txt')).rejects.toThrow('outside');
    await symlink(join(workspace, 'inside.txt'), join(workspace, 'allowed'));
    await expect(assertFixturePath(workspace, 'allowed')).resolves.toBeUndefined();
  });
  it('guards execution and prepermission validation before invoking underlying tools', async () => {
    const read = tool('read');
    const execute = read.execute;
    const validate = read.validateBeforePermission;
    confineFixtureTools([read as unknown as BaseTool], workspace);
    await expect(read.execute({ file_path: '../outside/secret.txt' })).rejects.toThrow('outside');
    await expect(read.validateBeforePermission({ paths: ['inside.txt', '../outside/secret.txt'] })).rejects.toThrow(
      'outside'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    await read.execute({ file_path: 'inside.txt' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('blocks escaped glob patterns and symlinked glob prefixes', async () => {
    const glob = tool('glob');
    confineFixtureTools([glob as unknown as BaseTool], workspace);
    await symlink(outside, join(workspace, 'escape'), 'dir');
    for (const patterns of [['../outside/*.txt'], [join(outside, '**/*.txt')], ['escape/**/*.txt']]) {
      await expect(glob.execute({ patterns })).rejects.toThrow('outside');
    }
    await expect(glob.execute({ patterns: ['**/*.txt', 'src/*.js'] })).resolves.toEqual({ success: true });
  });
  it('retains wrappers when the same tool instances are reused by a child', async () => {
    const read = tool('read');
    const delegate = tool('agent');
    const instances = [read, delegate];
    confineFixtureTools(instances as unknown as BaseTool[], workspace);
    const childTools = instances.filter(instance => instance.name === 'read');
    await expect(childTools[0]!.execute({ path: '../outside/secret.txt' })).rejects.toThrow('outside');
    await expect(delegate.execute({ context_files: ['../outside/secret.txt'] })).rejects.toThrow('outside');
    await expect(delegate.execute({ working_dir: outside })).rejects.toThrow('outside');
    await expect(childTools[0]!.execute({ path: 'inside.txt' })).resolves.toEqual({ success: true });
  });
});
