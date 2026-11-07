/** Canonical workspace targets used by selective Auto policy and its read executor. */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface WorkspaceTarget {
  path: string;
  relativePath: string;
}

/** Resolve the nearest existing ancestor so missing write targets cannot hide symlink escapes. */
export async function resolveWorkspaceTarget(value: string, workingDirectory: string, workspaceRoot: string): Promise<WorkspaceTarget | null> {
  if (!value || /[\0\r\n]/.test(value) || value.startsWith('~')) return null;
  try {
    const root = await realpath(workspaceRoot);
    const absolute = path.resolve(workingDirectory, value);
    const missing: string[] = [];
    let existing = absolute;
    while (true) {
      try { await lstat(existing); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        const parent = path.dirname(existing);
        if (parent === existing) return null;
        missing.unshift(path.basename(existing));
        existing = parent;
      }
    }
    const canonical = path.join(await realpath(existing), ...missing);
    const relativePath = path.relative(root, canonical);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return null;
    return { path: canonical, relativePath };
  } catch { return null; }
}

const PROTECTED_DIRECTORY_NAMES = ['.git', '.ssh', '.aws', '.gnupg', '.config', '.ally', '.ally-sessions', '.agents', '.codex', '.claude', '.docker', '.kube', '.azure'] as const;
const PROTECTED_FILE_NAMES = ['agents.md', 'ally.md', 'skill.md', '.npmrc', '.netrc', '.pypirc', '.envrc', '.git-credentials', 'id_rsa', 'id_ed25519'] as const;
const PROTECTED_FILE_STEMS = ['.env', 'credential', 'credentials', 'secret', 'secrets', 'token', 'tokens'] as const;
const PROTECTED_FILE_EXTENSIONS = ['pem', 'key', 'p12', 'pfx', 'keystore', 'kdbx'] as const;

/** Writes to credentials, permission metadata and persistent instructions require a human. */
export function isProtectedWorkspaceWriteTarget(target: WorkspaceTarget): boolean {
  const segments = target.relativePath.split(/[\\/]/);
  return segments.some(segment => {
    const name = segment.toLowerCase();
    return (PROTECTED_DIRECTORY_NAMES as readonly string[]).includes(name)
      || (PROTECTED_FILE_NAMES as readonly string[]).includes(name)
      || PROTECTED_FILE_STEMS.some(stem => name === stem || name.startsWith(`${stem}.`))
      || PROTECTED_FILE_EXTENSIONS.some(extension => name.endsWith(`.${extension}`));
  });
}
