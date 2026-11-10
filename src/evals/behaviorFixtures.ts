import { multilineEditDefinition } from './multilineEditFixture.js';
/** Small repository tasks scored with trusted, isolated behavioral checks. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export type BehaviorCaseId =
  'config-normalization' | 'path-recovery' | 'optional-tool-discovery' | 'steering-constraints' | 'multiline-edit';
export interface BehaviorAssertion {
  name: string;
  passed: boolean;
  details?: string;
}
export interface BehaviorVerification {
  passed: boolean;
  assertions: BehaviorAssertion[];
}
export interface BehaviorFixture {
  id: BehaviorCaseId;
  description: string;
  prompt: string;
  steering?: { afterToolCalls: number; message: string };
  requiredTools?: readonly string[];
  requiredFailedReadPath?: string;
  expectedFirstReadPath?: string;
  requiresTestRun?: boolean;
  setup(root: string): Promise<void>;
  verify(root: string): Promise<BehaviorVerification>;
}
interface Definition {
  id: BehaviorCaseId;
  description: string;
  prompt: string;
  steering?: BehaviorFixture['steering'];
  requiredTools?: readonly string[];
  requiredFailedReadPath?: string;
  expectedFirstReadPath?: string;
  requiresTestRun?: boolean;
  files: Record<string, string>;
  editable: string[];
  checks: string;
  absent?: string[];
  protectedSource?: Array<{ path: string; prefix: string; suffix: string }>;
}
const packageFile = '{"type":"module","scripts":{"test":"node --test"}}\n';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function fixture(definition: Definition): BehaviorFixture {
  const files = { 'package.json': packageFile, ...definition.files };
  const protectedPaths = Object.keys(files).filter(path => !definition.editable.includes(path)).sort();
  return {
    id: definition.id,
    description: definition.description,
    prompt: `${definition.prompt}\nProtected existing files (keep unchanged): ${protectedPaths.join(', ')}.`,
    ...(definition.steering ? { steering: definition.steering } : {}),
    ...(definition.requiredTools ? { requiredTools: definition.requiredTools } : {}),
    ...(definition.requiredFailedReadPath ? { requiredFailedReadPath: definition.requiredFailedReadPath } : {}),
    ...(definition.expectedFirstReadPath ? { expectedFirstReadPath: definition.expectedFirstReadPath } : {}),
    ...(definition.requiresTestRun ? { requiresTestRun: true } : {}),
    async setup(root) {
      for (const [path, contents] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), contents);
      }
    },
    async verify(root) {
      const assertions: BehaviorAssertion[] = [];
      for (const [path, contents] of Object.entries(files)) {
        if (definition.editable.includes(path)) continue;
        const actual = await readFile(join(root, path), 'utf8').catch(() => null);
        assertions.push({ name: `protected:${path}`, passed: actual !== null && digest(actual) === digest(contents) });
      }
      for (const path of definition.absent ?? []) {
        const exists = await readFile(join(root, path)).then(
          () => true,
          error => (error as NodeJS.ErrnoException).code !== 'ENOENT'
        );
        assertions.push({ name: `absent:${path}`, passed: !exists });
      }
      for (const region of definition.protectedSource ?? []) {
        const source = await readFile(join(root,region.path),'utf8').catch(()=>'');
        assertions.push({name:`protected-regions:${region.path}`,passed:source.startsWith(region.prefix) && source.endsWith(region.suffix)});
      }
      const isolated = await mkdtemp(join(tmpdir(), 'ally-behavior-verify-'));
      try {
        await writeFile(join(isolated, 'package.json'), packageFile);
        for (const path of definition.editable) {
          const source = await readFile(join(root, path), 'utf8').catch(() => '');
          await mkdir(dirname(join(isolated, path)), { recursive: true });
          await writeFile(join(isolated, path), source);
        }
        await writeFile(
          join(isolated, 'trusted.test.js'),
          `import assert from 'node:assert/strict';\n${definition.checks}\nconsole.log('ALLY_TRUSTED_CHECKS_COMPLETED');\n`
        );
        try {
          const output = await promisify(execFile)(process.execPath, ['--test', 'trusted.test.js'], {
            cwd: isolated,
            timeout: 5000,
            maxBuffer: 128 * 1024,
          });
          assertions.push({
            name: 'independent-behavior',
            passed: output.stdout.includes('ALLY_TRUSTED_CHECKS_COMPLETED'),
          });
        } catch (error) {
          const failure = error as Error & { stdout?: string; stderr?: string };
          assertions.push({
            name: 'independent-behavior',
            passed: false,
            details: `${failure.message}\n${failure.stdout ?? ''}${failure.stderr ?? ''}`.slice(0, 8000),
          });
        }
      } finally {
        await rm(isolated, { recursive: true, force: true });
      }
      return { passed: assertions.every(assertion => assertion.passed), assertions };
    },
  };
}

/** Minimal host observations; argument text alone never proves a failed file read. */
export interface BehaviorToolObservation {
  phase: 'start' | 'end';
  owner: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  success?: boolean;
  errorType?: string;
}
export function verifyFixtureReadRequirements(
  requirements: Pick<BehaviorFixture, 'requiredFailedReadPath' | 'expectedFirstReadPath'>,
  observations: readonly BehaviorToolObservation[],
  workspace: string
): BehaviorAssertion[] {
  const reads = observations.filter(event => event.owner === 'main' && event.toolName === 'read');
  const matches = (event: BehaviorToolObservation, path: string) =>
    typeof event.arguments?.file_path === 'string' && resolve(workspace, event.arguments.file_path) === resolve(workspace, path);
  const assertions: BehaviorAssertion[] = [];
  if (requirements.requiredFailedReadPath) {
    const path = requirements.requiredFailedReadPath;
    assertions.push({ name: `required-failed-read:${path}`, passed: reads.some(event =>
      event.phase === 'end' && event.success === false && event.errorType === 'file_error' && matches(event,path)) });
  }
  if (requirements.expectedFirstReadPath) {
    const path = requirements.expectedFirstReadPath;
    const first = reads.find(event => event.phase === 'start');
    assertions.push({ name: `first-read:${path}`, passed: !!first && matches(first,path) });
  }
  return assertions;
}

