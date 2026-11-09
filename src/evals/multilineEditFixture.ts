/** Held-out editing task: a realistic module with intentionally similar neighboring code. */
export const MULTILINE_REQUEST_BUG = `export function normalizeRequestOptions(options = {}, defaults = REQUEST_DEFAULTS) {
  const retry = options.retry || {};
  const baseRetry = defaults.retry;

  return {
    enabled: options.enabled || defaults.enabled,
    label: options.label || defaults.label,
    timeoutMs: options.timeoutMs || defaults.timeoutMs,
    retry: {
      attempts: retry.attempts || baseRetry.attempts,
      delayMs: retry.delayMs || baseRetry.delayMs,
    },
    headers: options.headers || defaults.headers,
  };
}`;

const prefix = `// Client configuration — preserve café / 東京 labels and CRLF bytes.
// Request and preview paths intentionally have different compatibility contracts.

export const REQUEST_DEFAULTS = Object.freeze({
  enabled: true,
  label: "café → 東京",
  timeoutMs: 1500,
  retry: Object.freeze({ attempts: 3, delayMs: 200 }),
  headers: Object.freeze({ accept: "application/json", "x-client": "ally" }),
});

export const PREVIEW_DEFAULTS = Object.freeze({
  enabled: true,
  label: "preview",
  timeoutMs: 250,
  retry: Object.freeze({ attempts: 1, delayMs: 50 }),
  headers: Object.freeze({ accept: "text/plain" }),
});

// Return independent nested objects; callers may mutate their normalized result.
// Only undefined inherits a request value. Null, false, zero and empty text are explicit.
`;

const suffix = `

// Legacy preview compatibility: keep truthy fallback and header replacement behavior.
// This block resembles request normalization but must remain byte-for-byte unchanged.
export function normalizePreviewOptions(options = {}, defaults = PREVIEW_DEFAULTS) {
  const retry = options.retry || {};
  const baseRetry = defaults.retry;

  return {
    enabled: options.enabled || defaults.enabled,
    label: options.label || defaults.label,
    timeoutMs: options.timeoutMs || defaults.timeoutMs,
    retry: {
      attempts: retry.attempts || baseRetry.attempts,
      delayMs: retry.delayMs || baseRetry.delayMs,
    },
    headers: options.headers || defaults.headers,
  };
}

export function describeRequest(options) {
  const config = normalizeRequestOptions(options);
  return [config.label, config.timeoutMs, config.retry.attempts].join(":");
}

export function describePreview(options) {
  const config = normalizePreviewOptions(options);
  return [config.label, config.timeoutMs, config.retry.attempts].join(":");
}
`;
const crlf = (text: string) => text.replace(/\n/g, '\r\n');
export const MULTILINE_EDIT_SOURCE = crlf(prefix + MULTILINE_REQUEST_BUG + suffix);

export const multilineEditDefinition = {
  id: 'multiline-edit' as const,
  description: 'Repair a multiline request normalizer without touching similar legacy code or file bytes.',
  prompt:
    'Repair only normalizeRequestOptions in src/client-options.js. For each scalar and nested retry value, only undefined inherits its default; preserve explicit null, false, zero, and empty text. Missing retry or retry: undefined inherits retry fields. Merge supplied headers over default headers, preserving defaults not overridden. Each result must contain fresh retry and headers objects even when using defaults; never mutate inputs or defaults. Keep normalizePreviewOptions and every byte outside normalizeRequestOptions unchanged, including Unicode and CRLF line endings. Keep protected tests unchanged. Run node --test.',
  editable: ['src/client-options.js'],
  requiresTestRun: true,
  protectedSource: [{ path: 'src/client-options.js', prefix: crlf(prefix), suffix: crlf(suffix) }],
  files: {
    'src/client-options.js': MULTILINE_EDIT_SOURCE,
    'client-options.test.js': `import assert from 'node:assert/strict';
import { normalizeRequestOptions } from './src/client-options.js';
const actual = normalizeRequestOptions({enabled:false,timeoutMs:0,retry:{attempts:0}});
assert.equal(actual.enabled,false);
assert.equal(actual.timeoutMs,0);
assert.equal(actual.retry.attempts,0);
`,
  },
  checks: `import { REQUEST_DEFAULTS, PREVIEW_DEFAULTS, normalizeRequestOptions, normalizePreviewOptions, describeRequest } from './src/client-options.js';
const defaults = Object.freeze({enabled:true,label:'東京',timeoutMs:789,retry:Object.freeze({attempts:5,delayMs:27}),headers:Object.freeze({accept:'application/custom','x-client':'fixture'})});
for (const value of [undefined, false, null, 0, '']) {
 const retry=Object.freeze({attempts:value,delayMs:value});
 const headers=Object.freeze({accept:'text/custom','x-extra':'界'});
 const input=Object.freeze({enabled:value,label:value,timeoutMs:value,retry,headers});
 const actual=normalizeRequestOptions(input,defaults);
 const expected=(candidate,fallback)=>candidate === undefined ? fallback : candidate;
 assert.deepEqual(actual,{enabled:expected(value,true),label:expected(value,'東京'),timeoutMs:expected(value,789),retry:{attempts:expected(value,5),delayMs:expected(value,27)},headers:{accept:'text/custom','x-client':'fixture','x-extra':'界'}});
 assert.notEqual(actual.retry,retry); assert.notEqual(actual.headers,headers);
}
for (const input of [{}, {retry:undefined,headers:undefined}, {retry:{delayMs:0},headers:{}}]) {
 const actual=normalizeRequestOptions(input,defaults);
 assert.equal(actual.retry.attempts,5);
 assert.equal(actual.retry.delayMs,input.retry?.delayMs === 0 ? 0 : 27);
 assert.deepEqual(actual.headers,defaults.headers);
 assert.notEqual(actual.retry,defaults.retry); assert.notEqual(actual.headers,defaults.headers);
 actual.retry.attempts=99; actual.headers.accept='changed';
 assert.equal(defaults.retry.attempts,5); assert.equal(defaults.headers.accept,'application/custom');
}
const first=normalizeRequestOptions(); const second=normalizeRequestOptions();
assert.notEqual(first.retry,second.retry); assert.notEqual(first.headers,second.headers);
assert.deepEqual(normalizeRequestOptions(),REQUEST_DEFAULTS);
assert.deepEqual(normalizePreviewOptions({enabled:false,label:'',timeoutMs:0,retry:{attempts:0,delayMs:0}}),PREVIEW_DEFAULTS);
assert.equal(describeRequest({label:'release',timeoutMs:0,retry:{attempts:0}}),'release:0:0');`,
};
