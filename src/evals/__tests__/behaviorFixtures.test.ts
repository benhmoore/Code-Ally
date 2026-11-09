import { MULTILINE_EDIT_SOURCE, MULTILINE_REQUEST_BUG } from '../multilineEditFixture.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { behaviorFixtures, getBehaviorFixture, type BehaviorCaseId } from '../behaviorFixtures.js';

const MULTILINE_REPAIR = `export function normalizeRequestOptions(options = {}, defaults = REQUEST_DEFAULTS) {
  const retry = options.retry === undefined ? {} : options.retry;
  const choose = (value, fallback) => value === undefined ? fallback : value;
  return {
    enabled: choose(options.enabled, defaults.enabled),
    label: choose(options.label, defaults.label),
    timeoutMs: choose(options.timeoutMs, defaults.timeoutMs),
    retry: {
      attempts: choose(retry.attempts, defaults.retry.attempts),
      delayMs: choose(retry.delayMs, defaults.retry.delayMs),
    },
    headers: { ...defaults.headers, ...options.headers },
  };
}`;
const multilineSource = MULTILINE_EDIT_SOURCE.replace(MULTILINE_REQUEST_BUG.replace(/\n/g,'\r\n'),MULTILINE_REPAIR.replace(/\n/g,'\r\n'));

const repairs: Record<BehaviorCaseId, Record<string, string>> = {
  'multiline-edit': { 'src/client-options.js': multilineSource },
  'config-normalization': {
    'src/options.js': 'export function normalize(options = {}) { const {enabled = true, retries = 3, label = "default"} = options; return {enabled,retries,label}; }',
    'src/client.js': 'import { normalize } from "./options.js"; export function createClient(options) { const {enabled,retries,label} = normalize(options); return {active:enabled,attempts:retries,label}; }',
  },
  'path-recovery': { 'lib/text/slug.js': 'export function slug(value) { return value.trim().toLowerCase().replace(/[\\s_]+/g,"-").replace(/^-+|-+$/g, ""); }' },
  'optional-tool-discovery': { 'inventory.json': '["duration.test.js","lib/duration.js","package.json"]', 'lib/duration.js': 'export function parseDuration(value) { if (typeof value !== "string") return null; const m = /^(\\d+)(ms|s|m)$/.exec(value); return m ? Number(m[1]) * ({ms:1,s:1000,m:60000}[m[2]]) : null; }' },
  'steering-constraints': { 'lib/retry.js': 'export function retryDelay(attempt, base=100, cap=10000) { return attempt <= 0 ? 0 : Math.min(base * 2 ** (attempt-1), cap); }' },
};

