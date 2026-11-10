import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    expect(
      (
        await classify('apply-patch', {
          file_path: 'source.ts',
          patch: '@@ -1,1 +1,1 @@\n-ordinary source\n+changed source\n',
        })
      ).kind
    ).toBe('review');
    expect((await classify('write', { file_path: 'source.ts', content })).kind).toBe('ask');
    expect((await classify('write', { file_path: 'large.ts', content: 'x'.repeat(40 * 1024) })).kind).toBe('ask');
    for (const file_path of ['.env', 'credentials.json', 'AGENTS.md', '.git/config', 'private.key', '../new.ts']) {
      expect((await classify('write', { file_path, content })).kind, file_path).toBe('ask');
    }
    expect((await classify('mcp-deploy', { command: 'safe' })).kind).toBe('ask');
    expect((await classify('bash', { command: 'ls', run_in_background: true })).kind).toBe('ask');
  });
});

describe('canonical unified edit Auto review boundary', () => {
  const patch = '@@ -1,1 +1,1 @@\n-ordinary source\n+changed source\n';
  it('reviews original numeric unified arguments without rewriting them', async () => {
    const args = { file_path: 'source.ts', patch, show_updated_context: true };
    const result = await classify('apply-patch', args);
    expect(result.kind).toBe('review');
    expect(result.review?.arguments).toEqual(args);
    expect(result.review?.arguments).not.toBe(args);
    expect(args).not.toHaveProperty('old_text');
  });
  it('accepts one existing empty-file insertion and rejects changed targets on reclassification', async () => {
    const args = { file_path: 'empty.ts', patch: '@@ -0,0 +1,1 @@\n+export const x = 1;\n' };
    expect((await classify('apply-patch', args)).kind).toBe('ask');
    await writeFile(path.join(root, 'empty.ts'), '');
    expect((await classify('apply-patch', args)).kind).toBe('review');
    await writeFile(path.join(root, 'empty.ts'), 'changed');
    expect((await classify('apply-patch', args)).kind).toBe('ask');
  });
  it.each([
    { patch: '' },
    { patch: 12 },
    { patch: '@@\n-ordinary source\n+new' },
    { patch: '@@ -1,1 +1,1 @@\n-ordinary source\n+ordinary source\n' },
    { patch: '@@ -1,1 +1,1 @@\n-missing context\n+new\n' },
    { patch: '@@ -1,1 +1,1 @@\n-ordinary source\n+new\0' },
    { old_text: 'ordinary source', new_text: 'new' },
    { patch: '@@ -1 +1 @@\n-ordinary source\n+new', old_text: 'ordinary source' },
    { patch: '@@ -1 +1 @@\n-ordinary source\n+new', extra: true },
    { patch: '@@ -1 +1 @@\n-ordinary source\n+new', show_updated_context: 'yes' },
  ])('asks on malformed, mixed, ambiguous or no-op patch input: %j', async invalid => {
    expect((await classify('apply-patch', { file_path: 'source.ts', ...invalid })).kind).toBe('ask');
  });
  it('preserves existing-file, protected-path, external-path and byte bounds', async () => {
    for (const file_path of ['new.ts', '.env', 'AGENTS.md', '../outside.txt', '.'])
      expect((await classify('apply-patch', { file_path, patch })).kind).toBe('ask');
    expect((await classify('apply-patch', { file_path: 'source.ts', patch: patch + '界'.repeat(12000) })).kind).toBe(
      'ask'
    );
  });
  it.each([
    { name: 'invalid UTF-8', bytes: Buffer.concat([Buffer.from('ordinary source\n'), Buffer.from([0xff])]) },
    { name: 'NUL binary source', bytes: Buffer.from('ordinary source\n\0') },
    {
      name: 'UTF-8 encoded surrogate',
      bytes: Buffer.concat([Buffer.from('ordinary source\n'), Buffer.from([0xed, 0xa0, 0x80])]),
    },
  ])('abstains without changing invalid target bytes: $name', async ({ bytes }) => {
    const file = path.join(root, 'source.ts');
    await writeFile(file, bytes);
    expect((await classify('apply-patch', { file_path: 'source.ts', patch })).kind).toBe('ask');
    expect(await readFile(file)).toEqual(bytes);
  });
  it.each(['\0', '\ud800', '\udc00'])(
    'rejects invalid transformed text from canonical escaped patch repair: %j',
    async invalid => {
      const decoded = '@@ -1,1 +1,1 @@\n-ordinary source\n+invalid' + invalid + '\n';
      const encoded = JSON.stringify(decoded).slice(1, -1);
      const file = path.join(root, 'source.ts'),
        before = await readFile(file);
      expect((await classify('apply-patch', { file_path: 'source.ts', patch: encoded })).kind).toBe('ask');
      expect(await readFile(file)).toEqual(before);
    }
  );
  it('rejects a raw patch with an unpaired surrogate before reviewing it', async () => {
    const invalid = '@@ -1,1 +1,1 @@\n-ordinary source\n+invalid\ud800\n';
    expect((await classify('apply-patch', { file_path: 'source.ts', patch: invalid })).kind).toBe('ask');
  });
  it('retains valid literal replacement characters, BOM and CRLF during eligibility checks', async () => {
    const file = path.join(root, 'source.ts'),
      source = '\ufeffheader �\r\nordinary source\r\n';
    await writeFile(file, source);
    const args = { file_path: 'source.ts', patch: '@@ -2,1 +2,1 @@\n-ordinary source\n+changed source\n' };
    expect((await classify('apply-patch', args)).kind).toBe('review');
    expect(await readFile(file)).toEqual(Buffer.from(source, 'utf8'));
  });
  it('does not approve a patch whose formerly matching source changes', async () => {
    const args = { file_path: 'source.ts', patch };
    expect((await classify('apply-patch', args)).kind).toBe('review');
    await writeFile(path.join(root, 'source.ts'), 'externally changed');
    expect((await classify('apply-patch', args)).kind).toBe('ask');
  });
});
