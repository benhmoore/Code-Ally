import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityStream } from '../../services/ActivityStream.js';
import { BashTool } from '../../tools/BashTool.js';
import { assessReadCommand, authorizeAutoReadCommand, consumeAutoReadCommand, planReadCommand, spawnReadCommand } from '../ReadCommandPlan.js';
import { parseLiteralReadSyntax } from '../LiteralReadSyntax.js';
import { waitForBashClose } from '../../utils/bashProcess.js';
import * as bashProcess from '../../utils/bashProcess.js';

let parent: string;
let root: string;
beforeEach(async () => {
  parent = await realpath(await mkdtemp(path.join(tmpdir(), 'ally-read-pipeline-')));
  root = path.join(parent, 'workspace');
  await mkdir(path.join(root, 'backend/app/nested'), { recursive: true });
  await writeFile(path.join(root, 'backend/app/z.py'), 'z');
  await writeFile(path.join(root, 'backend/app/a.py'), 'a');
  await writeFile(path.join(root, 'backend/app/other.txt'), 'other');
  await writeFile(path.join(root, 'input.txt'), 'z\na\na\nb\n');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(parent, { recursive: true, force: true }); });
async function run(command: string) {
  const args = { command, working_dir: root, timeout: 3 };
  const assessment = await assessReadCommand(command, root, root);
  expect(assessment.plan, assessment.reason).not.toBeNull();
  authorizeAutoReadCommand(args, assessment.plan!);
  return new BashTool(new ActivityStream()).execute(args);
}

