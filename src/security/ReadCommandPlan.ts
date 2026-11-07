/** Exact read-only argv plans; this is not a general shell or an operating-system sandbox. */
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseLiteralReadSyntax, ReadSyntaxError } from './LiteralReadSyntax.js';
import { parseReadUtility } from './ReadUtilityOptions.js';
import { parseGitReadOptions } from './GitReadOptions.js';
import { READ_COMMAND_RUNNER } from './ReadCommandRunner.js';
import { resolveWorkspaceTarget } from './WorkspaceActionPaths.js';

export interface ReadCommandStage {
  effect: 'workspace_read' | 'workspace_metadata' | 'stdin_transform' | 'directory_change' | 'literal_output';
  executable?: string;
  argv: string[];
  workingDirectory: string;
  discardStderr: boolean;
  environment: NodeJS.ProcessEnv;
  echo?: string;
}
export interface ReadCommandStep { stages: ReadCommandStage[]; }
export interface ReadCommandPlan {
  steps: ReadCommandStep[];
  command: string;
  workspaceRoot: string;
  workingDirectory: string;
}
interface ReadAdmission { plan: ReadCommandPlan; argumentDigest: string; }
const admissions = new WeakMap<object, ReadAdmission>();

export interface ReadCommandAssessment { plan: ReadCommandPlan | null; reason?: string; }
class ReadPolicyError extends Error {}

/** Convenience for execution revalidation: an ineligible request has no executable plan. */
export async function planReadCommand(command: string, workingDirectory: string, workspaceRoot: string): Promise<ReadCommandPlan | null> {
  return (await assessReadCommand(command, workingDirectory, workspaceRoot)).plan;
}

/** Prepare a complete, fail-stop chain of literal operations with known read-only effects. */
export async function assessReadCommand(command: string, workingDirectory: string, workspaceRoot: string): Promise<ReadCommandAssessment> {
  try {
    const pipelines = parseLiteralReadSyntax(command);
    if (!['darwin', 'linux'].includes(process.platform)) return { plan: null };
    const root = await realpath(workspaceRoot);
    const initial = await resolveWorkspaceTarget(workingDirectory, root, root);
    if (!initial || !(await stat(initial.path)).isDirectory()) return { plan: null };
    let cwd = initial.path;
    let stageNumber = 0;
    const steps: ReadCommandStep[] = [];
    for (const pipeline of pipelines) {
      const stages: ReadCommandStage[] = [];
      for (let index = 0; index < pipeline.stages.length; index++) {
        const segment = pipeline.stages[index]!;
        const words = segment.words;
        const program = path.basename(words[0]!);
        stageNumber++;
        try {
          const base = { workingDirectory: cwd, discardStderr: segment.discardStderr, environment: readEnvironment(), argv: [] as string[] };
          if (words[0] === 'cd') {
            if (pipeline.stages.length !== 1 || words.length !== 2 || words[1]!.startsWith('-')) throw new ReadPolicyError('cd needs one literal directory outside a pipeline.');
            const target = await resolveWorkspaceTarget(words[1]!, cwd, root);
            if (!target || !(await stat(target.path)).isDirectory()) throw new ReadPolicyError('The directory is outside the workspace or cannot be inspected.');
            cwd = target.path;
            stages.push({ ...base, workingDirectory: cwd, effect: 'directory_change' });
          } else if (words[0] === 'echo') {
            if (/^-[neE]+$/.test(words[1] ?? '') || words.some(word => word.includes('\\'))) throw new ReadPolicyError('Echo options and escape interpretation require permission.');
            stages.push({ ...base, echo: words.slice(1).join(' '), effect: 'literal_output' });
          } else if (words[0] === 'git' || words[0] === '/usr/bin/git' || words[0] === '/bin/git') {
            const git = await planGitRead(words.slice(1), cwd, root);
            if (!git) throw new ReadPolicyError('This repository layout needs review before Git can inspect it.');
            stages.push({ ...base, ...git, environment: readEnvironment(true), effect: 'workspace_metadata' });
          } else {
            const syntax = parseReadUtility(words, index > 0);
            if (!syntax) throw new ReadPolicyError(`${program} arguments are not verified as workspace reads or stdin-only transforms. File writes, executable predicates, and unknown options require permission.`);
            const executable = await systemExecutable(syntax.program);
            if (!executable) throw new ReadPolicyError('A trusted system executable is not available.');
            const targets: string[] = [];
            for (const value of syntax.paths) {
              if (value === '-' && index > 0) { targets.push('-'); continue; }
              const target = await resolveWorkspaceTarget(value, cwd, root);
              if (!target) throw new ReadPolicyError('A file target is outside the workspace or cannot be resolved.');
              const information = await stat(target.path);
              if (syntax.metadata ? !information.isDirectory() && !information.isFile() : !information.isFile()) throw new ReadPolicyError('The target is not an ordinary file or supported directory.');
              if (syntax.program === 'find' && !path.isAbsolute(value)) {
                const relative = path.relative(cwd, target.path) || '.';
                targets.push(relative.startsWith('-') ? `./${relative}` : relative);
              } else targets.push(target.path);
            }
            const effect = syntax.metadata ? 'workspace_metadata' : syntax.paths.length ? 'workspace_read' : 'stdin_transform';
            stages.push({ ...base, executable, argv: [...syntax.flags, ...targets, ...(syntax.expression ?? [])], effect });
          }
        } catch (error) {
          throw new ReadPolicyError(`Stage ${stageNumber} (${program}): ${error instanceof ReadPolicyError ? error.message : 'The target could not be inspected safely.'}`);
        }
      }
      steps.push({ stages });
    }
    return { plan: { command, workspaceRoot: root, workingDirectory: initial.path, steps } };
  } catch (error) {
    return { plan: null, ...(error instanceof ReadPolicyError || error instanceof ReadSyntaxError ? { reason: error.message } : {}) };
  }
}

