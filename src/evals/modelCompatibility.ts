/**
 * Repeatable, live Ollama compatibility evaluation for Code Ally model clients.
 * This is intentionally separate from the mocked unit suite: it exercises the
 * real wire format, streaming parser, reasoning control, and multi-turn tools.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { OllamaClient } from '../llm/OllamaClient.js';
import type { LLMResponse } from '../llm/ModelClient.js';
import type { FunctionDefinition, Message, ToolCall } from '../types/index.js';

const SUITE_ID = 'code-ally-model-compatibility';
const SUITE_VERSION = 1;

interface EvalOptions {
  endpoint: string;
  models: string[];
  runs: number;
  temperature?: number;
  reasoningEffort: string;
  contextSize: number;
  maxTokens: number;
  timeoutMs: number;
  stream: boolean;
  output: string;
}

interface StepRecord {
  elapsedMs: number;
  response: LLMResponse;
}

interface ScenarioRecord {
  id: string;
  passed: boolean;
  score: number;
  maxScore: number;
  notes: string[];
  steps: StepRecord[];
}

interface RunRecord {
  model: string;
  repetition: number;
  startedAt: string;
  elapsedMs: number;
  score: number;
  maxScore: number;
  scenarios: ScenarioRecord[];
}

const tools: FunctionDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'inspect_file',
      description: 'Read a repository file by its exact relative path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Exact relative file path.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search repository text using an exact pattern.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'Exact search pattern.' } },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run an exact shell command in the repository.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Exact command to run.' } },
        required: ['command'],
      },
    },
  },
];

const systemMessage: Message = {
  role: 'system',
  content: [
    'You are being evaluated as Code Ally\'s coding model.',
    'Follow each request literally. Use only the provided tools.',
    'Do not invent tool results. When a tool is requested, call it instead of describing it.',
  ].join(' '),
};

function parseArgs(argv: string[]): EvalOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    if (token === '--no-stream') {
      flags.add(token);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    values.set(token, value);
    index++;
  }

  const models = (values.get('--models') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('Pass at least one model with --models model-a,model-b');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const numeric = (name: string, fallback: number): number => {
    const raw = values.get(name);
    const result = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(result) || result <= 0) throw new Error(`${name} must be a positive number`);
    return result;
  };
  const temperatureRaw = values.get('--temperature');

  const runs = Math.floor(numeric('--runs', 3));
  if (runs < 1) throw new Error('--runs must be at least 1');

  return {
    endpoint: (values.get('--endpoint') ?? 'http://localhost:11434').replace(/\/+$/, ''),
    models,
    runs,
    temperature: temperatureRaw === undefined ? undefined : Number(temperatureRaw),
    reasoningEffort: values.get('--reasoning-effort') ?? 'low',
    contextSize: Math.floor(numeric('--context-size', 32768)),
    maxTokens: Math.floor(numeric('--max-tokens', 4096)),
    timeoutMs: Math.floor(numeric('--timeout-ms', 600000)),
    stream: !flags.has('--no-stream'),
    output: resolve(values.get('--output') ?? `model-eval-results/${timestamp}.json`),
  };
}

function exactCall(calls: ToolCall[] | undefined, name: string, args: Record<string, unknown>): boolean {
  return calls?.some(call => call.function.name === name
    && JSON.stringify(call.function.arguments) === JSON.stringify(args)) ?? false;
}

async function timedSend(
  client: OllamaClient,
  messages: Message[],
  options: EvalOptions,
  functions?: FunctionDefinition[],
  responseSchema?: { name: string; schema: Record<string, unknown> },
): Promise<StepRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = performance.now();
  try {
    const response = await client.send(messages, {
      functions,
      responseSchema,
      stream: options.stream,
      signal: controller.signal,
    });
    return { elapsedMs: Math.round(performance.now() - started), response };
  } finally {
    clearTimeout(timer);
  }
}

async function singleTool(client: OllamaClient, options: EvalOptions): Promise<ScenarioRecord> {
  const step = await timedSend(client, [systemMessage, {
    role: 'user',
    content: 'Call inspect_file exactly once with path "src/llm/modelProfile.ts". Do not call another tool.',
  }], options, tools);
  const passed = step.response.tool_calls?.length === 1
    && exactCall(step.response.tool_calls, 'inspect_file', { path: 'src/llm/modelProfile.ts' });
  return { id: 'single_exact_tool', passed: Boolean(passed), score: passed ? 1 : 0, maxScore: 1,
    notes: passed ? [] : ['Expected exactly one inspect_file call with the requested path.'], steps: [step] };
}

async function parallelTools(client: OllamaClient, options: EvalOptions): Promise<ScenarioRecord> {
  const step = await timedSend(client, [systemMessage, {
    role: 'user',
    content: 'In one response, call both tools: inspect_file with path "package.json" and search_code with pattern "reasoningRequestFields".',
  }], options, tools);
  const inspect = exactCall(step.response.tool_calls, 'inspect_file', { path: 'package.json' });
  const search = exactCall(step.response.tool_calls, 'search_code', { pattern: 'reasoningRequestFields' });
  const score = Number(inspect) + Number(search);
  return { id: 'parallel_exact_tools', passed: score === 2, score, maxScore: 2,
    notes: score === 2 ? [] : ['Expected both exact tool calls in one assistant response.'], steps: [step] };
}

async function recoverFromToolError(client: OllamaClient, options: EvalOptions): Promise<ScenarioRecord> {
  const firstMessages: Message[] = [systemMessage, {
    role: 'user',
    content: 'Call run_command with command "npm run missing-script". If it fails, inspect package.json before proposing a correction.',
  }];
  const first = await timedSend(client, firstMessages, options, tools);
  const firstPassed = exactCall(first.response.tool_calls, 'run_command', { command: 'npm run missing-script' });
  const call = first.response.tool_calls?.find(item => item.function.name === 'run_command');
  if (!call) {
    return { id: 'tool_error_recovery', passed: false, score: 0, maxScore: 2,
      notes: ['The first turn did not call run_command.'], steps: [first] };
  }

  const secondMessages: Message[] = [
    ...firstMessages,
    { role: 'assistant', content: first.response.content, tool_calls: first.response.tool_calls },
    {
      role: 'tool',
      tool_call_id: call.id,
      is_error: true,
      content: JSON.stringify({ success: false, exitCode: 1, error: 'Missing script: "missing-script"' }),
    },
  ];
  const second = await timedSend(client, secondMessages, options, tools);
  const secondPassed = exactCall(second.response.tool_calls, 'inspect_file', { path: 'package.json' });
  const score = Number(firstPassed) + Number(secondPassed);
  return { id: 'tool_error_recovery', passed: score === 2, score, maxScore: 2,
    notes: score === 2 ? [] : ['Expected run_command followed by inspect_file after the simulated failure.'],
    steps: [first, second] };
}

async function structuredOutput(client: OllamaClient, options: EvalOptions): Promise<ScenarioRecord> {
  const step = await timedSend(client, [systemMessage, {
    role: 'user',
    content: 'Return the requested compatibility verdict. The exact model name is "fixture-model" and it is compatible.',
  }], options, undefined, {
    name: 'compatibility_verdict',
    schema: {
      type: 'object',
      properties: { model: { type: 'string' }, compatible: { type: 'boolean' } },
      required: ['model', 'compatible'],
      additionalProperties: false,
    },
  });
  let passed = false;
  try {
    const parsed = JSON.parse(step.response.content);
    passed = parsed.model === 'fixture-model' && parsed.compatible === true;
  } catch {
    // The failed parse remains in the raw response for diagnosis.
  }
  return { id: 'structured_output', passed, score: passed ? 1 : 0, maxScore: 1,
    notes: passed ? [] : ['Expected schema-valid JSON with the exact fixture verdict.'], steps: [step] };
}

async function reasoningTrace(client: OllamaClient, options: EvalOptions): Promise<ScenarioRecord> {
  const step = await timedSend(client, [systemMessage, {
    role: 'user',
    content: 'A build starts at 09:17 and runs for 2 hours 48 minutes. State only the finishing time in HH:MM format.',
  }], options);
  const answerPassed = step.response.content.trim() === '12:05';
  const tracePassed = Boolean(step.response.thinking?.trim());
  const score = Number(answerPassed) + Number(tracePassed);
  const notes: string[] = [];
  if (!answerPassed) notes.push('Expected the exact final answer 12:05.');
  if (!tracePassed) notes.push('The response did not expose a native reasoning trace.');
  return { id: 'graded_reasoning_trace', passed: score === 2, score, maxScore: 2, notes, steps: [step] };
}

const scenarios = [singleTool, parallelTools, recoverFromToolError, structuredOutput, reasoningTrace] as const;

async function endpointJson(endpoint: string, path: string, init?: RequestInit): Promise<unknown> {
  try {
    const response = await fetch(`${endpoint}${path}`, init);
    return response.ok ? await response.json() : { error: `HTTP ${response.status}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function modelMetadata(options: EvalOptions, model: string): Promise<unknown> {
  const tags = await endpointJson(options.endpoint, '/api/tags') as any;
  const listed = Array.isArray(tags?.models)
    ? tags.models.find((candidate: any) => candidate.name === model || candidate.model === model)
    : undefined;
  const shown = await endpointJson(options.endpoint, '/api/show', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
  }) as any;
  return {
    name: model,
    digest: listed?.digest,
    size: listed?.size,
    modifiedAt: listed?.modified_at,
    details: shown?.details,
    capabilities: shown?.capabilities,
    parameters: shown?.parameters,
    error: shown?.error,
  };
}

async function unloadModel(endpoint: string, model: string): Promise<void> {
  await endpointJson(endpoint, '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 }),
  });
}

function gitRevision(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write([
      'Usage: npm run eval:models -- --models model-a,model-b [options]',
      '',
      'Options: --runs, --temperature, --reasoning-effort, --context-size,',
      '         --max-tokens, --timeout-ms, --endpoint, --output, --no-stream',
      '',
    ].join('\n'));
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.temperature !== undefined
    && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) {
    throw new Error('--temperature must be between 0 and 2');
  }

  const metadata = await Promise.all(options.models.map(model => modelMetadata(options, model)));
  const ollama = await endpointJson(options.endpoint, '/api/version');
  const records: RunRecord[] = [];

  for (let repetition = 1; repetition <= options.runs; repetition++) {
    const modelOrder = repetition % 2 === 1 ? options.models : [...options.models].reverse();
    for (const model of modelOrder) {
      const client = new OllamaClient({
        endpoint: options.endpoint,
        modelName: model,
        temperature: options.temperature,
        contextSize: options.contextSize,
        maxTokens: options.maxTokens,
        reasoningEffort: options.reasoningEffort,
        keepAlive: 600,
      });
      try {
        process.stdout.write(`Warming ${model}...\n`);
        await timedSend(client, [{ role: 'user', content: 'Reply with OK.' }], options);
        const startedAt = new Date().toISOString();
        const started = performance.now();
        const scenarioRecords: ScenarioRecord[] = [];
        process.stdout.write(`Run ${repetition}/${options.runs}: ${model}\n`);
        for (const scenario of scenarios) {
          const record = await scenario(client, options);
          scenarioRecords.push(record);
          process.stdout.write(`  ${record.passed ? 'PASS' : 'FAIL'} ${record.id} (${record.score}/${record.maxScore})\n`);
        }
        records.push({
          model,
          repetition,
          startedAt,
          elapsedMs: Math.round(performance.now() - started),
          score: scenarioRecords.reduce((sum, record) => sum + record.score, 0),
          maxScore: scenarioRecords.reduce((sum, record) => sum + record.maxScore, 0),
          scenarios: scenarioRecords,
        });
      } finally {
        await client.close();
        await unloadModel(options.endpoint, model);
      }
    }
  }

  const result = {
    suite: { id: SUITE_ID, version: SUITE_VERSION },
    generatedAt: new Date().toISOString(),
    gitRevision: gitRevision(),
    environment: { platform: process.platform, arch: process.arch, node: process.version, ollama },
    settings: { ...options, output: undefined },
    models: metadata,
    runs: records,
    summary: options.models.map(model => {
      const modelRuns = records.filter(record => record.model === model);
      return {
        model,
        passedRuns: modelRuns.filter(record => record.score === record.maxScore).length,
        runs: modelRuns.length,
        score: modelRuns.reduce((sum, record) => sum + record.score, 0),
        maxScore: modelRuns.reduce((sum, record) => sum + record.maxScore, 0),
        meanElapsedMs: Math.round(modelRuns.reduce((sum, record) => sum + record.elapsedMs, 0) / modelRuns.length),
      };
    }),
  };

  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`Results: ${options.output}\n`);
  for (const summary of result.summary) {
    process.stdout.write(`${summary.model}: ${summary.score}/${summary.maxScore}; ${summary.passedRuns}/${summary.runs} perfect runs; mean ${summary.meanElapsedMs}ms\n`);
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
