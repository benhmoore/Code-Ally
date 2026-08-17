/** Controlled ablations for Code Ally prompt, tool, and reasoning decisions. */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { OllamaClient } from '../llm/OllamaClient.js';
import type { LLMResponse } from '../llm/ModelClient.js';
import { getMainSystemPrompt } from '../prompts/systemMessages.js';
import type { FunctionDefinition, Message, ToolCall } from '../types/index.js';

const SUITE = { id: 'code-ally-harness-ablation', version: 2 } as const;

interface Options {
  endpoint: string;
  models: string[];
  runs: number;
  temperature: number;
  contextSize: number;
  maxTokens: number;
  timeoutMs: number;
  output: string;
  resume: boolean;
  sections: EvalRecord['section'][];
}

interface EvalRecord {
  section: 'batch' | 'prompt_tooling' | 'reasoning' | 'late_reminder' | 'structured_output';
  model: string;
  repetition: number;
  variant: string;
  scenario: string;
  density?: string;
  effort?: string;
  score: number;
  maxScore: number;
  elapsedMs: number;
  notes: string[];
  responses: unknown[];
  dimensions?: Record<string, { score: number; maxScore: number }>;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, any>,
  required: string[] = [],
): FunctionDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    },
  };
}

const READ = tool('read', 'Read one or more files. Read related files together.', {
  file_paths: { type: 'array', description: 'File paths to read', items: { type: 'string' } },
  limit: { type: 'integer', description: 'Maximum lines per file; 0 means all' },
  offset: { type: 'integer', description: 'Starting line, one-based' },
  ephemeral: { type: 'boolean', description: 'Remove large content after one turn' },
}, ['file_paths']);

const GREP = tool('grep', 'Search files for text or regular-expression patterns.', {
  pattern: { type: 'string', description: 'Rust-compatible regular expression' },
  path: { type: 'string', description: 'File or directory to search' },
  glob: { type: 'string', description: 'Glob filter such as *.ts' },
  output_mode: { type: 'string', description: 'content, files_with_matches, or count' },
}, ['pattern']);

const BASH = tool('bash', 'Run a shell command in the repository.', {
  command: { type: 'string', description: 'Exact shell command' },
  timeout: { type: 'integer', description: 'Timeout in seconds' },
  output_mode: { type: 'string', description: 'full, last_line, or exit_code_only' },
  run_in_background: { type: 'boolean', description: 'Run a long-lived command in background' },
}, ['command']);

const EDIT = tool('edit', 'Apply exact string replacements to one file after reading it.', {
  file_path: { type: 'string', description: 'File to edit' },
  edits: {
    type: 'array',
    description: 'Sequential exact replacements',
    items: {
      type: 'object',
      properties: {
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['old_string', 'new_string'],
    },
  },
}, ['file_path', 'edits']);

const BATCH = tool('batch', 'Execute several independent tools concurrently in one wrapper call.', {
  tools: {
    type: 'array',
    description: 'Tool specifications containing name and arguments',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Child tool name' },
        arguments: { type: 'object', description: 'Child tool arguments' },
      },
      required: ['name', 'arguments'],
    },
  },
}, ['tools']);