/** Bind one Auto approval to the complete arguments object passed to the execution boundary. */
export function authorizeAutoReadCommand(args: Readonly<Record<string, unknown>>, plan: ReadCommandPlan): void {
  const argumentDigest = digestArguments(args);
  if (!argumentDigest) throw new Error('Automatic read approval requires serializable arguments');
  admissions.set(args, { plan: structuredClone(plan), argumentDigest });
}

export type ReadCommandAdmission = { kind: 'none' } | { kind: 'rejected'; reason: string } | { kind: 'approved'; plan: ReadCommandPlan };

/** Consume, compare and revalidate approval; changed requests never fall back to Bash. */
export async function consumeAutoReadCommand(args: Readonly<Record<string, unknown>>, workingDirectory: string): Promise<ReadCommandAdmission> {
  const admission = admissions.get(args);
  if (!admission) return { kind: 'none' };
  admissions.delete(args);
  if (digestArguments(args) !== admission.argumentDigest || args.command !== admission.plan.command || args.run_in_background === true) {
    return { kind: 'rejected', reason: 'The automatically approved read request changed before execution. Ask for permission again.' };
  }
  const current = await planReadCommand(admission.plan.command, workingDirectory, admission.plan.workspaceRoot);
  if (!current || JSON.stringify(current) !== JSON.stringify(admission.plan)) {
    return { kind: 'rejected', reason: 'The automatically approved read target changed or is no longer inside the permitted workspace.' };
  }
  return { kind: 'approved', plan: current };
}

/** Launch validated argv directly with a pinned executable and no inherited loader or shell configuration. */
export function spawnReadCommand(plan: ReadCommandPlan, options: SpawnOptions): ChildProcess {
  const first = plan.steps[0]!.stages[0]!;
  if (plan.steps.length === 1 && plan.steps[0]!.stages.length === 1 && first.executable) {
    return spawn(first.executable, first.argv, {
      ...options, cwd: first.workingDirectory, shell: false, env: first.environment,
      ...(first.discardStderr ? { stdio: ['ignore', 'pipe', 'ignore'] as const } : {}),
    });
  }
  return spawn(process.execPath, ['--eval', READ_COMMAND_RUNNER, JSON.stringify(plan.steps)], {
    ...options, cwd: plan.workingDirectory, shell: false, env: readEnvironment(),
  });
}

/** No inherited Git, loader, shell, credential, pager or editor configuration. */
function readEnvironment(git = false): NodeJS.ProcessEnv {
  return {
    LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    ...(git ? {
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: '', PAGER: '', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null',
    } : {}),
  };
}

const runFile = promisify(execFile);
const GIT_OVERRIDES = ['--no-pager', '--no-optional-locks', '--no-lazy-fetch', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.splitIndex=false', '-c', 'status.submoduleSummary=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'advice.graftFileDeprecated=false', '-c', 'core.pager=', '-c', 'core.alternateRefsCommand=', '-c', 'log.showSignature=false',
  '-c', 'protocol.allow=never', '-c', 'core.quotePath=true'];

