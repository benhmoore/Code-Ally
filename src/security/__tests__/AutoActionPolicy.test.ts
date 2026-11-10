import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyAutoAction } from '../AutoActionPolicy.js';

let directory: string;
let root: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'ally-auto-policy-'));
  root = path.join(directory, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'source.ts'), 'ordinary source');
  await writeFile(path.join(root, '.env'), 'SECRET=value');
  await writeFile(path.join(directory, 'outside.txt'), 'outside secret');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const classify = (toolName: string, args: Record<string, unknown>) =>
  classifyAutoAction({ toolName, args, workspaceRoot: root });

describe('selective Auto deterministic envelope', () => {
  it.each(['AGENTS.md', 'SKILL.md', '.env', '.git/config', '.claude/settings.json'])(
    'allows reading %s inside the repository while retaining write protections',
    async file_path => {
      expect((await classify('read', { file_path })).kind).toBe('allow');
      expect((await classify('write', { file_path, content: 'replacement' })).kind).toBe('ask');
    }
  );

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    'allows exact, pinned, literal utility plans',
    async () => {
      for (const command of [
        'pwd',
        'ls -la',
        'cat source.ts',
        'head -n 2 source.ts',
        'tail -n1 source.ts',
        'wc -l source.ts',
      ]) {
        const decision = await classify('bash', { command });
        expect(decision.kind, command).toBe('allow');
        expect(decision.readCommand?.steps[0]?.stages[0]?.executable?.startsWith('/')).toBe(true);
      }
    }
  );

  it.each([
    'cat source.ts; touch marker',
    'cat source.ts && touch marker',
    'cat source.ts | sh',
    'cat source.ts > marker',
    'cat source.ts 2>&1',
    'cat $(pwd)/source.ts',
    'cat `pwd`/source.ts',
    'PATH=. cat source.ts',
    'env cat source.ts',
    'command cat source.ts',
    'bash -c "cat source.ts"',
    'node -e "process.exit()"',
    'npm test',
    'git status',
    'find . -exec sh {} ;',
    'sed -i x source.ts',
    'ls --unknown',
    'ls $HOME',
    'cat ../outside.txt',
    'cat /etc/passwd',
    'ls\ncat source.ts',
    'cat source.ts # comment',
    'cat *.ts',
    'cat "unterminated',
    './cat source.ts',
    'ls -L',
    'tail -f source.ts',
    'head -n -1 source.ts',
  ])('asks rather than interpreting unknown shell effects: %s', async command => {
    expect((await classify('bash', { command })).kind).toBe('ask');
  });

  it('allows workspace reads independently of write protection', async () => {
    for (const [tool, args] of [
      ['read', { file_path: 'source.ts' }],
      ['glob', { patterns: ['**/*.ts'] }],
      ['grep', { pattern: 'source', path: '.' }],
      ['ls', {}],
      ['tree', { paths: ['.'] }],
    ] as const)
      expect((await classify(tool, args)).kind).toBe('allow');
    expect((await classify('grep', { pattern: 'source' })).grepRead?.target).toBeTruthy();
    for (const tool of ['read', 'grep'])
      expect((await classify(tool, { path: '.env', file_path: '.env', pattern: '.' })).kind).toBe('allow');
    expect((await classify('grep', { pattern: '.', glob: '**/.env*' })).kind).toBe('allow');
    expect((await classify('glob', { patterns: ['{../outside,source.ts}'] })).kind).toBe('ask');
    expect((await classify('glob', { patterns: ['{source.ts,/tmp/*}'] })).kind).toBe('ask');
    expect((await classify('glob', { pattern: '../*' })).kind).toBe('ask');
  });

  it('does not let symlinks or missing descendants escape the workspace', async () => {
    await symlink(directory, path.join(root, 'escape'), 'dir');
    await symlink(path.join(root, '.env'), path.join(root, 'alias'));
    expect((await classify('read', { file_path: 'escape/outside.txt' })).kind).toBe('ask');
    expect((await classify('read', { file_path: 'alias' })).kind).toBe('allow');
    expect((await classify('write', { file_path: 'escape/new.txt', content: 'changed' })).kind).toBe('ask');
  });

  it('reviews only complete bounded ordinary edits and never allows model review to widen the envelope', async () => {
    const content = 'export const answer = 42;';
    const decision = await classify('write', { file_path: 'new.ts', content });
    expect(decision.kind).toBe('review');
    expect(decision.review?.arguments).toEqual({ file_path: 'new.ts', content });
    expect((await classify('apply-patch', { file_path: 'source.ts', old_text: 'old', new_text: 'new' })).kind).toBe(
      'review'
    );
    expect((await classify('write', { file_path: 'source.ts', content })).kind).toBe('ask');
    expect((await classify('write', { file_path: 'large.ts', content: 'x'.repeat(40 * 1024) })).kind).toBe('ask');
    for (const file_path of ['.env', 'credentials.json', 'AGENTS.md', '.git/config', 'private.key', '../new.ts']) {
      expect((await classify('write', { file_path, content })).kind, file_path).toBe('ask');
    }
    expect((await classify('mcp-deploy', { command: 'safe' })).kind).toBe('ask');
    expect((await classify('bash', { command: 'ls', run_in_background: true })).kind).toBe('ask');
  });
});

