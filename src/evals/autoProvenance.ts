/** Deployment identity for permission experiments; metadata calls never request inference. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

interface ProvenanceOptions {
  endpoint: string;
  reviewer: string;
  runs: number;
  output: string;
}
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

async function metadata(endpoint: string, route: string, fetcher: typeof fetch, body?: unknown): Promise<any> {
  const response = await fetcher(`${endpoint}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${route} returned an empty body`);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 1024 * 1024) throw new Error(`${route} metadata exceeds 1 MiB`);
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Complete sorted source manifest, plus exact evaluator and production-policy subsets. */
async function sourceIdentity(root: string) {
  const files: Array<{ path: string; sha256: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.push({ path: relative(root, file), sha256: digest(await readFile(file)) });
    }
  };
  await walk(join(root, 'src'));
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json'])
    files.push({ path: file, sha256: digest(await readFile(join(root, file))) });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const evaluator = files.filter(file =>
    ['src/evals/autoBehavior.ts', 'src/evals/autoProvenance.ts'].includes(file.path)
  );
  const policy = files.filter(
    file =>
      file.path === 'src/services/PermissionPolicyService.ts' ||
      (file.path.startsWith('src/security/') && !file.path.includes('/__tests__/'))
  );
  if (evaluator.length !== 2 || !policy.some(file => file.path === 'src/services/PermissionPolicyService.ts'))
    throw new Error('Evaluator or production-policy sources are missing');
  return {
    sourceTreeSha256: digest(JSON.stringify(files)),
    sourceFiles: files,
    evaluatorSha256: digest(JSON.stringify(evaluator)),
    evaluatorFiles: evaluator,
    productionPolicySha256: digest(JSON.stringify(policy)),
    productionPolicyFiles: policy,
  };
}

async function gitIdentity(root: string) {
  try {
    const head = await promisify(execFile)('git', ['-C', root, 'rev-parse', 'HEAD'], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const status = await promisify(execFile)('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], {
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { available: true, head: head.stdout.trim(), dirty: status.stdout.length > 0, porcelain: status.stdout };
  } catch (error) {
    return { available: false, error: String(error) };
  }
}

export async function collectAutoProvenance(
  options: ProvenanceOptions,
  sourceRoot: string,
  fetcher: typeof fetch = fetch
) {
  try {
    const endpoint = new URL(options.endpoint);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== '/' ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error('Metadata endpoint must be an HTTP(S) origin without credentials, path, query or fragment');
    // Same explicit endpoint and no credentials as this evaluator's policy client.
    // Redirects are forbidden, so credentials cannot be forwarded to another origin.
    const version = await metadata(options.endpoint, '/api/version', fetcher);
    if (typeof version.version !== 'string' || !version.version.trim()) throw new Error('Ollama version is missing');
    const tags = await metadata(options.endpoint, '/api/tags', fetcher);
    if (!Array.isArray(tags.models)) throw new Error('Model catalogue is missing');
    const matches = tags.models.filter((model: any) =>
      [options.reviewer, `${options.reviewer}:latest`].includes(model.name ?? model.model)
    );
    if (
      matches.length !== 1 ||
      typeof matches[0].digest !== 'string' ||
      !/^(sha256:)?[a-f0-9]{64}$/i.test(matches[0].digest)
    )
      throw new Error('Reviewer must resolve to one catalogue entry with a SHA-256 digest');
    const model = matches[0];
    if (model.remote_model || model.remote_host) throw new Error('Reviewer catalogue entry is remote');
    const show = await metadata(options.endpoint, '/api/show', fetcher, { model: model.name ?? model.model });
    if (
      !Array.isArray(show.capabilities) ||
      !show.capabilities.includes('decision') ||
      !show.model_info ||
      typeof show.model_info !== 'object'
    )
      throw new Error('Reviewer decision capability or model metadata is missing');
    return {
      capturedAt: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      options: structuredClone(options),
      ollamaVersion: version.version,
      reviewer: {
        requested: options.reviewer,
        resolved: model.name ?? model.model,
        digest: model.digest,
        tag: model,
        show,
      },
      sources: await sourceIdentity(sourceRoot),
      git: await gitIdentity(sourceRoot),
    };
  } catch (error) {
    throw new Error(`Auto provenance preflight failed: ${String(error)}`, { cause: error });
  }
}