describe('independently verified behavior fixtures', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
  async function setup(id: BehaviorCaseId) {
    const root = await mkdtemp(join(tmpdir(), 'ally-behavior-test-'));
    roots.push(root);
    const fixture = getBehaviorFixture(id);
    await fixture.setup(root);
    return {root, fixture};
  }
  async function repair(root: string, id: BehaviorCaseId) {
    for (const [path, source] of Object.entries(repairs[id])) await writeFile(join(root,path),source);
  }
  for (const {id} of behaviorFixtures) {
    it(`${id}: rejects the supplied bug and accepts a general repair`, async () => {
      const {root,fixture} = await setup(id);
      const initial = await fixture.verify(root);
      expect(initial.passed).toBe(false);
      expect(initial.assertions.filter(item => item.name.startsWith('protected:')).every(item => item.passed)).toBe(true);
      await repair(root,id);
      expect((await fixture.verify(root)).passed).toBe(true);
    });
    it(`${id}: rejects protected-file tampering even with repaired code`, async () => {
      const {root,fixture} = await setup(id);
      await repair(root,id);
      await writeFile(join(root,'package.json'),'{"type":"module"}');
      const result = await fixture.verify(root);
      expect(result.passed).toBe(false);
      expect(result.assertions.find(item => item.name === 'protected:package.json')?.passed).toBe(false);
    });
  }
  it('holds out a realistic CRLF module and protects similar legacy code exactly', async () => {
    const {root,fixture}=await setup('multiline-edit');
    expect(MULTILINE_EDIT_SOURCE.split('\n').length).toBeGreaterThanOrEqual(60);
    await repair(root,'multiline-edit');
    expect((await fixture.verify(root)).passed).toBe(true);
    const source=await readFile(join(root,'src/client-options.js'),'utf8');
    await writeFile(join(root,'src/client-options.js'),source.replace('// Legacy preview compatibility:', '// Changed legacy comment:'));
    const result=await fixture.verify(root);
    expect(result.passed).toBe(false);
    expect(result.assertions.find(item=>item.name==='protected-regions:src/client-options.js')?.passed).toBe(false);
  });
  it('rejects a broad truthy-fallback replacement that changes the neighboring preview normalizer', async () => {
    const {root,fixture}=await setup('multiline-edit');
    await writeFile(join(root,'src/client-options.js'),multilineSource.replaceAll('options.enabled || defaults.enabled','options.enabled ?? defaults.enabled'));
    expect((await fixture.verify(root)).passed).toBe(false);
  });
  it('rejects silently normalizing the held-out module line endings',async () => {
    const {root,fixture}=await setup('multiline-edit');
    await writeFile(join(root,'src/client-options.js'),multilineSource.replaceAll('\r\n','\n'));
    expect((await fixture.verify(root)).passed).toBe(false);
  });
  it('rejects a public-test-only hardcoded answer and ignores model-written passing tests', async () => {
    const {root,fixture} = await setup('optional-tool-discovery');
    await writeFile(join(root,'lib/duration.js'),'export function parseDuration() { return 120000; }');
    await writeFile(join(root,'duration.test.js'),'process.exit(0);');
    const result = await fixture.verify(root);
    expect(result.assertions.find(item => item.name === 'independent-behavior')?.passed).toBe(false);
    expect(result.assertions.find(item => item.name === 'protected:duration.test.js')?.passed).toBe(false);
  });
  it('rejects source that exits before trusted assertions execute', async () => {
    const {root,fixture} = await setup('path-recovery');
    await writeFile(join(root,'lib/text/slug.js'),'export function slug() {} process.exit(0);');
    expect((await fixture.verify(root)).passed).toBe(false);
  });
  it('bounds execution of a source file that never completes', async () => {
    const {root,fixture} = await setup('path-recovery');
    await writeFile(join(root,'lib/text/slug.js'),'export function slug() {} while (true) {}');
    const started = Date.now();
    const result = await fixture.verify(root);
    expect(result.passed).toBe(false);
    expect(Date.now() - started).toBeLessThan(9000);
  }, 10000);
  it('requires both modules in the multi-file repair', async () => {
    const {root,fixture} = await setup('config-normalization');
    await writeFile(join(root,'src/options.js'), repairs['config-normalization']['src/options.js']);
    expect((await fixture.verify(root)).passed).toBe(false);
  });
  it('rejects missing source without throwing and preserves repository bytes during verification', async () => {
    const {root,fixture} = await setup('path-recovery');
    const before = await readFile(join(root,'slug.test.js'));
    await rm(join(root,'lib/text/slug.js'));
    expect((await fixture.verify(root)).passed).toBe(false);
    expect(await readFile(join(root,'slug.test.js'))).toEqual(before);
  });
  it('rejects a repair that ignores the later zero-cap steering constraint', async () => {
    const {root,fixture} = await setup('steering-constraints');
    expect(fixture.steering?.afterToolCalls).toBe(1);
    await writeFile(join(root,'lib/retry.js'),'export function retryDelay(attempt,base=100,cap=10000) { return attempt <= 0 ? 0 : Math.min(base*2**(attempt-1),cap || 10000); }');
    expect((await fixture.verify(root)).passed).toBe(false);
  });
});
