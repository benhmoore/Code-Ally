import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planReadCommand, assessReadCommand, authorizeAutoReadCommand, consumeAutoReadCommand, spawnReadCommand } from '../ReadCommandPlan.js';
import { BashTool } from '../../tools/BashTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import * as bashProcess from '../../utils/bashProcess.js';
import { waitForBashClose } from '../../utils/bashProcess.js';

let directory: string;
let root: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ally-read-execution-')));
  root = path.join(directory, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'file with spaces.txt'), 'normal content\n');
  await writeFile(path.join(directory, 'outside.txt'), 'outside secret');
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('Auto read execution boundary', () => {
  it('executes repository instruction and configuration reads without applying write restrictions', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'Project instructions\n');
    await writeFile(path.join(root, '.env'), 'EXAMPLE=fixture\n');
    const args = { command: 'cat AGENTS.md && cat .env', working_dir: root };
    const plan = await planReadCommand(args.command, root, root);
    expect(plan).not.toBeNull();
    authorizeAutoReadCommand(args, plan!);
    const result = await new BashTool(new ActivityStream()).execute(args);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Project instructions');
    expect(result.content).toContain('EXAMPLE=fixture');
  });

  it('executes pinned argv without a shell despite a hostile PATH or shell startup file', async () => {
    const marker = path.join(root, 'executed');
    const malicious = `#!/bin/sh\nprintf called > '${marker}'\n`;
    await writeFile(path.join(root, 'cat'), malicious);
    await chmod(path.join(root, 'cat'), 0o755);
    await writeFile(path.join(root, 'startup.sh'), malicious);
    vi.stubEnv('PATH', `${root}:${process.env.PATH}`);
    vi.stubEnv('BASH_ENV', path.join(root, 'startup.sh'));
    const fallback = vi.spyOn(bashProcess, 'spawnBashCommand');
    const args = { command: "cat 'file with spaces.txt'", working_dir: root };
    const plan = await planReadCommand(args.command, root, root);
    expect(plan).not.toBeNull();
    authorizeAutoReadCommand(args, plan!);
    const result = await new BashTool(new ActivityStream()).execute(args);
    expect(result.success).toBe(true);
    expect(result.content).toBe('normal content\n');
    expect(fallback).not.toHaveBeenCalled();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects changed arguments instead of falling back to Bash', async () => {
    const args = { command: "cat 'file with spaces.txt'", working_dir: root };
    const plan = (await planReadCommand(args.command, root, root))!;
    authorizeAutoReadCommand(args, plan);
    args.command = 'printf changed';
    const fallback = vi.spyOn(bashProcess, 'spawnBashCommand');
    const result = await new BashTool(new ActivityStream()).execute(args);
    expect(result.error_type).toBe('policy_denied');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('revalidates symlink targets and the full argument binding at execution', async () => {
    const alias = path.join(root, 'alias');
    await symlink(path.join(root, 'file with spaces.txt'), alias);
    const args = { command: 'cat alias', working_dir: root, timeout: 10 };
    authorizeAutoReadCommand(args, (await planReadCommand(args.command, root, root))!);
    await unlink(alias);
    await symlink(path.join(directory, 'outside.txt'), alias);
    expect((await consumeAutoReadCommand(args, root)).kind).toBe('rejected');
    const clean = { command: "cat 'file with spaces.txt'", working_dir: root, timeout: 10 };
    authorizeAutoReadCommand(clean, (await planReadCommand(clean.command, root, root))!);
    clean.timeout = 20;
    expect((await consumeAutoReadCommand(clean, root)).kind).toBe('rejected');
  });

  it('consumes each admission once and refuses out-of-workspace execution directories', async () => {
    const args = { command: 'pwd' };
    authorizeAutoReadCommand(args, (await planReadCommand(args.command, root, root))!);
    expect((await consumeAutoReadCommand(args, directory)).kind).toBe('rejected');
    expect((await consumeAutoReadCommand(args, root)).kind).toBe('none');
  });
});

