/** Deterministic selective-Auto envelope. Review cannot authorize unknown execution or external effects. */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AutoGrepReadPlan } from './GrepReadBoundary.js';
import { assessReadCommand, type ReadCommandPlan } from './ReadCommandPlan.js';
import { isProtectedWorkspaceWriteTarget, resolveWorkspaceTarget } from './WorkspaceActionPaths.js';
import { ToolCapability } from '../tools/ToolCapability.js';
import type { ToolPermissionMetadata } from './ToolPermissionMetadata.js';

export interface AutoActionInput {
  toolMetadata?: ToolPermissionMetadata;
  toolName: string;
  args: Readonly<Record<string, unknown>>;
  workspaceRoot: string;
}
export interface AutoActionDecision {
  kind: 'allow' | 'review' | 'ask' | 'deny';
  reason: string;
  effect?: 'workspace_read' | 'workspace_edit';
  review?: Record<string, unknown>;
  readCommand?: ReadCommandPlan;
  grepRead?: AutoGrepReadPlan;
}
const MAX_REVIEW_BYTES = 32 * 1024;
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'tree']);

/** Describe only code-owned, bounded effects; unknowns always need a person. */
export async function classifyAutoAction(input: AutoActionInput): Promise<AutoActionDecision> {
  const { toolName, args, workspaceRoot } = input;
  if (toolName === 'bash') {
    if (typeof args.command !== 'string' || args.run_in_background === true) return ask('Only foreground literal read commands are eligible for Auto.');
    if (args.working_dir !== undefined && typeof args.working_dir !== 'string') return ask('The command working directory is not a literal path.');
    const workingDirectory = typeof args.working_dir === 'string' ? path.resolve(workspaceRoot, args.working_dir) : workspaceRoot;
    const assessment = await assessReadCommand(args.command, workingDirectory, workspaceRoot);
    const readCommand = assessment.plan;
    return readCommand
      ? { kind: 'allow', effect: 'workspace_read', reason: 'Verified read-only workspace command.', readCommand }
      : ask(assessment.reason ?? 'Auto could not verify this command as read-only. Review it before allowing.');
  }
  if (READ_TOOLS.has(toolName)) {
    const values = toolName === 'read' ? [args.file_path]
      : toolName === 'tree' ? args.paths ?? ['.'] : [args.path ?? '.'];
    if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string')) return ask('Read targets must be literal workspace paths.');
    let canonicalTarget: string | undefined;
    for (const value of values as string[]) {
      const target = await resolveWorkspaceTarget(value, workspaceRoot, workspaceRoot);
      if (!target) return ask('The read target resolves outside the workspace or cannot be resolved.');
      canonicalTarget = target.path;
    }
    const filters = toolName === 'glob' ? args.patterns ?? args.pattern : toolName === 'grep' ? args.glob : undefined;
    const patterns = Array.isArray(filters) ? filters : typeof filters === 'string' ? [filters] : [];
    if (patterns.some(pattern => typeof pattern !== 'string' || path.isAbsolute(pattern) || /[{},!]\//.test(pattern) || pattern.includes('..'))) return ask('The file filter requests an external or unresolved path.');
    if (toolName === 'grep' && ((typeof args.type === 'string' && !/^[a-zA-Z0-9_+]+$/.test(args.type)) || (typeof args.glob === 'string' && args.glob.startsWith('-')))) return ask('Unknown search options require permission.');
    return { kind: 'allow', effect: 'workspace_read', reason: 'Built-in read operation with workspace-scoped targets.',
      ...(toolName === 'grep' && canonicalTarget ? { grepRead: { workspaceRoot, target: canonicalTarget } } : {}) };

  }
  if (toolName !== 'write' && toolName !== 'apply-patch') {
    const metadata = input.toolMetadata;
    if (metadata && metadata.capabilities.every(capability =>
      capability === ToolCapability.FsRead || capability === ToolCapability.AppStateWrite)) {
      for (const localPath of metadata.localPaths) {
        if (!await resolveWorkspaceTarget(localPath, workspaceRoot, workspaceRoot)) {
          return ask('The declared local path resolves outside the workspace or cannot be resolved.');
        }
      }
      return { kind: 'allow', reason: 'Code-owned invocation has only bounded observation or application state effects.' };
    }
    return ask('Auto could not verify this operation\'s effects. Review it before allowing.');
  }
  if (typeof args.file_path !== 'string') return ask('A reviewed edit requires one literal file path.');
  const target = await resolveWorkspaceTarget(args.file_path, workspaceRoot, workspaceRoot);
  if (!target) return ask('The edit target resolves outside the workspace or cannot be resolved.');
  if (isProtectedWorkspaceWriteTarget(target) || isProtectedWorkspaceWriteTarget({ path: args.file_path, relativePath: args.file_path })) return ask('Protected credentials, permission metadata and persistent instructions cannot be authorized by model review.');
  const payload = toolName === 'write' ? args.content : args.patch;
  if (typeof payload !== 'string' || (toolName === 'apply-patch' && !payload.length) || payload.includes('\0')) return ask('The edit has no complete text payload to review.');
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(args)); } catch { return ask('The edit arguments are not serializable.'); }
  if (bytes > MAX_REVIEW_BYTES) return ask('The complete edit exceeds the bounded review size. Request permission or split the edit.');
  try {
    const information = await stat(target.path);
    if (!information.isFile()) return ask('The edit target is not a regular file.');
    if (toolName === 'write') return ask('Creating a new file cannot overwrite an existing target.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || toolName === 'apply-patch') return ask('The existing edit target cannot be verified.');
  }
  return { kind: 'review', effect: 'workspace_edit', reason: 'One bounded, ordinary workspace text edit.',
    review: { toolName, target: target.path, arguments: structuredClone(args), bytes } };
}

function ask(reason: string): AutoActionDecision { return { kind: 'ask', reason }; }