/** Read metadata only from an ordinary repository inside this workspace; linked worktrees require approval. */
async function planGitRead(words: string[], cwd: string, root: string): Promise<{ executable: string; argv: string[] } | null> {
  const operation = parseGitReadOptions(words);
  if (!operation) throw new ReadPolicyError('Auto does not support these Git options. Use read-only status, log, branch, remote, or diff options.');
  const executable = await systemExecutable('git');
  if (!executable) return null;
  let directory = cwd;
  let gitDirectory: string | undefined;
  while (true) {
    const candidate = path.join(directory, '.git');
    try {
      const info = await lstat(candidate);
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
      gitDirectory = candidate;
      break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
    if (directory === root) return null;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  // Git can follow alternate object stores or metadata symlinks outside the workspace.
  // These repository layouts remain human-approved rather than partially confined.
  for (const relative of ['config', 'HEAD', 'packed-refs', 'config.worktree', 'index', 'info/exclude', 'info/attributes', 'shallow', 'commondir', 'objects', 'objects/info', 'objects/pack', 'refs', 'reftable']) {
    const target = path.join(gitDirectory, relative);
    try {
      if ((await lstat(target)).isSymbolicLink()) return null;
      if (!await resolveWorkspaceTarget(target, root, root)) return null;
      if (relative === 'commondir') return null;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
  }
  for (const relative of ['objects/info/alternates', 'objects/info/http-alternates']) {
    try { await lstat(path.join(gitDirectory, relative)); return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
  }
  if (!await safeGitMetadata(gitDirectory)) throw new ReadPolicyError('Git metadata contains symlinks, unusual files, or exceeds the bounded inspection budget. Review this command before allowing.');
  const prefix = [...GIT_OVERRIDES, `--git-dir=${gitDirectory}`, `--work-tree=${directory}`];
  const config = await runFile(executable, [...prefix, 'config', '--local', '--no-includes', '--null', '--list'], {
    cwd, env: readEnvironment(true), timeout: 2000, maxBuffer: 65536,
  });
  const entries = config.stdout.split('\0');
  // Includes can load unrelated secrets; worktree configuration introduces another owner.
  if (entries.some(entry => /^(?:include\.|includeif\.|extensions\.(?:worktreeconfig|partialclone)\n|remote\..*\.promisor\n)/i.test(entry))) {
    throw new ReadPolicyError('This repository uses config includes, linked worktree settings, or partial-clone helpers. Review this Git command before allowing.');
  }
  if (operation.workingTree && entries.some(entry => /^filter\./i.test(entry))) {
    throw new ReadPolicyError('This repository configures content filters. Git status or diff can execute them; review this command before allowing.');
  }
  for (const entry of entries) {
    const separator = entry.indexOf('\n');
    const key = entry.slice(0, separator).toLowerCase();
    if (operation.workingTree && ['core.excludesfile', 'core.attributesfile'].includes(key)) {
      const value = entry.slice(separator + 1);
      const target = await resolveWorkspaceTarget(value, directory, root);
      if (!target) throw new ReadPolicyError('Git attributes or ignore rules reference a external file. Review this command before allowing.');
    }
  }
  if (operation.workingTree) {
    let indexEntries: string;
    try {
      indexEntries = (await runFile(executable, [...prefix, 'ls-files', '--stage', '-z'], {
        cwd, env: readEnvironment(true), timeout: 2000, maxBuffer: 4 * 1024 * 1024,
      })).stdout;
    } catch {
      throw new ReadPolicyError('Auto could not inspect this Git index within its read budget. Review this command before allowing.');
    }
    if (indexEntries.split('\0').some(entry => entry.startsWith('160000 '))) {
      throw new ReadPolicyError('This repository has submodules. Git status or diff can inspect another repository; review this command before allowing.');
    }
  }
  const safety = operation.family === 'log'
    ? ['--no-patch', '--no-notes', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--no-decorate', '--no-color', '--no-use-mailmap', operation.argv.includes('--oneline') ? '--format=%h %s' : '--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%w(0,4,4)%B%n']
    : operation.family === 'diff' ? ['--no-ext-diff', '--no-textconv', '--no-color']
        : operation.family === 'branch' ? ['--no-color'] : [];
  return { executable, argv: [...prefix, operation.family, ...operation.argv, ...safety] };
}

/** Inspect names/types only; large or unusual object/ref stores stay human-approved. */
async function safeGitMetadata(gitDirectory: string): Promise<boolean> {
  const pending = ['objects', 'refs', 'reftable'].map(name => path.join(gitDirectory, name));
  const deadline = performance.now() + 250;
  let entries = 0;
  const top = await opendir(gitDirectory);
  for await (const entry of top) {
    if (++entries > 16384 || performance.now() > deadline) return false;
    if (entry.name.startsWith('sharedindex.') && !entry.isFile()) return false;
  }
  while (pending.length) {
    if (performance.now() > deadline) return false;
    const directory = pending.pop()!;
    try {
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (++entries > 16384 || performance.now() > deadline) return false;
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return false;
        if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}

function digestArguments(args: Readonly<Record<string, unknown>>): string {
  try { return createHash('sha256').update(JSON.stringify(args)).digest('hex'); }
  catch { return ''; }
}

async function systemExecutable(program: string): Promise<string | null> {
  for (const candidate of [`/bin/${program}`, `/usr/bin/${program}`]) {
    try {
      const canonical = await realpath(candidate);
      let current = canonical;
      while (true) {
        const info = await stat(current);
        if (info.uid !== 0 || (info.mode & 0o022) !== 0) break;
        const parent = path.dirname(current);
        if (parent === current) return (await stat(canonical)).isFile() ? canonical : null;
        current = parent;
      }
    } catch { /* Try the other conventional system location. */ }
  }
  return null;
}
