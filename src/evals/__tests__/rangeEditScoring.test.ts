import { expect, it } from 'vitest';
import { ApplyPatchTool } from '../../tools/ApplyPatchTool.js';
import { ExactTextEditTool } from '../../tools/ExactTextEditTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import {
  currentHarnessEditDefinition,
  inclusiveRangeSemantics,
  RANGE_FIXTURE_SOURCE,
  RANGE_FIXTURE_EXPECTED,
  scoreRangeFixtureEdit,
} from '../rangeEditScoring.js';
import type { FunctionDefinition } from '../../types/index.js';

const exact = { file_path: 'src/range.ts', old_text: '  return end - start;', new_text: '  return end - start + 1;' };
const exactDefinition = new ExactTextEditTool(new ActivityStream()).getFunctionDefinition();
const legacyDefinition: FunctionDefinition = {
  type: 'function',
  function: {
    name: 'apply-patch',
    description: 'Historical captured schema',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, patch: { type: 'string' } },
      required: ['file_path', 'patch'],
    },
  },
};
const legacy = {
  file_path: 'src/range.ts',
  patch:
    '@@ -1,3 +1,3 @@\n export function rangeSize(start: number, end: number) {\n-  return end - start;\n+  return end - start + 1;\n }\n',
};

it('uses the unified production schema and accepts the explicit exact candidate when its schema was sent', () => {
  expect(currentHarnessEditDefinition()).toEqual(new ApplyPatchTool(new ActivityStream()).getFunctionDefinition());
  expect(scoreRangeFixtureEdit(legacy, currentHarnessEditDefinition())).toBe(true);
  expect(scoreRangeFixtureEdit({ ...legacy, show_updated_context: true }, currentHarnessEditDefinition())).toBe(true);
  expect(scoreRangeFixtureEdit(exact, exactDefinition)).toBe(true);
  expect(
    scoreRangeFixtureEdit(
      { file_path: 'src/range.ts', old_text: RANGE_FIXTURE_SOURCE, new_text: RANGE_FIXTURE_EXPECTED },
      exactDefinition
    )
  ).toBe(true);
});
it('accepts historical captured patches only under their declared schema', () => {
  expect(scoreRangeFixtureEdit(legacy, legacyDefinition)).toBe(true);
  expect(scoreRangeFixtureEdit(legacy, exactDefinition)).toBe(false);
  expect(scoreRangeFixtureEdit(exact, legacyDefinition)).toBe(false);
  expect(scoreRangeFixtureEdit(legacy, undefined)).toBe(false);
});
it.each([
  { ...exact, patch: legacy.patch },
  { ...exact, extra: true },
  { ...exact, old_text: '' },
  { ...exact, old_text: 'not in source' },
  { ...exact, new_text: exact.old_text },
  { ...exact, new_text: '  return end - start + 2;' },
  { ...exact, new_text: '  globalThis.extraEffect = true;\n  return end - start + 1;' },
  { ...exact, file_path: 'src/wrong.ts' },
  { ...exact, old_text: 3 },
])('rejects malformed, mixed, noop and semantically incorrect exact arguments: %j', args => {
  expect(scoreRangeFixtureEdit(args, exactDefinition)).toBe(false);
});
it.each([
  { ...legacy, old_text: exact.old_text },
  { ...legacy, unknown: true },
  { ...legacy, patch: 'unparseable' },
  { ...legacy, patch: '@@ -2 +2 @@\n-  return end - start;\n+  return end - start + 2;' },
  {
    ...legacy,
    patch:
      legacy.patch +
      '@@ -1 +1 @@\n-export function rangeSize(start: number, end: number) {\n+export function unrelated(start: number, end: number) {\n',
  },
])('rejects legacy edits that fail validation or alter the complete expected fixture: %j', args => {
  expect(scoreRangeFixtureEdit(args, legacyDefinition)).toBe(false);
});

it.each([
  'export function rangeSize(a:number,b:number){return ((b + 1) - a)}',
  'export function rangeSize(start:number,end:number) { const difference=end-start; return difference + 1; }',
  'function difference(a:number,b:number){return b-a;} export function rangeSize(a:number,b:number){let size=difference(a,b); for(let i=0;i<1;i++)size++; return size;}',
  'export function rangeSize(a:number,b:number){return Math.max(b-a+1,b-a+1);}',
  'const subtract=(a:number,b:number)=>b-a; export function rangeSize(a:number,b:number){if(a===b)return 1;return subtract(a,b)+1;}',
])('accepts semantically equivalent native exact replacements, not one spelling: %s', source => {
  expect(
    scoreRangeFixtureEdit(
      { file_path: 'src/range.ts', old_text: RANGE_FIXTURE_SOURCE, new_text: source },
      exactDefinition
    )
  ).toBe(true);
});

it.each([
  'export function rangeSize(a:number,b:number){return b-a;}',
  'export function rangeSize(a:number,b:number){return Math.abs(b-a)+1;}',
  'export function rangeSize(a:number,b:number){return 1;}',
  'export function rangeSize(a:number,b:number){console.log("extra");return b-a+1;}',
  'fetch("https://example.com");export function rangeSize(a:number,b:number){return b-a+1;}',
  'export function rangeSize(a:number,b:number){globalThis.extra=true;return b-a+1;}',
  'export function rangeSize(a:number,b:number){Promise.resolve().then(()=>{globalThis.extra=true;});return b-a+1;}',
  'export function rangeSize(a:number,b:number){Math.extra=1;return b-a+1;}',
  'export function rangeSize(a:number,b:number){return Function("return 1")();}',
  'export function rangeSize(a:number,b:number){while(true){} }',
  'export function rangeSize(a:number,b:number){return Promise.resolve(b-a+1);}',
  'export function rangeSize(a:number,b:number){return process.pid;}',
  'export function rangeSize( { this is invalid',
])('rejects wrong semantics, actual extra effects, unsupported host access and unbounded work: %s', source => {
  expect(inclusiveRangeSemantics(source)).toBe(false);
});
