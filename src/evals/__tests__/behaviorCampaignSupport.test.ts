import { describe, expect, it } from 'vitest';
import {
  atomicJson,
  assertResumePrefix,
  identity,
  hasInfrastructureFailure,
  parseOptions,
  schedule,
  summarize,
  type TrialResult,
} from '../behaviorCampaignSupport.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('behavior campaign options', () => {
  it('requires an explicit model and uses conservative defaults', () => {
    expect(() => parseOptions([])).toThrow('--model');
    expect(parseOptions(['--model', 'local'])).toMatchObject({
      runs: 3,
      variants: ['baseline'],
      contextSize: 32768,
      maxTokens: 4096,
      temperature: 0,
      endpoint: 'http://100.68.102.73:11434',
    });
  });
  it('admits exact-edit as a separate runtime tool experiment without changing defaults', () => {
    expect(parseOptions(['--model', 'local', '--variants', 'baseline,exact-edit']).variants).toEqual([
      'baseline',
      'exact-edit',
    ]);
    expect(parseOptions(['--model', 'local']).variants).toEqual(['baseline']);
  });
  it.each([
    ['--context-size', '8192'],
    ['--runs', '1.2'],
    ['--timeout-ms', 'NaN'],
    ['--temperature', 'Infinity'],
    ['--cases', 'unknown'],
    ['--variants', 'baseline,baseline'],
    ['--endpoint', 'file:///tmp/provider'],
    ['--model', 'duplicate'],
    ['--unknown', 'value'],
    ['--reasoning-effort', 'extreme'],
  ])('rejects invalid %s', (flag, value) => {
    expect(() => parseOptions(['--model', 'local', flag, value])).toThrow();
  });
  it('rejects missing values, duplicate flags and unexpected positionals', () => {
    for (const extra of [['--runs'], ['--resume', '--resume'], ['surprise']])
      expect(() => parseOptions(['--model', 'local', ...extra])).toThrow();
  });
});
describe('campaign schedule and summary', () => {
  it('counterbalances variant and case ordering with matched seeds', () => {
    const trials = schedule({ cases: ['a', 'b'], variants: ['baseline', 'outcome'], runs: 2 });
    expect(trials.map(trial => `${trial.caseId}:${trial.variant}`)).toEqual([
      'a:baseline',
      'a:outcome',
      'b:outcome',
      'b:baseline',
      'b:baseline',
      'b:outcome',
      'a:outcome',
      'a:baseline',
    ]);
    expect(trials.filter(trial => trial.repetition === 1).every(trial => trial.seed === 1)).toBe(true);
  });
  it('excludes unpaired failures from resource comparisons', () => {
    const row = (
      variant: 'baseline' | 'outcome',
      repetition: number,
      passed: boolean,
      elapsedMs: number
    ): TrialResult => ({
      caseId: 'a',
      variant,
      repetition,
      seed: repetition,
      editSurface: 'unified',
      promptVariant: variant,
      passed,
      elapsedMs,
      exitCode: 0,
      signal: null,
      timedOut: false,
      log: '',
      worker: { metrics: { toolCalls: elapsedMs } },
    });
    const report = summarize(
      [
        row('baseline', 0, true, 10),
        row('outcome', 0, true, 20),
        row('baseline', 1, true, 1000),
        row('outcome', 1, false, 2000),
      ],
      ['a']
    ).cases[0]!;
    expect(report.successfulPairs).toBe(1);
    expect(report.pairedMeans.baseline).toMatchObject({ elapsedMs: 10, toolCalls: 10 });
    expect(report.completion.outcome).toEqual({ passed: 1, total: 2 });
  });
  it('does not invent paired costs for baseline-only runs', () => {
    expect(summarize([], ['a']).cases[0]?.pairedMeans.baseline?.elapsedMs).toBeNull();
  });
  it('hashes changes and atomically replaces checkpoints', async () => {
    expect(identity({ model: 'a' })).not.toBe(identity({ model: 'b' }));
    const root = await mkdtemp(join(tmpdir(), 'campaign-test-'));
    try {
      const path = join(root, 'nested', 'checkpoint.json');
      await atomicJson(path, { results: [] });
      await atomicJson(path, { results: [1] });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ results: [1] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('paired comparison validity', () => {
  const trial = (variant: 'baseline' | 'outcome', caseId: string, requests: unknown[]): TrialResult => ({
    variant,
    editSurface: 'unified',
    promptVariant: variant,
    caseId,
    repetition: 0,
    seed: 0,
    passed: true,
    elapsedMs: 10,
    exitCode: 0,
    signal: null,
    timedOut: false,
    log: '',
    worker: { requests, metrics: { totalTokens: 12, usageComplete: true } },
  });
  it('retains verified completion but excludes the pair from costs after a transport outage', () => {
    const baseline = trial('baseline', 'config-normalization', [{ error: 'TypeError: fetch failed' }]);
    const candidate = trial('outcome', 'config-normalization', [{ httpStatus: 200 }]);
    const report = summarize([baseline, candidate], ['config-normalization']).cases[0]!;
    expect(report.completion.baseline.passed).toBe(1);
    expect(report.successfulPairs).toBe(0);
    expect(report.pairedMeans.outcome.totalTokens).toBeNull();
    expect(report.requestErrorTrials).toEqual([{ variant: 'baseline', repetition: 0 }]);
  });
  it('distinguishes expected owner cancellation from unplanned connection failures', () => {
    expect(
      hasInfrastructureFailure(trial('baseline', 'delegated-synthesis', [{ error: 'AbortError: cancelled' }]))
    ).toBe(false);
    expect(
      hasInfrastructureFailure(trial('baseline', 'config-normalization', [{ error: 'AbortError: cancelled' }]))
    ).toBe(true);
    expect(
      hasInfrastructureFailure(trial('baseline', 'delegated-synthesis', [{ error: 'TypeError: terminated' }]))
    ).toBe(true);
  });
  it('requires one control and one independent candidate per comparison', () => {
    for (const value of ['outcome,exact-edit', 'baseline,outcome,exact-edit']) {
      expect(() => parseOptions(['--model', 'local', '--variants', value])).toThrow('one candidate');
    }
  });
});

it('rejects resume across resolved edit interfaces or legacy trials even when labels match', () => {
  const current = schedule({ cases: ['a'], variants: ['baseline'], runs: 1 });
  const historical = schedule({ cases: ['a'], variants: ['baseline', 'exact-edit'], runs: 1 });
  expect(() => assertResumePrefix(current, current)).not.toThrow();
  expect(() => assertResumePrefix(current, [historical[0]!])).not.toThrow();
  expect(() => assertResumePrefix(current, [{ ...current[0]!, editSurface: 'exact' }])).toThrow('resolved factors');
  const { editSurface: _surface, promptVariant: _prompt, ...legacy } = current[0]!;
  expect(() => assertResumePrefix(current, [legacy as (typeof current)[0]])).toThrow('resolved factors');
});

describe('request-error observations and deadline outcomes', () => {
  const result = (errors: string[], timedOut: boolean): TrialResult => ({
    caseId:'multiline-edit', variant:'baseline', editSurface:'unified', promptVariant:'baseline',
    repetition:0,seed:0,passed:false,elapsedMs:600182,exitCode:124,signal:null,timedOut,log:'',
    worker:{ requests:errors.map(error=>({error})), metrics:{usageComplete:false} },
  });
  it('reports the deadline separately without claiming ownership of an observed abort', () => {
    const row=result(['AbortError: This operation was aborted'],true);
    const report=summarize([row],['multiline-edit']).cases[0]!;
    expect(report.deadlineExceededTrials).toEqual([{variant:'baseline',repetition:0}]);
    expect(report.requestErrorTrials).toEqual([{variant:'baseline',repetition:0}]);
    expect(report.completion.baseline).toEqual({passed:0,total:1});
    expect(report.successfulPairs).toBe(0);
    expect(report.pairedMeans.baseline.elapsedMs).toBeNull();
    expect(report).not.toHaveProperty('infrastructureExcludedTrials');
  });
  it('preserves earlier fetch-error exclusions when a deadline and final abort coexist', () => {
    const row=result(['TypeError: fetch failed','AbortError: This operation was aborted'],true);
    expect(hasInfrastructureFailure(row)).toBe(true);
    expect(summarize([row],['multiline-edit']).cases[0]?.requestErrorTrials).toHaveLength(1);
  });
  it('retains unknown abort exclusions even without a recorded deadline', () => {
    const row=result(['AbortError: unknown cancellation'],false);
    expect(hasInfrastructureFailure(row)).toBe(true);
    const report=summarize([row],['multiline-edit']).cases[0]!;
    expect(report.requestErrorTrials).toHaveLength(1);
    expect(report.deadlineExceededTrials).toEqual([]);
  });
});