describe('exact edit Auto review boundary', () => {
  it('reviews initialization only for an existing zero-byte file and rechecks its size', async () => {
    const args = {
      file_path: 'empty.ts',
      old_text: '',
      new_text: 'export const x = 1;',
    };
    expect((await classify('apply-patch', args)).kind).toBe('ask');
    await writeFile(path.join(root, 'empty.ts'), '');
    const eligible = await classify('apply-patch', args);
    expect(eligible.kind).toBe('review');
    expect(eligible.review?.arguments).toEqual(args);
    await writeFile(path.join(root, 'empty.ts'), 'changed');
    expect((await classify('apply-patch', args)).kind).toBe('ask');
    await writeFile(path.join(root, 'empty.ts'), '\n');
    expect((await classify('apply-patch', args)).kind).toBe('ask');
    await writeFile(path.join(root, 'empty.ts'), '');
    expect((await classify('apply-patch', { ...args, new_text: '' })).kind).toBe('ask');
  });
  it('reviews the original exact arguments without rewriting them to a patch', async () => {
    const args = { file_path: 'source.ts', old_text: 'ordinary source', new_text: 'changed source' };
    const decision = await classify('apply-patch', args);
    expect(decision.kind).toBe('review');
    expect(decision.review?.arguments).toEqual(args);
    expect(decision.review?.arguments).not.toBe(args);
    expect(args).not.toHaveProperty('patch');
  });
  it.each([
    { old_text: '', new_text: 'changed' },
    { old_text: 'source', new_text: null },
    { old_text: 'source', new_text: 'source' },
    { old_text: 'a\0', new_text: 'b' },
    { old_text: 'a', new_text: 'b\0' },
    { old_text: 'source', new_text: 'new', patch: 'mixed schema' },
    { old_text: 'source', new_text: 'new', extra: true },
    { patch: 'historical interface' },
  ])('asks on invalid, mixed or unknown exact arguments: %j', async invalid => {
    expect((await classify('apply-patch', { file_path: 'source.ts', ...invalid })).kind).toBe('ask');
  });
  it('preserves existing-file, protected-path, external-path and byte bounds', async () => {
    for (const file_path of ['new.ts', '.env', 'AGENTS.md', '../outside.txt', '.'])
      expect((await classify('apply-patch', { file_path, old_text: 'old', new_text: 'new' })).kind).toBe('ask');
    expect(
      (await classify('apply-patch', { file_path: 'source.ts', old_text: 'source', new_text: '界'.repeat(12000) })).kind
    ).toBe('ask');
  });
});
