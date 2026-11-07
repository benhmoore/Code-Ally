/** One-use Auto grep grants enforce protected-file exclusions and suppress ripgrep configuration execution. */
import { createHash } from 'node:crypto';
import { isProtectedWorkspaceTarget, resolveWorkspaceTarget, PROTECTED_DIRECTORY_NAMES, PROTECTED_FILE_NAMES, PROTECTED_FILE_STEMS, PROTECTED_FILE_EXTENSIONS } from './WorkspaceActionPaths.js';

export interface AutoGrepReadPlan { workspaceRoot: string; target: string; }
const grants = new WeakMap<object, { digest: string; plan: AutoGrepReadPlan }>();
const protectedGlobs = [
  ...PROTECTED_DIRECTORY_NAMES.flatMap(name => [`!**/${name}`, `!**/${name}/**`]),
  ...PROTECTED_FILE_NAMES.map(name => `!**/${name}`),
  ...PROTECTED_FILE_STEMS.flatMap(name => [`!**/${name}`, `!**/${name}.*`]),
  ...PROTECTED_FILE_EXTENSIONS.map(extension => `!**/*.${extension}`),
];

export function authorizeAutoGrepRead(args: Readonly<Record<string, unknown>>, plan: AutoGrepReadPlan): void {
  const argumentDigest = digest(args);
  if (!argumentDigest) throw new Error('Automatic search approval requires serializable arguments');
  grants.set(args, { digest: argumentDigest, plan: { ...plan } });
}

export type AutoGrepAdmission = { kind: 'none' } | { kind: 'rejected'; reason: string } | { kind: 'approved'; target: string; extraArguments: string[] };

/** Enforce the exact approved target and code-owned exclusions on the actual ripgrep invocation. */
export async function consumeAutoGrepRead(args: Readonly<Record<string, unknown>>): Promise<AutoGrepAdmission> {
  const grant = grants.get(args);
  if (!grant) return { kind: 'none' };
  grants.delete(args);
  if (digest(args) !== grant.digest) return { kind: 'rejected', reason: 'The automatically approved search arguments changed before execution.' };
  const target = await resolveWorkspaceTarget(typeof args.path === 'string' ? args.path : '.', grant.plan.workspaceRoot, grant.plan.workspaceRoot);
  if (!target || target.path !== grant.plan.target || isProtectedWorkspaceTarget(target)) {
    return { kind: 'rejected', reason: 'The automatically approved search target changed or left the workspace.' };
  }
  return { kind: 'approved', target: target.path, extraArguments: ['--no-config', ...protectedGlobs.flatMap(pattern => ['--iglob', pattern])] };
}

function digest(args: Readonly<Record<string, unknown>>): string {
  try { return createHash('sha256').update(JSON.stringify(args)).digest('hex'); }
  catch { return ''; }
}
