import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface AcceptanceCriterion {
  id: string;
  description: string;
  /** Exact foreground bash command whose successful execution verifies this criterion. */
  command: string;
  artifacts: string[];
}
export interface ArchitectureUpdate {
  criteria?: AcceptanceCriterion[];
  constraints?: string[];
  decisions?: Array<{ decision: string; rationale: string }>;
  assumptions?: string[];
  nextActions?: string[];
}
export interface VerificationEvidence {
  criterionId: string;
  definitionHash: string;
  artifactHashes: Record<string, string>;
  callId: string;
  timestamp: number;
  success: boolean;
  unchanged: boolean;
}
export interface ObjectiveArchitecture {
  criteria: AcceptanceCriterion[];
  constraints: string[];
  decisions: Array<{ decision: string; rationale: string }>;
  assumptions: string[];
  nextActions: string[];
  evidence: VerificationEvidence[];
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const criterionHash = (criterion: AcceptanceCriterion): string => digest(JSON.stringify([
  criterion.id, criterion.description, criterion.command, [...criterion.artifacts].sort(),
]));

function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000) throw new Error('Architecture text must contain 1–8000 characters');
}
function textList(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Architecture lists must contain at most 100 entries');
  value.forEach(text);
}

/** Validate both live updates and journal replay; criteria cannot silently disappear. */
export function updateArchitecture(previous: ObjectiveArchitecture | undefined, update: ArchitectureUpdate): ObjectiveArchitecture {
  if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('Invalid architecture update');
  const next = structuredClone(previous ?? { criteria: [], constraints: [], decisions: [], assumptions: [], nextActions: [], evidence: [] });
  for (const key of ['constraints', 'assumptions', 'nextActions'] as const) {
    if (update[key] === undefined) continue;
    textList(update[key]);
    next[key] = key === 'nextActions' ? [...update[key]] : [...new Set([...next[key], ...update[key]])];
    if (next[key].length > 100) throw new Error(`Too many ${key}`);
  }
  if (update.decisions !== undefined) {
    if (!Array.isArray(update.decisions) || update.decisions.length > 100) throw new Error('Too many decisions');
    for (const entry of update.decisions) {
      text(entry?.decision); text(entry?.rationale);
      if (!next.decisions.some(item => item.decision === entry.decision && item.rationale === entry.rationale)) next.decisions.push({ ...entry });
    }
    if (next.decisions.length > 100) throw new Error('Too many decisions');
  }
  if (update.criteria !== undefined) {
    if (!Array.isArray(update.criteria) || update.criteria.length > 100) throw new Error('Too many acceptance criteria');
    const byId = new Map(next.criteria.map(criterion => [criterion.id, criterion]));
    for (const criterion of update.criteria) {
      text(criterion?.id); text(criterion?.description); text(criterion?.command); textList(criterion?.artifacts);
      if (!criterion.artifacts.length) throw new Error('Each criterion must name the source and test artifacts it verifies');
      for (const artifact of criterion.artifacts) {
        if (path.isAbsolute(artifact) || artifact.split(/[\\/]/).includes('..')) throw new Error('Artifacts must be relative paths within the project');
      }
      byId.set(criterion.id, { ...criterion, artifacts: [...new Set(criterion.artifacts)] });
    }
    if (byId.size > 100) throw new Error('Too many acceptance criteria');
    next.criteria = [...byId.values()];
    if (new Set(next.criteria.flatMap(criterion => criterion.artifacts)).size > 256) throw new Error('At most 256 distinct artifacts can be tracked per objective');
  }
  return next;
}

