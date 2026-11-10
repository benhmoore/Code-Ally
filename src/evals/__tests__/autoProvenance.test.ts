import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { collectAutoProvenance } from '../autoProvenance.js';

const options = { endpoint: 'http://fixture', reviewer: 'reviewer:4b', runs: 3, output: 'results.json' };
const catalogue = { models: [{ name: 'reviewer:4b', digest: 'a'.repeat(64) }] };
const show = {
  capabilities: ['decision'],
  model_info: { 'general.architecture': 'fixture' },
  parameters: 'num_ctx 2048',
};

it('captures exact source hashes and metadata without inference, redirects or credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-provenance-'));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(
      String(url).endsWith('/api/version')
        ? { version: 'fixture-version' }
        : String(url).endsWith('/api/tags')
          ? catalogue
          : show
    );
  };
  try {
    for (const dir of ['src/evals', 'src/security', 'src/services']) await mkdir(join(root, dir), { recursive: true });
    for (const path of [
      'src/evals/autoBehavior.ts',
      'src/evals/autoProvenance.ts',
      'src/services/PermissionPolicyService.ts',
      'src/security/policy.ts',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
    ])
      await writeFile(join(root, path), 'initial');
    const first = await collectAutoProvenance(options, root, fetcher);
    expect(first).toMatchObject({
      ollamaVersion: 'fixture-version',
      reviewer: { digest: 'a'.repeat(64), show },
      nodeVersion: process.version,
    });
    expect(first.git.available).toBe(false);
    expect(calls.map(call => call.url)).toEqual([
      'http://fixture/api/version',
      'http://fixture/api/tags',
      'http://fixture/api/show',
    ]);
    expect(
      calls.every(
        call => call.init?.redirect === 'error' && !('Authorization' in (call.init.headers as Record<string, string>))
      )
    ).toBe(true);
    const same = await collectAutoProvenance(options, root, fetcher);
    expect(same.sources.productionPolicySha256).toBe(first.sources.productionPolicySha256);
    expect(same.sources.sourceTreeSha256).toBe(first.sources.sourceTreeSha256);
    await writeFile(join(root, 'package-lock.json'), 'changed dependencies');
    const lockChanged = await collectAutoProvenance(options, root, fetcher);
    expect(lockChanged.sources.sourceTreeSha256).not.toBe(first.sources.sourceTreeSha256);
    expect(lockChanged.sources.productionPolicySha256).toBe(first.sources.productionPolicySha256);
    expect(lockChanged.sources.evaluatorSha256).toBe(first.sources.evaluatorSha256);
    await writeFile(join(root, 'src/security/policy.ts'), 'changed');
    const changed = await collectAutoProvenance(options, root, fetcher);
    expect(changed.sources.productionPolicySha256).not.toBe(first.sources.productionPolicySha256);
    expect(changed.sources.evaluatorSha256).toBe(first.sources.evaluatorSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { name: 'unavailable version', route: '/api/version', body: {} },
  { name: 'missing digest', route: '/api/tags', body: { models: [{ name: 'reviewer:4b' }] } },
  { name: 'remote reviewer', route: '/api/tags', body: { models: [{ ...catalogue.models[0], remote_host: 'cloud' }] } },
  { name: 'nondecision model', route: '/api/show', body: { ...show, capabilities: ['completion'] } },
])('fails explicitly on $name rather than fabricating deployment identity', async ({ route, body }) => {
  const fetcher = vi.fn(async (url: any) =>
    Response.json(
      String(url).endsWith(route)
        ? body
        : String(url).endsWith('/api/version')
          ? { version: 'fixture-version' }
          : catalogue
    )
  );
  await expect(
    collectAutoProvenance(options, '/not-used-before-metadata-validation', fetcher as typeof fetch)
  ).rejects.toThrow('Auto provenance preflight failed');
});

it('rejects credential-bearing endpoints before making any request', async () => {
  const fetcher = vi.fn();
  await expect(
    collectAutoProvenance({ ...options, endpoint: 'http://secret:key@fixture' }, '/', fetcher)
  ).rejects.toThrow('preflight failed');
  expect(fetcher).not.toHaveBeenCalled();
});
