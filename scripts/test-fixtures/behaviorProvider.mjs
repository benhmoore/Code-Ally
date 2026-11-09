// Preloaded deterministic provider: all mutations happen through production tool calls.
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
let turn = 0;
let resumedTurn = 0;
let sequence = 0;
let childTurn = 0;
const call = (name, args) => ({ id: `offline-${++sequence}`, type: 'function', function: { name, arguments: args } });
const oldOptions =
  'export function normalize(options = {}) { return { enabled: options.enabled || true, retries: options.retries || 3, label: options.label || "default" }; }';
const oldClient =
  'export function createClient(options) { const config = normalize(options); return { attempts: 3, active: true, label: config.label }; }';
const patch = (file_path, oldLine, newLine) =>
  call('apply-patch', config.variant === 'exact-edit'
    ? {file_path,old_text:oldLine,new_text:newLine}
    : { file_path, patch: `@@ -1 +1 @@\n-${oldLine}\n+${newLine}\n` });
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== 'http://offline.behavior.invalid/api/chat')
      throw new Error(`Offline provider refused network request: ${url}`);
    const payload = JSON.parse(init.body);
    let content = '';
    let tool_calls;
    if (payload.format) {
      // Deliberately invalid structured summary exercises the production extractive fallback.
      content = '{}';
    } else if (config.caseId === 'config-normalization') {
      switch (turn++) {
        case 0:
          tool_calls = [call('read', { file_path: 'src/options.js' }), call('read', { file_path: 'src/client.js' })];
          break;
        case 1:
          tool_calls = [
            patch(
              'src/options.js',
              oldOptions,
              'export function normalize(options = {}) { const {enabled=true,retries=3,label="default"}=options; return {enabled,retries,label}; }'
            ),
            patch(
              'src/client.js',
              oldClient,
              'export function createClient(options) { const {enabled,retries,label}=normalize(options); return {active:enabled,attempts:retries,label}; }'
            ),
          ];
          break;
        case 2:
          tool_calls = [call('bash', { command: 'node --test' })];
          break;
        default:
          content = 'Repaired normalization and client configuration; node --test passed.';
      }
    } else if (config.caseId === 'checkpoint-continuation') {
      const continuation = payload.messages.some(
        message => message.role === 'user' && String(message.content).includes('settings.json changed externally')
      );
      if (!continuation) {
        if (turn++ === 0) tool_calls = [call('read', { file_path: 'settings.json' })];
        else content = 'Settings revision 1 read; preserving canary and GBP for the eventual result.';
      } else {
        switch (resumedTurn++) {
          case 0:
            tool_calls = [call('read', { file_path: 'settings.json' })];
            break;
          case 1:
            tool_calls = [
              call('write', {
                file_path: 'result.json',
                content: JSON.stringify({ channel: 'canary', currency: 'GBP', revision: 2, taxRate: 0.125 }) + '\n',
              }),
            ];
            break;
          default:
            content = 'Created result.json using the original directions and refreshed settings.';
        }
      }
    } else if (config.caseId === 'delegated-synthesis') {
      const system = payload.messages.find(message => message.role === 'system');
      const child = !String(system?.content).startsWith('You are Ally');
      if (child) {
        if (childTurn++ === 0) tool_calls = [call('read', { file_path: config.workspace + '/north.json' })];
        else content = 'north.json sums to 84 (11 + 19 + 23 + 31). Source: ' + config.workspace + '/north.json';
      } else {
        switch (turn++) {
          case 0:
            tool_calls = [
              call('agent', {
                agent_type: 'task',
                task_prompt:
                  'Read ' +
                  config.workspace +
                  '/north.json only, calculate the sum, return the numeric total and source path. Do not edit files.',
              }),
              call('read', { file_path: 'south.json' }),
            ];
            break;
          case 1:
            tool_calls = [call('wait', { all: true, timeout_seconds: 5 })];
            break;
          case 2:
            tool_calls = [call('write', { file_path: 'result.json', content: '{"north":84,"south":37}\n' })];
            break;
          default:
            content = 'Combined the delegate north total 84 with south total 37 in result.json.';
        }
      }
    } else throw new Error(`Unsupported offline fixture: ${config.caseId}`);
    const record = {
      model: config.model,
      message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 1000,
      eval_count: 30,
    };
    return new Response(JSON.stringify(record) + '\n', {
      status: 200,
      headers: { 'content-type': payload.stream ? 'application/x-ndjson' : 'application/json' },
    });
  },
});