describe.runIf(['darwin', 'linux'].includes(process.platform))('compositional read pipelines', () => {
  it('executes the find/sort screenshot with quoted patterns, empty labels and cwd intact', async () => {
    const shell = vi.spyOn(bashProcess, 'spawnBashCommand');
    const result = await run(`cd '${root}' && echo "=== backend/app dirs ===" && find backend/app -maxdepth 1 -type d | sort && echo "" && echo "=== backend/app top-level files ===" && find backend/app -maxdepth 1 -type f -name '*.py' | sort`);
    expect(result.success).toBe(true);
    expect(result.content).toBe('=== backend/app dirs ===\nbackend/app\nbackend/app/nested\n\n=== backend/app top-level files ===\nbackend/app/a.py\nbackend/app/z.py\n');
    expect(shell).not.toHaveBeenCalled();
  });

  it('composes data sources, transforms and predicates rather than matching command strings', async () => {
    const result = await run("cat input.txt | sort -r | uniq -c && find backend/app -maxdepth 1 '(' -name '*.py' -o -name '*.txt' ')' -type f | sort | head -n 2 | wc -l");
    expect(result.success).toBe(true);
    expect(result.content).toMatch(/1 z\n\s*1 b\n\s*2 a\n\s*2\n/);
    const plan = (await planReadCommand('cat input.txt | sort | uniq | wc -l', root, root))!;
    expect(plan.steps[0]!.stages.map(stage => stage.effect)).toEqual(['workspace_read', 'stdin_transform', 'stdin_transform', 'stdin_transform']);
  });

  it('passes quoted operators and escaped expansion characters only as literal data', async () => {
    expect(parseLiteralReadSyntax("echo 'a | b && $HOME' | sort")[0]!.stages[0]!.words).toEqual(['echo', 'a | b && $HOME']);
    const result = await run("echo 'a | b && $HOME' | sort");
    expect(result.content).toBe('a | b && $HOME\n');
    expect((await run('echo "\\$HOME"')).content).toBe('$HOME\n');
  });

  it('does not follow directory symlinks during find traversal', async () => {
    await writeFile(path.join(parent, 'outside.py'), 'outside');
    await symlink(parent, path.join(root, 'backend/app/external'));
    const result = await run("find backend/app -type f -name '*.py' | sort");
    expect(result.success).toBe(true);
    expect(result.content).not.toContain('outside');
    expect(await planReadCommand('find backend/app/external -type f | sort', root, root)).toBeNull();
  });

  it('revalidates pipeline arguments and canonical targets instead of falling back to a shell', async () => {
    const args = { command: 'find backend/app -type f | sort', working_dir: root };
    authorizeAutoReadCommand(args, (await planReadCommand(args.command, root, root))!);
    args.command = 'find backend/app -delete | sort';
    expect((await consumeAutoReadCommand(args, root)).kind).toBe('rejected');
    await symlink(path.join(root, 'backend/app'), path.join(root, 'selected'));
    const changed = { command: 'find selected -type f | sort', working_dir: root };
    authorizeAutoReadCommand(changed, (await planReadCommand(changed.command, root, root))!);
    await unlink(path.join(root, 'selected'));
    await symlink(parent, path.join(root, 'selected'));
    expect((await consumeAutoReadCommand(changed, root)).kind).toBe('rejected');
  });

  it('closes ignored upstream input and early-ending consumers without hanging', async () => {
    await writeFile(path.join(root, 'large.txt'), 'a\n'.repeat(2 * 1024 * 1024));
    const ignored = await run('cat large.txt | echo done && echo after');
    expect(ignored.success).toBe(true);
    expect(ignored.content).toBe('done\nafter\n');
    const early = await run('cat large.txt | head -n 1 && echo after');
    expect(early.success).toBe(true);
    expect(early.content).toBe('a\nafter\n');
    expect((await run('find backend/app -type f | head -n 1')).success).toBe(true);
  });

  it('cancels all connected foreground stages before the next command runs', async () => {
    await writeFile(path.join(root, 'large.txt'), 'a\n'.repeat(2 * 1024 * 1024));
    const plan = (await planReadCommand('cat large.txt | cat && echo AFTER', root, root))!;
    const child = spawnReadCommand(plan, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const cancellation = new AbortController();
    const closed = waitForBashClose(child, cancellation.signal, 100);
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk.toString(); cancellation.abort(); });
    expect(await closed).toBeNull();
    expect(output).not.toContain('AFTER');
  });

  it('uses the last pipeline status and then applies && fail-stop, with per-stage stderr discard', async () => {
    const producer = await run('cat input.txt | sort -c 2>/dev/null | wc -l && echo after');
    expect(producer.success).toBe(true);
    expect(producer.content).toMatch(/0\nafter\n/);
    expect(producer.stderr).toBe('');
    const final = await run('cat input.txt | sort -c 2>/dev/null && echo AFTER');
    expect(final.success).toBe(false);
    expect(final.content).toBe('');
    expect(final.stderr).toBe('');
  });

  it.each([
    'find backend/app -delete | sort', "find backend/app -exec sh '{}' ';' | sort",
    "find backend/app -execdir sh '{}' '+' | sort", 'find -L backend/app -type f | sort',
    'find backend/app -fprint result | sort', 'find backend/app -fls result | sort',
    'find backend/app -readable | sort', 'find backend/app -writable | sort', 'find backend/app -executable | sort',
    'find ../ -type f | sort', "find backend/app -name $PATTERN | sort", 'find backend/app -name *.py | sort',
    'find backend/app | sort -o result', 'find backend/app | sort --output=result',
    'find backend/app | sort --compress-program=sh', 'find backend/app | sort -T /tmp',
    'find backend/app | sort /etc/passwd', 'find backend/app | sort --files0-from=/etc/passwd',
    'cat input.txt | sed -i x input.txt', 'cat input.txt | sh', 'cat input.txt || sort',
    'cat input.txt | sort > result', 'cat input.txt | sort 2>&1', 'cat input.txt | sort &',
    'cat input.txt | sort |', 'cat input.txt | | sort', 'cat input.txt | cd backend',
  ])('asks for an unverified stage or shell effect: %s', async command => {
    const assessment = await assessReadCommand(command, root, root);
    expect(assessment.plan, command).toBeNull();
    expect(assessment.reason).toBeTruthy();
  });
});