// Exercise real Git and the fixed runner, not a parsed-plan approximation.
describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('literal read-only chains', () => {
  async function run(command: string) {
    const args = { command, working_dir: root };
    const plan = await planReadCommand(command, root, root);
    expect(plan, command).not.toBeNull();
    authorizeAutoReadCommand(args, plan!);
    return new BashTool(new ActivityStream()).execute(args);
  }

  async function git(...argv: string[]) {
    return new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...argv], {
        cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
  }

  async function repository() {
    await git('init');
    await git('add', '.');
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture initial commit');
    await git('remote', 'add', 'origin', 'https://example.invalid/fixture.git');
  }

  it('runs the screenshot chain with canonical cd, labels, metadata and remotes in order', async () => {
    await repository();
    const fallback = vi.spyOn(bashProcess, 'spawnBashCommand');
    const result = await run(`cd '${root}' && ls -la && echo "---GIT---" && git log --oneline -10 2>/dev/null && echo "---REMOTE---" && git remote -v 2>/dev/null`);
    expect(result.success).toBe(true);
    expect(result.content).toContain('file with spaces.txt');
    expect(result.content).toContain('---GIT---\n');
    expect(result.content).toContain('fixture initial commit\n---REMOTE---\n');
    expect(result.content).toContain('https://example.invalid/fixture.git');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('keeps cd state local to subsequent steps and applies && fail-stop with stderr discard', async () => {
    await mkdir(path.join(root, 'child'));
    const directories = await run('pwd && cd child && pwd && echo "last label"');
    expect(directories.content).toBe(`${root}\n${path.join(root, 'child')}\nlast label\n`);
    await git('init');
    const failed = await run('echo before && git log --oneline -10 2>/dev/null && echo AFTER');
    expect(failed.success).toBe(false);
    expect(failed.content).toBe('before\n');
    expect(failed.stderr).toBe('');
    expect((await run('git log --oneline -1')).stderr).not.toBe('');
  });

  it('does not execute hostile Git config, global includes, pager, helpers, hooks or loader settings', async () => {
    await repository();
    const marker = path.join(directory, 'git-executed');
    const hook = path.join(directory, 'git-hook');
    await writeFile(hook, `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`);
    await chmod(hook, 0o755);
    for (const key of ['core.fsmonitor', 'core.pager', 'gpg.program', 'diff.external', 'diff.custom.textconv', 'core.sshCommand', 'core.alternateRefsCommand']) {
      await git('config', key, hook);
    }
    await git('config', 'log.showSignature', 'true');
    await git('config', 'pager.log', 'true');
    await writeFile(path.join(root, '.git', 'hooks', 'post-index-change'), await readFile(hook));
    await chmod(path.join(root, '.git', 'hooks', 'post-index-change'), 0o755);
    const global = path.join(directory, 'global-config');
    await writeFile(global, `[include]\n path = ${path.join(directory, 'missing-config')}\n[core]\n pager = ${hook}\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    vi.stubEnv('GIT_CONFIG_SYSTEM', global);
    vi.stubEnv('GIT_PAGER', hook);
    vi.stubEnv('GIT_SSH_COMMAND', hook);
    vi.stubEnv('GIT_EXTERNAL_DIFF', hook);
    vi.stubEnv('GIT_EXEC_PATH', directory);
    vi.stubEnv('NODE_OPTIONS', `--require=${hook}`);
    const result = await run('echo "git" && git log --oneline -10 && git remote -v');
    expect(result.success).toBe(true);
    expect(result.content).toContain('fixture initial commit');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    'ls && echo okay > result', 'ls || echo okay', 'ls & echo okay', 'ls &&', '&& ls',
    'ls && echo $(pwd)', 'ls && echo `pwd`', 'ls && echo $PATH', 'ls && cd .. && ls',
    'ls && git -c core.pager=evil log --oneline -10', 'git log --oneline -10000',
    'git log --oneline -10 2>result', 'git log --oneline -10 2>&1', 'git log --oneline -10 >/dev/null',
    'git log --oneline -10 2>/dev/null; echo okay', 'echo -e evil', 'cd - && ls',
    'git status --ignored', 'git status --ignore-submodules=all', 'git status -C /tmp',
    'git branch new-branch', 'git branch --delete main', 'git branch --set-upstream-to=origin/main',
    'git remote set-url origin https://example.invalid', 'git remote update', 'git fetch',
    'git diff --stat HEAD', 'git diff --name-only --output=changed',
    'git log --format=%G? -1', 'git log --show-signature -1', 'git log -1 -2',
  ])('refuses unsupported source completely: %s', async command => {
    expect(await planReadCommand(command, root, root)).toBeNull();
  });

  it.each([
    'git status', 'git status --short --branch', 'git status --branch --short', 'git status -sb',
    'git status --porcelain', 'git status --porcelain=v2 -uno', 'git status --untracked-files=all --short',
    'git log -n 2 --oneline', 'git log --oneline --max-count=2', 'git log --max-count 2 --oneline',
    'git log --graph --all --oneline -2', 'git remote --verbose', 'git remote',
    'git branch', 'git branch --list --all', 'git branch --show-current', 'git branch -a -vv',
    'git diff', 'git diff --patch', 'git diff --cached', 'git diff --stat', 'git diff --name-status --cached', 'git diff --staged --name-only',
  ])('supports validated read-only Git option families: %s', async command => {
    await repository();
    const result = await run(command);
    expect(result.success, JSON.stringify(result)).toBe(true);
  });

  it('preserves full commit messages for plain log without trusting custom pretty formats', async () => {
    await repository();
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'subject line', '-m', 'body paragraph');
    await git('config', 'format.pretty', '%G?');
    const plain = await run('git log -n 1');
    expect(plain.success).toBe(true);
    expect(plain.content).toContain('Author: Fixture <fixture@example.invalid>');
    expect(plain.content).toMatch(/ {4}subject line\n[ \t]*\n {4}body paragraph/);
    const oneline = await run('git log -1 --oneline');
    expect(oneline.content).toContain('subject line');
    expect(oneline.content).not.toContain('body paragraph');
  });

  it('status reports tracked/untracked changes without updating the index or invoking helpers', async () => {
    await repository();
    const marker = path.join(directory, 'status-helper-ran');
    const hook = path.join(directory, 'status-hook');
    await writeFile(hook, `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`);
    await chmod(hook, 0o755);
    await git('config', 'core.fsmonitor', hook);
    await git('config', 'core.untrackedCache', 'true');
    await git('config', 'core.splitIndex', 'true');
    await git('config', 'core.pager', hook);
    const index = path.join(root, '.git', 'index');
    const before = await readFile(index);
    const beforeStat = await stat(index);
    await writeFile(path.join(root, 'file with spaces.txt'), 'changed content\n');
    await writeFile(path.join(root, 'untracked.txt'), 'new content\n');
    const result = await run('git status --short --branch');
    expect(result.success).toBe(true);
    expect(result.content).toContain('file with spaces.txt');
    expect(result.content).toContain('?? untracked.txt');
    expect(await readFile(index)).toEqual(before);
    expect((await stat(index)).mtimeMs).toBe(beforeStat.mtimeMs);
    await expect(readFile(path.join(root, '.git', 'index.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('asks before status/diff can execute configured filters, preserving their normalization semantics', async () => {
    await repository();
    const marker = path.join(directory, 'filter-executed');
    const hook = path.join(directory, 'filter-hook');
    await writeFile(hook, `#!/bin/sh\nprintf called > '${marker}'\n/bin/cat\n`);
    await chmod(hook, 0o755);
    await git('config', 'filter.hostile.clean', hook);
    await git('config', 'filter.hostile.process', hook);
    await git('config', 'filter.hostile.required', 'true');
    await writeFile(path.join(root, '.gitattributes'), '*.txt filter=hostile\n');
    await writeFile(path.join(root, 'file with spaces.txt'), 'changed content\n');
    for (const command of ['git status --short --branch', 'git diff --stat']) {
      const assessment = await assessReadCommand(command, root, root);
      expect(assessment.plan).toBeNull();
      expect(assessment.reason).toContain('content filters');
    }
    // History/remotes do not inspect the working tree or run its content filters.
    expect(await planReadCommand('git log --oneline -1', root, root)).not.toBeNull();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('asks before status/diff inspect submodules, preserving their complete meaning', async () => {
    await repository();
    const revision = (await git('rev-parse', 'HEAD')).trim();
    await git('update-index', '--add', '--cacheinfo', `160000,${revision},nested`);
    // A nested repository can independently configure helpers, even if the superproject cannot.
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested', '.git'), `gitdir: ${directory}\n`);
    for (const command of ['git status --short --branch', 'git diff --stat']) {
      const assessment = await assessReadCommand(command, root, root);
      expect(assessment.plan).toBeNull();
      expect(assessment.reason).toContain('submodules');
    }
  });

  it('cancels the entire foreground process group before subsequent steps run', async () => {
    await writeFile(path.join(root, 'large.txt'), Buffer.alloc(8 * 1024 * 1024, 'a'));
    const plan = await planReadCommand('cat large.txt && echo AFTER', root, root);
    expect(plan).not.toBeNull();
    const child = spawnReadCommand(plan!, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const cancellation = new AbortController();
    const closed = waitForBashClose(child, cancellation.signal, 100);
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk.toString(); cancellation.abort(); });
    expect(await closed).toBeNull();
    expect(output).not.toContain('AFTER');
  });

  it('revalidates the complete chain, symlink cd and Git configuration before execution', async () => {
    await repository();
    await mkdir(path.join(root, 'child'));
    await symlink(path.join(root, 'child'), path.join(root, 'selected'));
    const args = { command: 'cd selected && pwd && echo okay', working_dir: root };
    authorizeAutoReadCommand(args, (await planReadCommand(args.command, root, root))!);
    await unlink(path.join(root, 'selected'));
    await symlink(directory, path.join(root, 'selected'));
    expect((await consumeAutoReadCommand(args, root)).kind).toBe('rejected');
    const changed = { command: 'ls && echo okay', working_dir: root };
    authorizeAutoReadCommand(changed, (await planReadCommand(changed.command, root, root))!);
    changed.command = 'ls && echo changed';
    expect((await consumeAutoReadCommand(changed, root)).kind).toBe('rejected');
    const configChanged = { command: 'git log --oneline -1', working_dir: root };
    authorizeAutoReadCommand(configChanged, (await planReadCommand(configChanged.command, root, root))!);
    await git('config', 'include.path', path.join(directory, 'unrelated'));
    expect((await consumeAutoReadCommand(configChanged, root)).kind).toBe('rejected');
  });

  it.each([
    ['include.path', '/tmp/unrelated'], ['includeIf.gitdir:*.path', '/tmp/unrelated'],
    ['extensions.partialClone', 'origin'], ['remote.origin.promisor', 'true'], ['extensions.worktreeConfig', 'true'],
  ])('asks for configurations outside the bounded Git lane: %s', async (key, value) => {
    await repository();
    await git('config', key, value);
    expect(await planReadCommand('git log --oneline -10', root, root)).toBeNull();
  });

  it.each(['objects/ab', 'refs/heads/nested'])('refuses nested Git metadata symlinks: %s', async relative => {
    await repository();
    const location = path.join(root, '.git', relative);
    await mkdir(path.dirname(location), { recursive: true });
    await symlink(directory, location);
    expect(await planReadCommand('git log --oneline -10', root, root)).toBeNull();
  });

  it('asks for linked metadata and alternate object stores', async () => {
    await repository();
    await writeFile(path.join(root, '.git', 'objects', 'info', 'alternates'), `${directory}\n`);
    expect(await planReadCommand('git log --oneline -10', root, root)).toBeNull();
    await unlink(path.join(root, '.git', 'objects', 'info', 'alternates'));
    await writeFile(path.join(root, '.git', 'commondir'), `${directory}\n`);
    expect(await planReadCommand('git remote -v', root, root)).toBeNull();
  });
});