/** Hash only declared artifacts, without following links outside the workspace. */
export async function artifactHashes(root: string, artifacts: readonly string[]): Promise<Record<string, string>> {
  const realRoot = await fs.realpath(root);
  const hashes: Record<string, string> = {};
  for (const artifact of [...new Set(artifacts)].sort()) {
    const candidate = path.resolve(realRoot, artifact);
    const relative = path.relative(realRoot, candidate);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Artifact escapes the project');
    let actual: string;
    try { actual = await fs.realpath(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hashes[artifact] = 'missing';
      continue;
    }
    const actualRelative = path.relative(realRoot, actual);
    if (actualRelative.startsWith(`..${path.sep}`) || actualRelative === '..' || path.isAbsolute(actualRelative)) throw new Error('Artifact link escapes the project');
    const stat = await fs.stat(actual);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error(`Artifact must be a regular file of at most 16 MiB: ${artifact}`);
    hashes[artifact] = digest(await fs.readFile(actual));
  }
  return hashes;
}

export interface PreparedVerification {
  criterionId: string;
  definitionHash: string;
  artifactHashes: Record<string, string>;
}
export async function prepareVerification(
  root: string, architecture: ObjectiveArchitecture | undefined, tool: string, args: Record<string, unknown>,
): Promise<PreparedVerification[]> {
  if (tool !== 'bash' || args.run_in_background === true) return [];
  const matching = architecture?.criteria.filter(criterion => criterion.command === args.command) ?? [];
  if (!matching.length) return [];
  const effectiveDirectory = path.resolve(typeof args.working_dir === 'string' ? args.working_dir : process.cwd());
  if (await fs.realpath(effectiveDirectory) !== await fs.realpath(root)) return [];
  const prepared: PreparedVerification[] = [];
  for (const criterion of matching) prepared.push({
    criterionId: criterion.id, definitionHash: criterionHash(criterion),
    artifactHashes: await artifactHashes(root, criterion.artifacts),
  });
  return prepared;
}

export async function settleVerification(root: string, prepared: PreparedVerification[], callId: string, success: boolean): Promise<VerificationEvidence[]> {
  const evidence: VerificationEvidence[] = [];
  for (const entry of prepared) {
    let unchanged = false;
    try { unchanged = JSON.stringify(entry.artifactHashes) === JSON.stringify(await artifactHashes(root, Object.keys(entry.artifactHashes))); }
    catch { /* An unreadable or changed artifact cannot support verification. */ }
    evidence.push({ ...entry, callId, timestamp: Date.now(), success, unchanged });
  }
  return evidence;
}

export async function inspectArchitecture(root: string, state: ObjectiveArchitecture): Promise<Array<AcceptanceCriterion & { status: 'pending' | 'verified' | 'stale' | 'failed'; evidence?: VerificationEvidence }>> {
  return Promise.all(state.criteria.map(async criterion => {
    const evidence = [...state.evidence].reverse().find(item => item.criterionId === criterion.id);
    if (!evidence) return { ...criterion, status: 'pending' as const };
    if (!evidence.success) return { ...criterion, evidence, status: 'failed' as const };
    let current = false;
    try { current = JSON.stringify(evidence.artifactHashes) === JSON.stringify(await artifactHashes(root, criterion.artifacts)); }
    catch { /* Treat unreadable evidence as stale. */ }
    return { ...criterion, evidence, status: evidence.unchanged && current && evidence.definitionHash === criterionHash(criterion) ? 'verified' as const : 'stale' as const };
  }));
}

export function applyVerification(state: ObjectiveArchitecture, value: unknown): void {
  if (!Array.isArray(value)) throw new Error('Invalid verification evidence');
  for (const record of value as VerificationEvidence[]) {
    text(record?.criterionId); text(record?.definitionHash); text(record?.callId);
    if (!Number.isFinite(record.timestamp) || typeof record.success !== 'boolean' || typeof record.unchanged !== 'boolean'
      || !record.artifactHashes || typeof record.artifactHashes !== 'object' || Array.isArray(record.artifactHashes)
      || Object.values(record.artifactHashes).some(hash => typeof hash !== 'string')) throw new Error('Invalid verification record');
    state.evidence = [...state.evidence.filter(item => item.criterionId !== record.criterionId), structuredClone(record)];
  }
}