const DISTRACTORS: FunctionDefinition[] = [
  tool('glob', 'Find files by glob pattern.', { pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
  tool('ls', 'List directory entries.', { path: { type: 'string' } }),
  tool('tree', 'Show a directory tree.', { path: { type: 'string' }, depth: { type: 'integer' } }),
  tool('write', 'Create or overwrite a file.', { file_path: { type: 'string' }, content: { type: 'string' } }, ['file_path', 'content']),
  tool('line-edit', 'Edit a file using line-number operations.', { file_path: { type: 'string' }, edits: { type: 'array', items: { type: 'object' } } }, ['file_path', 'edits']),
  tool('explore', 'Delegate repository exploration.', { task_prompt: { type: 'string' } }, ['task_prompt']),
  tool('plan', 'Delegate implementation planning.', { task_prompt: { type: 'string' } }, ['task_prompt']),
  tool('todo-write', 'Create or update the task list.', { todos: { type: 'array', items: { type: 'object' } } }, ['todos']),
  tool('web-search', 'Search the public web.', { query: { type: 'string' } }, ['query']),
  tool('memory', 'Save or recall durable project memory.', { action: { type: 'string' }, query: { type: 'string' } }, ['action']),
  tool('agent', 'Delegate an independent task.', { task_prompt: { type: 'string' }, run_in_background: { type: 'boolean' } }, ['task_prompt']),
  tool('skill', 'Load reusable workflow instructions.', { name: { type: 'string' } }, ['name']),
  tool('format', 'Format source files.', { file_paths: { type: 'array', items: { type: 'string' } } }, ['file_paths']),
  tool('lint', 'Run source-file lint checks.', { file_paths: { type: 'array', items: { type: 'string' } } }, ['file_paths']),
  tool('ask-user-question', 'Ask the user for a required decision.', { question: { type: 'string' } }, ['question']),
  tool('sessions', 'Manage saved conversation sessions.', { action: { type: 'string' } }, ['action']),
  tool('cleanup-call', 'Remove obsolete tool results from context.', { tool_call_ids: { type: 'array', items: { type: 'string' } } }, ['tool_call_ids']),
  tool('scheduled-tasks', 'Manage scheduled tasks.', { action: { type: 'string' } }, ['action']),
];

const FULL_TOOLS = [READ, GREP, BASH, EDIT, BATCH, ...DISTRACTORS];

const MINIMAL_PROMPT = 'You are a coding assistant. Use the provided tools to complete the request accurately.';
const CONCISE_PROMPT = `You are Ally, a coding assistant. Complete the request with the fewest correct operations.

Tool rules:
- Choose the narrowest tool that directly matches the operation.
- Read a file before editing it.
- Use one read call with file_paths for multiple related files.
- For different independent operations, emit separate native tool calls in one response.
- Do not call unrelated tools or describe a tool call instead of making it.`;

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  const resume = argv.includes('--resume');
  argv = argv.filter(value => value !== '--resume');
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]!;
    const value = argv[index + 1];
    if (!key.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid argument near ${key}`);
    values.set(key, value);
    index++;
  }
  const models = (values.get('--models') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (models.length === 0) throw new Error('Pass --models model-a,model-b');
  const number = (key: string, fallback: number) => Number(values.get(key) ?? fallback);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const options = {
    endpoint: (values.get('--endpoint') ?? 'http://localhost:11434').replace(/\/+$/, ''),
    models,
    runs: Math.floor(number('--runs', 2)),
    temperature: number('--temperature', 1),
    contextSize: Math.floor(number('--context-size', 32768)),
    maxTokens: Math.floor(number('--max-tokens', 4096)),
    timeoutMs: Math.floor(number('--timeout-ms', 600000)),
    output: resolve(values.get('--output') ?? `model-eval-results/harness-ablation-${timestamp}.json`),
    resume,
    sections: (values.get('--sections') ?? 'batch,prompt_tooling,reasoning,late_reminder,structured_output')
      .split(',') as EvalRecord['section'][],
  };
  if (options.runs < 1) throw new Error('--runs must be at least 1');
  const validSections = new Set<EvalRecord['section']>([
    'batch', 'prompt_tooling', 'reasoning', 'late_reminder', 'structured_output',
  ]);
  if (options.sections.some(section => !validSections.has(section))) throw new Error('--sections contains an unknown section');
  return options;
}

function hasDescription(call: ToolCall | undefined): boolean {
  const value = call?.function.arguments.description;
  if (typeof value !== 'string') return false;
  const words = value.trim().split(/\s+/).filter(Boolean).length;
  return words >= 5 && words <= 10;
}

function callNamed(response: LLMResponse, name: string): ToolCall | undefined {
  return response.tool_calls?.find(call => call.function.name === name);
}

function sameStrings(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every(value => actual.includes(value));
}

function repositoryPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replaceAll('\\', '/');
  const marker = '/Code-Ally/';
  const offset = normalized.lastIndexOf(marker);
  return offset >= 0 ? normalized.slice(offset + marker.length) : normalized.replace(/^\.\//, '');
}

function samePaths(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual) && sameStrings(actual.map(repositoryPath), expected);
}

async function send(
  client: OllamaClient,
  messages: Message[],
  functions: FunctionDefinition[] | undefined,
  options: Options,
): Promise<{ response: LLMResponse; elapsedMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = performance.now();
  try {
    const response = await client.send(messages, { functions, stream: false, signal: controller.signal });
    return { response, elapsedMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timeout);
  }
}

function record(
  base: Omit<EvalRecord, 'score' | 'maxScore' | 'elapsedMs' | 'notes' | 'responses'>,
  result: {
    score: number;
    maxScore: number;
    elapsedMs: number;
    notes?: string[];
    responses: unknown[];
    dimensions?: EvalRecord['dimensions'];
  },
): EvalRecord {
  return { ...base, notes: result.notes ?? [], ...result };
}

function nestedBatchCalls(response: LLMResponse): Array<{ name?: string; arguments?: Record<string, any> }> {
  const args = callNamed(response, 'batch')?.function.arguments;
  return Array.isArray(args?.tools) ? args.tools : [];
}

async function batchCase(
  client: OllamaClient,
  model: string,
  repetition: number,
  variant: 'native_only' | 'batch_available' | 'batch_guided',
  options: Options,
): Promise<EvalRecord> {
  const guided = variant === 'batch_guided';
  const system = `${MINIMAL_PROMPT}${guided ? '\nUse batch for independent operations that should run concurrently.' : ''}`;
  const functions = variant === 'native_only' ? [GREP, BASH] : [GREP, BASH, BATCH];
  const { response, elapsedMs } = await send(client, [
    { role: 'system', content: system },
    { role: 'user', content: 'Search for "reasoningRequestFields" and run "npm test" as independent operations in one response.' },
  ], functions, options);

  const nativeGrep = callNamed(response, 'grep');
  const nativeBash = callNamed(response, 'bash');
  const children = nestedBatchCalls(response);
  const childGrep = children.find(child => child.name === 'grep');
  const childBash = children.find(child => child.name === 'bash');
  const grepOk = nativeGrep?.function.arguments.pattern === 'reasoningRequestFields'
    || childGrep?.arguments?.pattern === 'reasoningRequestFields';
  const bashOk = nativeBash?.function.arguments.command === 'npm test'
    || childBash?.arguments?.command === 'npm test';
  const strategy = children.length > 0 ? 'batch' : response.tool_calls?.length === 2 ? 'native' : 'single';
  return record({ section: 'batch', model, repetition, variant, scenario: 'mixed_parallel' }, {
    score: Number(grepOk) + Number(bashOk), maxScore: 2, elapsedMs,
    notes: [`strategy=${strategy}`, `description=${hasDescription(callNamed(response, 'batch') ?? response.tool_calls?.[0])}`],
    responses: [response],
  });
}

async function promptToolCase(
  client: OllamaClient,
  model: string,
  repetition: number,
  variant: string,
  system: string,
  density: 'lean' | 'representative',
  scenario: 'select_grep' | 'multi_read' | 'read_before_edit',
  options: Options,
): Promise<EvalRecord> {
  const functions = density === 'representative'
    ? FULL_TOOLS
    : scenario === 'select_grep' ? [GREP, READ, GLOB_FALLBACK]
      : scenario === 'multi_read' ? [READ, GREP]
        : [READ, EDIT, GREP];

  if (scenario === 'select_grep') {
    const result = await send(client, [
      { role: 'system', content: system },
      { role: 'user', content: 'Find every TypeScript reference to resolveModelProfile. Use the most appropriate tool.' },
    ], functions, options);
    const call = callNamed(result.response, 'grep');
    const functionalScore = Number(Boolean(call))
      + Number(call?.function.arguments.pattern === 'resolveModelProfile');
    return record({ section: 'prompt_tooling', model, repetition, variant, density, scenario }, {
      score: functionalScore,
      maxScore: 2,
      elapsedMs: result.elapsedMs,
      responses: [result.response],
      dimensions: {
        functional: { score: functionalScore, maxScore: 2 },
      },
    });
  }

  if (scenario === 'multi_read') {
    const result = await send(client, [
      { role: 'system', content: system },
      { role: 'user', content: 'Read package.json and src/llm/modelProfile.ts efficiently in one operation.' },
    ], functions, options);
    const call = callNamed(result.response, 'read');
    const functionalScore = Number(Boolean(call))
      + Number(samePaths(call?.function.arguments.file_paths, ['package.json', 'src/llm/modelProfile.ts']))
      + Number(result.response.tool_calls?.length === 1);
    return record({ section: 'prompt_tooling', model, repetition, variant, density, scenario }, {
      score: functionalScore,
      maxScore: 3,
      elapsedMs: result.elapsedMs,
      responses: [result.response],
      dimensions: {
        functional: { score: functionalScore, maxScore: 3 },
      },
    });
  }

  const initial: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: 'Fix the inclusive range-size calculation in src/range.ts. Inspect the file before editing it.' },
  ];
  const first = await send(client, initial, functions, options);
  const read = callNamed(first.response, 'read');
  if (!read) {
    return record({ section: 'prompt_tooling', model, repetition, variant, density, scenario }, {
      score: 0, maxScore: 4, elapsedMs: first.elapsedMs, notes: ['No initial read call'], responses: [first.response],
      dimensions: {
        functional: { score: 0, maxScore: 4 },
      },
    });
  }
  const second = await send(client, [
    ...initial,
    { role: 'assistant', content: first.response.content, tool_calls: first.response.tool_calls },
    { role: 'tool', tool_call_id: read.id, content: '1→export function rangeSize(start: number, end: number) {\n2→  return end - start;\n3→}' },
  ], functions, options);
  const edit = callNamed(second.response, 'edit');
  const edits = edit?.function.arguments.edits;
  const replacement = Array.isArray(edits) ? edits[0] : undefined;
  const replacementCorrect = typeof replacement?.old_string === 'string'
    && replacement.old_string.includes('return end - start;')
    && typeof replacement?.new_string === 'string'
    && replacement.new_string.includes('return end - start + 1;');
  const functionalScore = Number(samePaths(read.function.arguments.file_paths, ['src/range.ts']))
    + Number(Boolean(edit))
    + Number(repositoryPath(edit?.function.arguments.file_path) === 'src/range.ts')
    + Number(replacementCorrect);
  return record({ section: 'prompt_tooling', model, repetition, variant, density, scenario }, {
    score: functionalScore,
    maxScore: 4,
    elapsedMs: first.elapsedMs + second.elapsedMs,
    responses: [first.response, second.response],
    dimensions: {
      functional: { score: functionalScore, maxScore: 4 },
    },
  });
}

const GLOB_FALLBACK = DISTRACTORS[0]!;

const REASONING_TASKS = [
  { id: 'worker_schedule', prompt: 'Jobs take 4, 6, and 9 minutes. Two identical workers run one job at a time. What is the minimum makespan? Reply with only the integer.', answer: '10' },
  { id: 'code_trace', prompt: 'Trace: let n=1; for (let i=0;i<4;i++) n=n*2+i; Reply with only the final integer.', answer: '27' },
  { id: 'async_bug', prompt: 'Classify the bug with one token: async function f(){ const x=fetchValue(); return x.trim(); }. Reply only: missing-await, bad-type, or race.', answer: 'missing-await' },
] as const;

async function reasoningCase(
  client: OllamaClient,
  model: string,
  repetition: number,
  effort: string,
  task: typeof REASONING_TASKS[number],
  options: Options,
): Promise<EvalRecord> {
  client.setReasoningEffort(effort);
  const result = await send(client, [
    { role: 'system', content: CONCISE_PROMPT },
    { role: 'user', content: task.prompt },
  ], undefined, options);
  const answer = result.response.content.trim();
  const score = Number(answer === task.answer) + Number(Boolean(result.response.thinking?.trim()));
  return record({ section: 'reasoning', model, repetition, variant: effort, effort, scenario: task.id }, {
    score, maxScore: 2, elapsedMs: result.elapsedMs, notes: [`answer=${JSON.stringify(answer)}`], responses: [result.response],
  });
}

async function reminderCase(
  client: OllamaClient,
  model: string,
  repetition: number,
  variant: 'none' | 'late_system',
  currentPrompt: string,
  options: Options,
): Promise<EvalRecord> {
  client.setReasoningEffort('low');
  const messages: Message[] = [
    { role: 'system', content: currentPrompt },
    { role: 'user', content: 'Find TypeScript references to resolveModelProfile using the most appropriate tool.' },
  ];
  if (variant === 'late_system') {
    messages.push({ role: 'system', content: '<system-reminder>Current Context: 18% used; no active todos.</system-reminder>', metadata: { ephemeral: true } });
  }
  const result = await send(client, messages, FULL_TOOLS, options);
  const call = callNamed(result.response, 'grep');
  const score = Number(Boolean(call)) + Number(call?.function.arguments.pattern === 'resolveModelProfile');
  return record({ section: 'late_reminder', model, repetition, variant, scenario: 'select_grep' }, {
    score, maxScore: 2, elapsedMs: result.elapsedMs, responses: [result.response],
  });
}

async function structuredCase(
  model: string,
  repetition: number,
  variant: 'baseline' | 'explicit' | 'deterministic' | 'reasoning_low',
  options: Options,
): Promise<EvalRecord> {
  const schema = {
    type: 'object',
    properties: { model: { type: 'string' }, compatible: { type: 'boolean' } },
    required: ['model', 'compatible'],
    additionalProperties: false,
  } as const;
  const explicit = variant !== 'baseline';
  const think = variant === 'reasoning_low' ? 'low' : false;
  const temperature = variant === 'deterministic' || variant === 'reasoning_low'
    ? 0
    : options.temperature;
  const started = performance.now();
  const raw = await fetchJson(`${options.endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        ...(explicit ? [{
          role: 'system',
          content: `Return only JSON matching this schema exactly; use exact property names and no Markdown fences: ${JSON.stringify(schema)}`,
        }] : []),
        { role: 'user', content: 'Set the "model" property to exactly "fixture-model" and the "compatible" property to true.' },
      ],
      stream: false,
      think,
      format: schema,
      options: { temperature, num_ctx: options.contextSize, num_predict: 512 },
    }),
  }, options.timeoutMs) as any;
  let valid = false;
  try {
    const parsed = JSON.parse(raw?.message?.content ?? '');
    valid = parsed.model === 'fixture-model' && parsed.compatible === true;
  } catch {
    // Raw output is retained below.
  }
  return record({ section: 'structured_output', model, repetition, variant, scenario: 'json_schema' }, {
    score: Number(valid), maxScore: 1, elapsedMs: Math.round(performance.now() - started), responses: [raw],
  });
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function unloadModel(endpoint: string, model: string): Promise<void> {
  await fetchJson(`${endpoint}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }, 10_000);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function revision(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function gitDirty(): boolean | undefined {
  try {
    return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return undefined;
  }
}

function worktreeSha256(): string | undefined {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    const unstaged = execFileSync('git', ['diff', '--binary'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    const staged = execFileSync('git', ['diff', '--cached', '--binary'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    return hash(`${status}\0${unstaged}\0${staged}`);
  } catch {
    return undefined;
  }
}

interface EvaluationEnvironment {
  evaluatorSha256: string;
  node: string;
  platform: string;
  arch: string;
  release: string;
  logicalCpuCount: number;
  totalMemoryBytes: number;
  ollamaVersion?: string;
  models: Array<{ requested: string; name?: string; digest?: string; size?: number; modifiedAt?: string }>;
}

async function evaluationEnvironment(options: Options): Promise<EvaluationEnvironment> {
  const [source, versionResponse, tagsResponse] = await Promise.all([
    readFile(new URL(import.meta.url), 'utf8'),
    fetchJson(`${options.endpoint}/api/version`, { method: 'GET' }, 10_000) as Promise<any>,
    fetchJson(`${options.endpoint}/api/tags`, { method: 'GET' }, 10_000) as Promise<any>,
  ]);
  const available = Array.isArray(tagsResponse?.models) ? tagsResponse.models : [];
  return {
    evaluatorSha256: hash(source),
    node: process.version,
    platform: platform(),
    arch: arch(),
    release: release(),
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    ollamaVersion: versionResponse?.version,
    models: options.models.map(requested => {
      const match = available.find((candidate: any) => candidate.name === requested || candidate.model === requested);
      return {
        requested,
        name: match?.name ?? match?.model,
        digest: match?.digest,
        size: match?.size,
        modifiedAt: match?.modified_at,
      };
    }),
  };
}

function modelRunnerProcesses(): Array<{ pid: number; model: string }> {
  if (process.platform === 'win32') return [];
  const output = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return output.split('\n').flatMap(line => {
    const fields = /^\s*(\d+)\s+(.+)$/.exec(line);
    const model = fields && /\bollama runner\b.*(?:^|\s)--model\s+(\S+)/.exec(fields[2]!);
    return fields && model ? [{ pid: Number(fields[1]), model: model[1]! }] : [];
  });
}

async function requireNoModelRunners(timeoutMs = 30_000, quietMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let quietSince: number | undefined;
  let runners: Array<{ pid: number; model: string }> = [];
  while (Date.now() < deadline) {
    runners = modelRunnerProcesses();
    if (runners.length === 0) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= quietMs) return;
    } else {
      quietSince = undefined;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const details = runners.length > 0
    ? runners.map(item => `${item.model} (pid ${item.pid})`).join(', ')
    : `runner set did not remain empty for ${quietMs}ms`;
  throw new Error(`Model isolation failed; Ollama runners still active: ${details}`);
}

function expectedCasesPerModelRepetition(sections: EvalRecord['section'][]): number {
  return Number(sections.includes('batch')) * 3
    + Number(sections.includes('prompt_tooling')) * 18
    + Number(sections.includes('reasoning')) * 9
    + Number(sections.includes('late_reminder')) * 2
    + Number(sections.includes('structured_output')) * 4;
}

function aggregate(records: EvalRecord[], keys: Array<keyof EvalRecord>): unknown[] {
  const groups = new Map<string, EvalRecord[]>();
  for (const item of records) {
    const key = JSON.stringify(keys.map(field => item[field]));
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].map(items => {
    const dimensionNames = new Set(items.flatMap(item => Object.keys(item.dimensions ?? {})));
    const dimensions = Object.fromEntries([...dimensionNames].map(name => {
      const score = items.reduce((sum, item) => sum + (item.dimensions?.[name]?.score ?? 0), 0);
      const maxScore = items.reduce((sum, item) => sum + (item.dimensions?.[name]?.maxScore ?? 0), 0);
      return [name, { score, maxScore, accuracy: maxScore > 0 ? score / maxScore : 0 }];
    }));
    const score = items.reduce((sum, item) => sum + item.score, 0);
    const maxScore = items.reduce((sum, item) => sum + item.maxScore, 0);
    return {
      ...Object.fromEntries(keys.map(field => [field, items[0]![field]])),
      score,
      maxScore,
      accuracy: score / maxScore,
      ...(dimensionNames.size > 0 ? { dimensions } : {}),
      meanElapsedMs: Math.round(items.reduce((sum, item) => sum + item.elapsedMs, 0) / items.length),
      samples: items.length,
    };
  });
}

async function writeResult(path: string, result: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

function savedSettings(options: Options): Omit<Options, 'output' | 'resume'> {
  const { output: _output, resume: _resume, ...settings } = options;
  return settings;
}

function isCompleted(records: EvalRecord[], expected: Partial<EvalRecord>): boolean {
  return records.some(item => Object.entries(expected).every(([key, value]) => item[key as keyof EvalRecord] === value));
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: npm run eval:harness -- --models model-a,model-b [--runs 2] [--sections list] [--output path] [--resume]\n');
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const currentPrompt = await getMainSystemPrompt(undefined, undefined, false, 'low');
  const prompts = { minimal: MINIMAL_PROMPT, current: currentPrompt, concise: CONCISE_PROMPT };
  const promptMetadata = Object.fromEntries(Object.entries(prompts).map(([name, content]) => [name, {
    sha256: hash(content), characters: content.length, content,
  }]));
  const environment = await evaluationEnvironment(options);
  const provenance = {
    gitRevision: revision(),
    gitDirty: gitDirty(),
    worktreeSha256: worktreeSha256(),
  };
  const records: EvalRecord[] = [];
  await mkdir(dirname(options.output), { recursive: true });
  if (options.resume) {
    const saved = JSON.parse(await readFile(options.output, 'utf8')) as {
      suite?: typeof SUITE;
      settings?: Partial<Options>;
      environment?: EvaluationEnvironment;
      prompts?: typeof promptMetadata;
      gitRevision?: string;
      worktreeSha256?: string;
      records?: EvalRecord[];
    };
    if (saved.suite?.id !== SUITE.id || saved.suite.version !== SUITE.version) {
      throw new Error(`Cannot resume ${options.output}: evaluation suite does not match`);
    }
    const expectedSettings = savedSettings(options);
    if (JSON.stringify(saved.settings) !== JSON.stringify(expectedSettings)) {
      throw new Error(`Cannot resume ${options.output}: evaluation settings do not match`);
    }
    if (JSON.stringify(saved.environment) !== JSON.stringify(environment)
      || JSON.stringify(saved.prompts) !== JSON.stringify(promptMetadata)
      || saved.gitRevision !== provenance.gitRevision
      || saved.worktreeSha256 !== provenance.worktreeSha256) {
      throw new Error(`Cannot resume ${options.output}: evaluator, model, prompt, or worktree provenance changed`);
    }
    records.push(...(saved.records ?? []));
    process.stdout.write(`Resuming ${options.output} after ${records.length} completed cases.\n`);
  }
  const checkpoint = async () => writeResult(options.output, {
    suite: SUITE,
    status: 'running',
    generatedAt: new Date().toISOString(),
    ...provenance,
    environment,
    prompts: promptMetadata,
    settings: savedSettings(options),
    completedRecords: records.length,
    records,
  });
  const add = async (pending: Promise<EvalRecord>) => {
    records.push(await pending);
    await checkpoint();
  };

  for (let repetition = 1; repetition <= options.runs; repetition++) {
    const modelOrder = repetition % 2 ? options.models : [...options.models].reverse();
    for (const model of modelOrder) {
      const completedForBlock = records.filter(item => item.model === model
        && item.repetition === repetition
        && options.sections.includes(item.section)).length;
      if (completedForBlock >= expectedCasesPerModelRepetition(options.sections)) continue;
      await requireNoModelRunners();
      const client = new OllamaClient({
        endpoint: options.endpoint,
        modelName: model,
        temperature: options.temperature,
        contextSize: options.contextSize,
        maxTokens: options.maxTokens,
        reasoningEffort: 'low',
        keepAlive: 600,
      });
      try {
        process.stdout.write(`Warming ${model}...\n`);
        await send(client, [{ role: 'user', content: 'Reply OK.' }], undefined, options);
        client.setReasoningEffort('low');
        process.stdout.write(`Run ${repetition}/${options.runs}: ${model}\n`);

        if (options.sections.includes('batch')) {
          for (const variant of ['native_only', 'batch_available', 'batch_guided'] as const) {
            if (!isCompleted(records, { section: 'batch', model, repetition, variant })) {
              await add(batchCase(client, model, repetition, variant, options));
            }
          }
        }
        if (options.sections.includes('prompt_tooling')) {
          for (const [variant, system] of Object.entries(prompts)) {
            for (const density of ['lean', 'representative'] as const) {
              for (const scenario of ['select_grep', 'multi_read', 'read_before_edit'] as const) {
                if (!isCompleted(records, { section: 'prompt_tooling', model, repetition, variant, density, scenario })) {
                  await add(promptToolCase(client, model, repetition, variant, system, density, scenario, options));
                }
              }
            }
          }
        }
        if (options.sections.includes('reasoning')) {
          for (const effort of ['low', 'medium', 'high']) {
            for (const task of REASONING_TASKS) {
              if (!isCompleted(records, { section: 'reasoning', model, repetition, effort, scenario: task.id })) {
                await add(reasoningCase(client, model, repetition, effort, task, options));
              }
            }
          }
        }
        if (options.sections.includes('late_reminder')) {
          for (const variant of ['none', 'late_system'] as const) {
            if (!isCompleted(records, { section: 'late_reminder', model, repetition, variant })) {
              await add(reminderCase(client, model, repetition, variant, currentPrompt, options));
            }
          }
        }
        if (options.sections.includes('structured_output')) {
          for (const variant of ['baseline', 'explicit', 'deterministic', 'reasoning_low'] as const) {
            if (!isCompleted(records, { section: 'structured_output', model, repetition, variant })) {
              await add(structuredCase(model, repetition, variant, options));
            }
          }
        }
      } finally {
        await client.close();
        try {
          await unloadModel(options.endpoint, model);
        } catch (error) {
          process.stderr.write(`Unable to unload ${model}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        await requireNoModelRunners();
      }
    }
  }

  const result = {
    suite: SUITE,
    generatedAt: new Date().toISOString(),
    ...provenance,
    environment,
    settings: savedSettings(options),
    prompts: promptMetadata,
    toolCounts: { lean: '2-3', representative: FULL_TOOLS.length },
    summaries: {
      batch: aggregate(records.filter(item => item.section === 'batch'), ['model', 'variant']),
      promptTooling: aggregate(records.filter(item => item.section === 'prompt_tooling'), ['model', 'variant', 'density']),
      reasoning: aggregate(records.filter(item => item.section === 'reasoning'), ['model', 'effort']),
      lateReminder: aggregate(records.filter(item => item.section === 'late_reminder'), ['model', 'variant']),
      structuredOutput: aggregate(records.filter(item => item.section === 'structured_output'), ['model', 'variant']),
    },
    records,
  };

  await writeResult(options.output, result);
  process.stdout.write(`Results: ${options.output}\n`);
  process.stdout.write(`${JSON.stringify(result.summaries, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
