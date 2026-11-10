import { MULTILINE_EDIT_SOURCE, MULTILINE_REQUEST_BUG } from '../multilineEditFixture.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { behaviorFixtures, getBehaviorFixture, type BehaviorCaseId, verifyFixtureReadRequirements, type BehaviorToolObservation } from '../behaviorFixtures.js';

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
  it('declares the same protected existing files it hashes without disclosing repair targets', async () => {
    for (const definition of behaviorFixtures) {
      const {root,fixture} = await setup(definition.id);
      const result = await fixture.verify(root);
      const protectedFiles = result.assertions.filter(item => item.name.startsWith('protected:')).map(item => item.name.slice('protected:'.length)).sort();
      expect(fixture.prompt.split('Protected existing files (keep unchanged): ')[1]).toBe(`${protectedFiles.join(', ')}.`);
    }
    const recovery = getBehaviorFixture('path-recovery');
    expect(recovery.prompt).not.toContain('lib/text/slug.js');
    expect(recovery.prompt).toContain('README.md, package.json, slug.test.js');
  });
  it.each(['enabled', 'retries', 'label'])('rejects nullish fallback for explicitly null %s', async field => {
    const {root,fixture} = await setup('config-normalization');
    await repair(root,'config-normalization');
    const defaults = {enabled:'true', retries:'3', label:'"default"'};
    await writeFile(join(root,'src/options.js'), `export function normalize(options = {}) { const {enabled=true,retries=3,label="default"}=options; return {enabled,retries,label,${field}:options.${field} ?? ${defaults[field]}}; }`);
    expect((await fixture.verify(root)).assertions.find(item => item.name === 'independent-behavior')?.passed).toBe(false);
  });
  it('independently rejects client propagation that discards null after correct normalization', async () => {
    const {root,fixture} = await setup('config-normalization');
    await repair(root,'config-normalization');
    await writeFile(join(root,'src/client.js'),'import { normalize } from "./options.js"; export function createClient(options) { const {enabled,retries,label}=normalize(options); return {active:enabled ?? true,attempts:retries ?? 3,label:label ?? "default"}; }');
    expect((await fixture.verify(root)).passed).toBe(false);
  });
  it.each(['normalize', 'client'])('rejects %s mutating the input object while computing otherwise correct values', async stage => {
    const {root,fixture} = await setup('config-normalization');
    await repair(root,'config-normalization');
    const path = stage === 'normalize' ? 'src/options.js' : 'src/client.js';
    const source = repairs['config-normalization'][path]!;
    await writeFile(join(root,path),source.replace('const {enabled','if (options) options.added = true; const {enabled'));
    expect((await fixture.verify(root)).passed).toBe(false);
  });
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

describe('host-observed required stale reads', () => {
  const requirements = getBehaviorFixture('path-recovery');
  const observation = (phase: 'start'|'end', file_path: string, success?: boolean, errorType?: string, owner='main'): BehaviorToolObservation => ({
    phase, owner, toolName:'read', arguments:{file_path}, success, errorType,
  });
  it('requires the first main read to target the declared stale path and an actual file-read error at that path', () => {
    const events = [observation('start','src/utils/slug.js'), observation('end','/workspace/src/utils/slug.js',false,'file_error'), observation('start','lib/text/slug.js')];
    expect(verifyFixtureReadRequirements(requirements,events,'/workspace').every(item=>item.passed)).toBe(true);
  });
  it.each([
    [observation('start','other.js'), observation('end','other.js',false,'file_error')],
    [observation('start','src/utils/slug.js'), observation('end','src/utils/slug.js',false,'validation_error')],
    [observation('start','src/utils/slug.js'), observation('end','src/utils/slug.js',true)],
    [observation('start','lib/text/slug.js'), observation('start','src/utils/slug.js'), observation('end','src/utils/slug.js',false,'file_error')],
    [observation('start','src/utils/slug.js',undefined,undefined,'delegate'), observation('end','src/utils/slug.js',false,'file_error','delegate')],
  ])('rejects unrelated, invalid, successful, out-of-order, or child-only reads: %j', (...events) => {
    expect(verifyFixtureReadRequirements(requirements,events,'/workspace').every(item=>item.passed)).toBe(false);
  });
  it('adds no read constraints to fixtures that do not declare them', () => {
    expect(verifyFixtureReadRequirements({},[],'/workspace')).toEqual([]);
  });
});