export const behaviorFixtures: readonly BehaviorFixture[] = [
  fixture(multilineEditDefinition),
  fixture({
    id: 'config-normalization',
    requiresTestRun: true,
    description: 'Repair option precedence and downstream configuration across two modules.',
    prompt:
      'Repair src/options.js and src/client.js. Explicit false, zero, and empty string must override defaults; only undefined falls back. Client configuration must use normalized retries and enabled, and expose label unchanged. Preserve input objects and protected files. Run the available tests.',
    editable: ['src/options.js', 'src/client.js'],
    files: {
      'src/options.js':
        'export function normalize(options = {}) { return { enabled: options.enabled || true, retries: options.retries || 3, label: options.label || "default" }; }\n',
      'src/client.js':
        'import { normalize } from "./options.js";\nexport function createClient(options) { const config = normalize(options); return { attempts: 3, active: true, label: config.label }; }\n',
      'options.test.js':
        'import assert from "node:assert/strict";\nimport { normalize } from "./src/options.js";\nassert.equal(normalize({enabled:false}).enabled, false);\n',
    },
    checks: `import { normalize } from './src/options.js';
import { createClient } from './src/client.js';
const fallback = (value, defaultValue) => value === undefined ? defaultValue : value;
for (const enabled of [undefined, false, true, null]) for (const retries of [undefined, 0, 1, 7, null]) for (const label of [undefined, '', 'alpha', 'beta', null]) {
 const options = Object.freeze({enabled,retries,label});
 const expected = {enabled:fallback(enabled,true),retries:fallback(retries,3),label:fallback(label,'default')};
 assert.deepEqual(normalize(options), expected);
 assert.deepEqual(createClient(options), {active:expected.enabled,attempts:expected.retries,label:expected.label});
}
for (const options of [{}, {enabled:null}, {retries:null}, {label:null}, {enabled:undefined,retries:null,label:''}, {enabled:false,retries:undefined,label:null}]) {
 const before = structuredClone(options);
 const expected = {enabled:fallback(options.enabled,true),retries:fallback(options.retries,3),label:fallback(options.label,'default')};
 assert.deepEqual(normalize(options), expected);
 assert.deepEqual(createClient(options), {active:expected.enabled,attempts:expected.retries,label:expected.label});
 assert.deepEqual(options, before);
}
assert.deepEqual(normalize(), {enabled:true,retries:3,label:'default'});
assert.deepEqual(createClient(), {active:true,attempts:3,label:'default'});
assert.deepEqual(createClient({retries:2}), {active:true,attempts:2,label:'default'});`,
  }),
  fixture({
    id: 'path-recovery',
    requiredFailedReadPath: 'src/utils/slug.js',
    expectedFirstReadPath: 'src/utils/slug.js',
    description: 'Recover from a stale path by finding the real implementation.',
    prompt:
      'Fix the slug helper reportedly at src/utils/slug.js: trim surrounding whitespace, lowercase, collapse runs of whitespace or underscores to one hyphen, and remove leading/trailing hyphens. Read that exact reported path first. If it is missing, locate the actual implementation and continue the repair. Do not create a replacement at the stale path or change protected files.',
    editable: ['lib/text/slug.js'],
    absent: ['src/utils/slug.js'],
    files: {
      'README.md': 'Text helpers live under lib/text. The old src/utils location was removed.\n',
      'lib/text/slug.js': 'export function slug(value) { return value.toLowerCase().replace(" ", "-"); }\n',
      'slug.test.js':
        'import assert from "node:assert/strict";\nimport { slug } from "./lib/text/slug.js";\nassert.equal(slug(" Hello World "), "hello-world");\n',
    },
    checks: `import { slug } from './lib/text/slug.js';
for (const [input, expected] of [[' Hello World ','hello-world'],['A___B  C','a-b-c'],['___A___','a'],['  ',''],['foo','foo'],['A\\tB\\nC','a-b-c']]) assert.equal(slug(input), expected);`,
  }),
  fixture({
    id: 'optional-tool-discovery',
    description: 'Discover the deferred tree tool and repair strict duration parsing.',
    prompt:
      'Discover and use the tree tool to inspect this repository. Write inventory.json as a JSON array of all initial repository file paths, sorted lexicographically, excluding inventory.json itself and node_modules. Locate parseDuration and repair the parser so strings consist of a nonnegative integer followed by ms, s, or m; reject malformed input with null, preserve zero, and convert to milliseconds. Preserve protected files.',
    editable: ['lib/duration.js', 'inventory.json'],
    requiredTools: ['tree'],
    files: {
      'lib/duration.js': 'export function parseDuration(value) { return parseInt(value, 10) * 1000 || null; }\n',
      'duration.test.js':
        'import assert from "node:assert/strict";\nimport { parseDuration } from "./lib/duration.js";\nassert.equal(parseDuration("2m"), 120000);\n',
    },
    checks: `import { readFileSync } from 'node:fs';
import { parseDuration } from './lib/duration.js';
assert.deepEqual(JSON.parse(readFileSync(new URL('./inventory.json', import.meta.url), 'utf8')), ['duration.test.js','lib/duration.js','package.json']);
for (const n of [0,1,2,19,127]) for (const [unit, factor] of [['ms',1],['s',1000],['m',60000]]) assert.equal(parseDuration(String(n)+unit), n*factor);
for (const input of ['', '2', '-1s', '1.5s', '2msjunk', ' 2s', '2s ', '2h', null, undefined, 5]) assert.equal(parseDuration(input), null);`,
  }),
  fixture({
    id: 'steering-constraints',
    description: 'Honor a mid-task restriction while repairing retry semantics.',
    prompt:
      'Repair retryDelay in lib/retry.js. Attempt zero must return zero; positive attempts use base * 2 ** (attempt - 1), capped by cap. Preserve public API and protected files. Inspect the repository before editing.',
    steering: {
      afterToolCalls: 1,
      message:
        'Additional constraint: do not edit policy.json or any tests. Keep negative attempts clamped to zero and support a zero cap. Apply the fix only in lib/retry.js.',
    },
    editable: ['lib/retry.js'],
    files: {
      'lib/retry.js':
        'export function retryDelay(attempt, base = 100, cap = 10000) { return Math.min(base * 2 ** attempt, cap || 10000); }\n',
      'policy.json': '{"negativeAttempts":"zero","zeroCapAllowed":true}\n',
      'retry.test.js':
        'import assert from "node:assert/strict";\nimport { retryDelay } from "./lib/retry.js";\nassert.equal(retryDelay(0), 0);\n',
    },
    checks: `import { retryDelay } from './lib/retry.js';
for (const base of [0,5,100]) for (const cap of [0,20,10000]) for (const attempt of [-3,0,1,2,5,10]) assert.equal(retryDelay(attempt,base,cap), attempt <= 0 ? 0 : Math.min(base * 2 ** (attempt-1),cap));
assert.equal(retryDelay(1),100); assert.equal(retryDelay(20),10000);`,
  }),
];

export function getBehaviorFixture(id: BehaviorCaseId): BehaviorFixture {
  const result = behaviorFixtures.find(candidate => candidate.id === id);
  if (!result) throw new Error(`Unknown behavior fixture: ${id}`);
  return result;
}
