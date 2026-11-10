/** Apply the sent schema in memory, then execute a bounded generated-code benchmark. */
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { ApplyPatchTool } from '../tools/ApplyPatchTool.js';
import { ToolValidator } from '../tools/ToolValidator.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { prepareExactTextEdit } from '../utils/exactTextEdit.js';
import { applyModelPatch } from '../utils/patchApplier.js';
import type { FunctionDefinition } from '../types/index.js';

export const RANGE_FIXTURE_SOURCE =
  'export function rangeSize(start: number, end: number) {\n  return end - start;\n}\n';
export const RANGE_FIXTURE_EXPECTED =
  'export function rangeSize(start: number, end: number) {\n  return end - start + 1;\n}\n';
const editTool = new ApplyPatchTool(new ActivityStream());

// This is a resource-bounded execution boundary, NOT an OS security sandbox or
// proof of purity. Candidate code gets VM intrinsics and module-local helpers,
// but no host callbacks, IO, timers or dynamic code generation. Surviving global
// binding changes fail; this does not prove absence of every private side effect.
const ORACLE_CHILD = String.raw`
const vm = require('node:vm');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
try {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: {strings:false, wasm:false}, microtaskMode:'afterEvaluate'
  });
  const run = code => new vm.Script(code).runInContext(context, {timeout:100});
  run('globalThis.exports=Object.create(null);'+
    'for(const key of ["console","fetch","require","process","setTimeout","setInterval","queueMicrotask","WebAssembly"]) globalThis[key]=undefined;'+
    'for(const key of ["Object","Array","Math","Function","JSON","Number","String","Boolean","RegExp","Reflect"]) {'+
      'const value=globalThis[key]; if(value.prototype) Object.freeze(value.prototype); Object.freeze(value);'+
      'Object.defineProperty(globalThis,key,{value,writable:false,configurable:false});}'+
    'Object.defineProperty(globalThis,"globalThis",{value:globalThis,writable:false,configurable:false});'+
    'const __rangeOracleGlobals=Object.getOwnPropertyDescriptors(globalThis);');
  run('(function(exports){"use strict";\n'+input.javascript+'\n})(exports);');
  const ok = run('typeof exports.rangeSize==="function" && '+
    JSON.stringify(input.cases)+'.every(([start,end])=>{'+
      'const value=exports.rangeSize(start,end);return typeof value==="number" && value===end-start+1;})');
  const clean = run(
    'Object.getOwnPropertyNames(globalThis).length===Object.keys(__rangeOracleGlobals).length && '+
    'Object.keys(__rangeOracleGlobals).every(key=>{const before=__rangeOracleGlobals[key];'+
      'const after=Object.getOwnPropertyDescriptor(globalThis,key);return after && '+
      '["value","get","set","writable","enumerable","configurable"].every(field=>Object.is(before[field],after[field]));})');
  process.stdout.write(ok === true && clean === true ? '1' : '0');
} catch { process.stdout.write('0'); }
`;

/** Finite semantic checks accept equivalent implementations; they are not a proof for every number. */
export function inclusiveRangeSemantics(source: string): boolean {
  if (Buffer.byteLength(source, 'utf8') > 256 * 1024) return false;
  const compiled = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  if (compiled.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) return false;
  const points = [-100, -7, -1, -0.5, 0, 0.25, 1, 3.5, 8, 100];
  const cases = points.flatMap(start => points.map(end => [start, end]));
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', ORACLE_CHILD], {
    input: JSON.stringify({ javascript: compiled.outputText, cases }),
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 64 * 1024,
    env: {},
  });
  return !result.error && result.status === 0 && result.stdout === '1';
}

/** Production remains the authoritative current synthetic/lean interface. */
export function currentHarnessEditDefinition(): FunctionDefinition {
  return editTool.getFunctionDefinition();
}

export function scoreRangeFixtureEdit(args: unknown, definition: FunctionDefinition | undefined): boolean {
  if (
    !definition ||
    definition.function.name !== 'apply-patch' ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args)
  )
    return false;
  const values = args as Record<string, unknown>;
  const schema = definition.function.parameters;
  const properties = schema.properties;
  const required = schema.required ?? [];
  if (!properties || Object.keys(values).some(key => !Object.hasOwn(properties, key))) return false;
  const exact =
    properties.old_text?.type === 'string' &&
    properties.new_text?.type === 'string' &&
    required.includes('old_text') &&
    required.includes('new_text') &&
    !properties.patch;
  const legacy =
    properties.patch?.type === 'string' && required.includes('patch') && !properties.old_text && !properties.new_text;
  if ((!exact && !legacy) || properties.file_path?.type !== 'string' || !required.includes('file_path')) return false;
  const allowed = exact ? ['file_path', 'old_text', 'new_text'] : ['file_path', 'patch'];
  if (Object.keys(values).some(key => !allowed.includes(key))) return false;
  if (!new ToolValidator().validateArguments(editTool, definition, values).valid) return false;
  const file = (values.file_path as string).replaceAll('\\', '/');
  const marker = file.lastIndexOf('/Code-Ally/');
  if ((marker >= 0 ? file.slice(marker + '/Code-Ally/'.length) : file.replace(/^\.\//, '')) !== 'src/range.ts')
    return false;
  try {
    const result = exact
      ? prepareExactTextEdit(RANGE_FIXTURE_SOURCE, values.old_text as string, values.new_text as string)
      : applyModelPatch(values.patch as string, RANGE_FIXTURE_SOURCE);
    return result.success && typeof result.content === 'string' && inclusiveRangeSemantics(result.content);
  } catch {
    return false;
  }
}
