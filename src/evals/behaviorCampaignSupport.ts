import type { BehaviorProcessOutcome } from './behaviorProcess.js';
import { resolveBehaviorFactors, type BehaviorFactors } from './behaviorFactors.js';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const CASE_IDS = [
  'config-normalization',
  'path-recovery',
  'optional-tool-discovery',
  'steering-constraints',
  'delegated-synthesis',
  'checkpoint-continuation',
  'multiline-edit',
] as const;
export type Variant = 'baseline' | 'outcome' | 'exact-edit';
export interface CampaignOptions {
  model: string;
  endpoint: string;
  runs: number;
  cases: string[];
  variants: Variant[];
  contextSize: number;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  reasoningEffort: string;
  output: string;
  resume: boolean;
}
export function parseOptions(args: string[]): CampaignOptions {
  const allowed = new Set([
    'model',
    'endpoint',
    'runs',
    'cases',
    'variants',
    'context-size',
    'max-tokens',
    'temperature',
    'timeout-ms',
    'output',
    'reasoning-effort',
  ]);
  const values = new Map<string, string>();
  let resume = false;
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!.replace(/^--/, '');
    if (args[index] === '--resume') {
      if (resume) throw new Error('Duplicate --resume');
      resume = true;
      continue;
    }
    if (!args[index]!.startsWith('--') || !allowed.has(name)) throw new Error(`Unknown option ${args[index]}`);
    if (values.has(name)) throw new Error(`Duplicate --${name}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    values.set(name, value);
  }
  const integer = (name: string, fallback: number, minimum = 1) => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
    return value;
  };
  const list = (name: string, fallback: string, allowedValues: readonly string[]) => {
    const result = (values.get(name) ?? fallback).split(',');
    if (result.some(value => !allowedValues.includes(value)) || new Set(result).size !== result.length)
      throw new Error(`Invalid --${name}; use unique values from ${allowedValues.join(',')}`);
    return result;
  };
  const model = values.get('model');
  if (!model?.trim()) throw new Error('--model is required');
  const endpoint = new URL(values.get('endpoint') ?? 'http://100.68.102.73:11434');
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Invalid endpoint URL');
  const temperature = Number(values.get('temperature') ?? 0);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
    throw new Error('--temperature must be between 0 and 2');
  const variants = list('variants', 'baseline', ['baseline', 'outcome', 'exact-edit']) as Variant[];
  if (variants.length > 2 || (variants.length === 2 && !variants.includes('baseline'))) {
    throw new Error('Compare baseline with one candidate at a time');
  }
  const reasoningEffort = values.get('reasoning-effort') ?? 'low';
  if (!['low', 'medium', 'high'].includes(reasoningEffort)) throw new Error('Invalid --reasoning-effort');
  return {
    model,
    endpoint: endpoint.toString().replace(/\/$/, ''),
    runs: integer('runs', 3),
    cases: list('cases', CASE_IDS.join(','), CASE_IDS),
    variants,
    contextSize: integer('context-size', 32768, 32768),
    maxTokens: integer('max-tokens', 4096),
    temperature,
    timeoutMs: integer('timeout-ms', 240000),
    reasoningEffort,
    output: resolve(values.get('output') ?? 'model-eval-results/behavior-campaign.json'),
    resume,
  };
}
export interface Trial extends BehaviorFactors {
  caseId: string;
  variant: Variant;
  repetition: number;
  seed: number;
}
export function schedule(options: Pick<CampaignOptions, 'cases' | 'variants' | 'runs'>): Trial[] {
  const result: Trial[] = [];
  const factors = resolveBehaviorFactors(options.variants);
  for (let repetition = 0; repetition < options.runs; repetition++) {
    const cases = repetition % 2 ? [...options.cases].reverse() : options.cases;
    for (const caseId of cases) {
      const originalIndex = options.cases.indexOf(caseId);
      const variants = (repetition + originalIndex) % 2 ? [...options.variants].reverse() : options.variants;
      for (const variant of variants)
        result.push({ caseId, variant, repetition, seed: repetition, ...factors[variant]! });
    }
  }
  return result;
}
export function identity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Resume requires the exact protocol-3 resolved factors, not just display labels. */
export function assertResumePrefix(trials: readonly Trial[], results: readonly Trial[]): void {
  for (const [index, row] of results.entries()) {
    const expected = trials[index];
    const actual: Trial = {
      caseId: row.caseId,
      variant: row.variant,
      repetition: row.repetition,
      seed: row.seed,
      editSurface: row.editSurface,
      promptVariant: row.promptVariant,
    };
    if (!expected || identity(expected) !== identity(actual))
      throw new Error('Resume rejected: trial order or resolved factors changed');
  }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
export interface TrialResult extends Trial {
  passed: boolean;
  elapsedMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  termination?: BehaviorProcessOutcome;
  retainedRoot?: string;
  log: string;
  worker?: Record<string, unknown>;
  error?: string;
}
/** Historical exclusion policy: request errors/aborts do not establish network-fault causality. */
export function hasInfrastructureFailure(row: TrialResult): boolean {
  const requests = row.worker?.requests;
  if (!Array.isArray(requests)) return false;
  const expectedCancellation = ['steering-constraints', 'delegated-synthesis'].includes(row.caseId);
  return requests.some(request => {
    const failure = request.error;
    return (
      (typeof request.httpStatus === 'number' && request.httpStatus >= 400) ||
      (failure && !(expectedCancellation && String(failure).startsWith('AbortError:')))
    );
  });
}
export function summarize(
  results: TrialResult[],
  cases: string[],
  variants: readonly Variant[] = [...new Set<Variant>(['baseline', ...results.map(row => row.variant)])]
) {
  if (variants.length > 2 || (variants.length === 2 && !variants.includes('baseline')))
    throw new Error('Compare baseline with one candidate at a time');
  return {
    caveat:
      'Small samples are descriptive, not evidence of statistical significance. Resource means include only repetitions where both variants passed without request-error exclusion flags; token means also exclude pairs with explicitly incomplete provider usage. Request-error flags can include intentional cancellation and do not diagnose a network fault. Deadline-exceeded trials remain completion failures.',
    cases: cases.map(caseId => {
      const rows = results.filter(row => row.caseId === caseId && variants.includes(row.variant));
      const paired = rows.filter(
        row =>
          row.passed &&
          !hasInfrastructureFailure(row) &&
          rows.some(
            other =>
              other.repetition === row.repetition &&
              other.variant !== row.variant &&
              other.passed &&
              !hasInfrastructureFailure(other)
          )
      );
      return {
        caseId,
        completion: Object.fromEntries(
          variants.map(variant => {
            const selected = rows.filter(row => row.variant === variant);
            return [variant, { passed: selected.filter(row => row.passed).length, total: selected.length }];
          })
        ),
        successfulPairs: paired.length / 2,
        requestErrorTrials: rows
          .filter(hasInfrastructureFailure)
          .map(row => ({ variant: row.variant, repetition: row.repetition })),
        deadlineExceededTrials: rows.filter(row => row.timedOut).map(row => ({ variant: row.variant, repetition: row.repetition })),
        pairedMeans: Object.fromEntries(
          variants.map(variant => {
            const selected = paired.filter(row => row.variant === variant);
            const mean = (field: string) => {
              const eligible = /Tokens$/.test(field)
                ? selected.filter(row =>
                    rows
                      .filter(other => other.repetition === row.repetition)
                      .every(
                        other => (other.worker?.metrics as Record<string, unknown> | undefined)?.usageComplete !== false
                      )
                  )
                : selected;
              const numbers = eligible
                .map(row =>
                  field === 'elapsedMs'
                    ? row.elapsedMs
                    : (row.worker?.metrics as Record<string, unknown> | undefined)?.[field]
                )
                .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
              return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
            };
            return [
              variant,
              {
                elapsedMs: mean('elapsedMs'),
                toolCalls: mean('toolCalls'),
                modelCalls: mean('modelCalls'),
                totalTokens: mean('totalTokens'),
                promptTokens: mean('promptTokens'),
                completionTokens: mean('completionTokens'),
              },
            ];
          })
        ),
      };
    }),
  };
}
