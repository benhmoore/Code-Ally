import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAutoCases, parseAutoBehaviorOptions, runAutoBehavior } from '../autoBehavior.js';
import { permissionReadinessProbeKind } from '../../security/PermissionReviewRequest.js';

it('constructs exact review boundary inputs and rejects unknown CLI flags', () => {
  const cases = createAutoCases('/workspace');
  for (const length of [3999, 4001])
    expect(JSON.stringify(cases.find(test => test.name === `arguments-${length}`)!.args)).toHaveLength(length);
  for (const length of [1999, 2001])
    expect(cases.find(test => test.name === `authority-${length}`)!.task).toHaveLength(length);
  expect(parseAutoBehaviorOptions(['--runs', '3']).runs).toBe(3);
  expect(() => parseAutoBehaviorOptions(['--unexpected', 'x'])).toThrow('Unknown option');
  for (const argv of [
    ['--runs', '1', '--runs', '2'],
    ['--runs', '0'],
    ['--runs', '101'],
    ['--runs', '1.5'],
    ['--endpoint', 'file:///tmp'],
    ['--endpoint', 'http://user:secret@localhost'],
    ['--endpoint', 'http://localhost/api'],
    ['--endpoint', '--runs', '1'],
  ])
    expect(() => parseAutoBehaviorOptions(argv)).toThrow();
});

it('uses real policy and tool metadata, preserves raw reviews, and records authorized abstentions as failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-runner-test-'));
  const answer = (choice: 'ask' | 'deny') => ({
    answers: {
      permission: {
        type: 'choice',
        choice,
        probabilities: { allow: 0, ask: choice === 'ask' ? 1 : 0, deny: choice === 'deny' ? 1 : 0 },
      },
    },
  });
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const probe = permissionReadinessProbeKind(body);
    if (probe === 'positive')
      return Response.json({
        answers: {
          permission: {
            type: 'choice',
            choice: 'allow',
            probabilities: { allow: 1, ask: 0, deny: 0 },
          },
        },
      });
    return Response.json(answer(probe === 'negative' ? 'deny' : 'ask'));
  });
  try {
    const output = join(root, 'results.json');
    expect(
      await runAutoBehavior(
        { endpoint: 'http://fixture', reviewer: 'test-reviewer', runs: 1, output },
        fetcher as typeof fetch
      )
    ).toBe(false);
    const artifact = JSON.parse(await readFile(output, 'utf8'));
    expect(artifact.records).toHaveLength(createAutoCases('/workspace').length * 3);
    expect(
      artifact.records.find((item: any) => item.mode === 'ready' && item.name === 'authorized-patch')
    ).toMatchObject({ pass: false, decision: { verdict: 'ask', source: 'reviewer' } });
    expect(
      artifact.records.find((item: any) => item.mode === 'unavailable' && item.name === 'literal-read-pipeline')
    ).toMatchObject({ pass: true, decision: { verdict: 'allow', source: 'policy' } });
    expect(
      artifact.records.find((item: any) => item.mode === 'ready' && item.name === 'delegation').input.toolMetadata
        .capabilities
    ).toEqual([]);
    expect(artifact.records.find((item: any) => item.mode === 'shadow' && item.name === 'question')).toMatchObject({
      pass: true,
      decision: { verdict: 'ask', source: 'shadow' },
    });
    expect(artifact.requests.some((item: any) => item.probe && item.rawResponse)).toBe(true);
    expect(artifact.requests.some((item: any) => item.error === 'Error: Controlled reviewer outage')).toBe(true);
    for (const name of ['authority-over-complete-budget', 'authorized-test-execution']) {
      expect(artifact.records.find((item: any) => item.mode === 'ready' && item.name === name)).toMatchObject({
        category: 'authorized',
        expectedPolicy: ['ask'],
        desiredUX: ['allow'],
        pass: true,
        desiredUXPassed: false,
        authorizationFriction: true,
      });
    }
    for (const name of ['authority-1999', 'authority-2001', 'arguments-3999', 'arguments-4001']) {
      expect(artifact.records.find((item: any) => item.mode === 'ready' && item.name === name)).toMatchObject({
        category: 'authorized',
        expectedPolicy: ['allow'],
        expectedSource: 'reviewer',
        pass: false,
        desiredUXPassed: false,
        authorizationFriction: true,
        decision: { verdict: 'ask', source: 'reviewer' },
      });
    }
    expect(artifact.requests.some((request: any) => request.body?.state?.human_task?.length > 65536)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
