import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionPolicyService } from '../PermissionPolicyService.js';
import { MAX_PERMISSION_REVIEW_BYTES } from '../../security/PermissionReviewLimits.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { consumeAutoReadCommand } from '../../security/ReadCommandPlan.js';
import { permissionReadinessProbeKind } from '../../security/PermissionReviewRequest.js';
const classify = vi.hoisted(() => vi.fn(async () => ({ kind: 'review', reason: 'Bounded workspace edit' })));
vi.mock('../../security/AutoActionPolicy.js', () => ({ classifyAutoAction: classify }));
const answer = (choice: 'allow' | 'ask' | 'deny', probability = 1) => ({
  answers: {
    permission: {
      type: 'choice',
      choice,
      probabilities: {
        allow: 0,
        ask: 0,
        deny: 0,
        [choice]: probability,
        ...(probability < 1 ? { ask: 1 - probability } : {}),
      },
    },
  },
});
const services: PermissionPolicyService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.cleanup()));
  classify.mockReset().mockResolvedValue({ kind: 'review', reason: 'Bounded workspace edit' });
});
function fixture(
  review: unknown = answer('allow'),
  overrides = {},
  probeAnswer = (kind: 'positive' | 'negative') => answer(kind === 'positive' ? 'allow' : 'deny')
) {
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    if (String(url).endsWith('/api/tags'))
      return Response.json({ models: [{ name: 'tev1:4b', capabilities: ['decision'] }] });
    const body = JSON.parse(String(options?.body));
    const probe = permissionReadinessProbeKind(body);
    return Response.json(probe ? probeAnswer(probe) : review);
  });
  const service = new PermissionPolicyService(fetcher as typeof fetch);
  services.push(service);
  service.configure({ ...DEFAULT_CONFIG, endpoint: 'http://fixture:11434', ...overrides });
  return { service, fetcher };
}
const action = {
  toolName: 'write',
  args: { file_path: 'src/x.ts', content: 'export const x = 2;' },
  workspaceRoot: '/workspace',
  task: 'Set x to 2 in src/x.ts.',
};

describe('selective permission reviewer ownership', () => {
  it('defaults to manual while probing and enables Auto only after a real readiness check', async () => {
    const { service, fetcher } = fixture();
    expect(service.getSnapshot().effectiveMode).toBe('manual');
    await service.refresh();
    expect(service.getSnapshot()).toMatchObject({
      effectiveMode: 'auto',
      reviewerModel: 'tev1:4b',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await service.evaluate(action)).toMatchObject({
      verdict: 'allow',
      source: 'reviewer',
    });
  });

  it('uses deterministic decisions without another model request', async () => {
    const { service, fetcher } = fixture();
    await service.refresh();
    classify.mockResolvedValueOnce({
      kind: 'allow',
      reason: 'Read-only workspace operation',
    });
    expect(await service.evaluate(action)).toMatchObject({
      verdict: 'allow',
      source: 'policy',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('allows deterministic local actions during reviewer fallback without reviewing edits', async () => {
    const { service, fetcher } = fixture();
    fetcher.mockRejectedValue(new Error('Reviewer offline'));
    await service.refresh();
    expect(service.getSnapshot().effectiveMode).toBe('manual');
    const calls = fetcher.mock.calls.length;
    classify.mockResolvedValueOnce({ kind: 'allow', reason: 'Proven workspace read' });
    expect(await service.evaluate(action)).toMatchObject({ verdict: 'allow', source: 'policy' });
    expect(await service.evaluate(action)).toMatchObject({ verdict: 'ask', reason: 'Reviewer offline' });
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });

  it('binds real workspace read plans during fallback and retains external and executable boundaries', async () => {
    const { service, fetcher } = fixture();
    fetcher.mockRejectedValue(new Error('Reviewer offline'));
    await service.refresh();
    const actual = await vi.importActual<typeof import('../../security/AutoActionPolicy.js')>(
      '../../security/AutoActionPolicy.js'
    );
    classify.mockImplementation(actual.classifyAutoAction);
    const args = { command: 'cat package.json' };
    const input = { toolName: 'bash', args, workspaceRoot: process.cwd() };
    expect(await service.evaluate(input)).toMatchObject({ verdict: 'allow', source: 'policy' });
    expect(await consumeAutoReadCommand(args, process.cwd())).toMatchObject({ kind: 'approved' });
    expect(await consumeAutoReadCommand(args, process.cwd())).toEqual({ kind: 'none' });
    for (const command of ['cat /etc/passwd', 'npm test']) {
      expect(await service.evaluate({ ...input, args: { command } })).toMatchObject({ verdict: 'ask' });
    }
    const changed = { command: 'cat package.json' };
    expect(await service.evaluate({ ...input, args: changed })).toMatchObject({ verdict: 'allow' });
    changed.command = 'cat /etc/passwd';
    expect(await consumeAutoReadCommand(changed, process.cwd())).toMatchObject({ kind: 'rejected' });
  });

  it.each([{ permission_mode: 'manual' as const }, { reviewer_shadow: true }])(
    'never grants local Auto approval in manual or shadow mode: %j',
    async overrides => {
      const { service } = fixture(answer('allow'), overrides);
      await service.refresh();
      classify.mockResolvedValue({ kind: 'allow', reason: 'Proven workspace read' });
      expect(await service.evaluate(action)).toMatchObject({ verdict: 'ask' });
    }
  );

  it('does not grant a local decision completed after a mode change', async () => {
    const { service } = fixture();
    await service.refresh();
    let resolve!: (value: { kind: string; reason: string }) => void;
    classify.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const pending = service.evaluate(action);
    service.configure({ ...DEFAULT_CONFIG, endpoint: 'http://fixture:11434', permission_mode: 'manual' });
    resolve({ kind: 'allow', reason: 'Proven workspace read' });
    expect(await pending).toMatchObject({ verdict: 'ask' });
  });

  it('cannot let the reviewer override an action outside the bounded envelope', async () => {
    const { service, fetcher } = fixture();
    await service.refresh();
    classify.mockResolvedValueOnce({ kind: 'ask', reason: 'Arbitrary scripts require approval' });
    expect(await service.evaluate({ ...action, toolName: 'bash', args: { command: 'npm test' } })).toMatchObject({
      verdict: 'ask',
      source: 'policy',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('abstains on uncertain classification rather than treating confidence as authority', async () => {
    const { service } = fixture(answer('allow', 0.8));
    await service.refresh();
    expect(await service.evaluate(action)).toMatchObject({ verdict: 'ask' });
  });

  it.each([
    { choice: 'allow' as const, probability: 0.9499, verdict: 'ask' },
    { choice: 'allow' as const, probability: 0.95, verdict: 'allow' },
    { choice: 'deny' as const, probability: 0.97, verdict: 'ask' },
    { choice: 'deny' as const, probability: 0.98, verdict: 'deny' },
  ])('uses the allow-only operating point at $choice/$probability', async ({ choice, probability, verdict }) => {
    const { service } = fixture(answer(choice, probability));
    await service.refresh();
    expect(await service.evaluate(action)).toMatchObject({ verdict, source: 'reviewer' });
  });

  it('fails closed on malformed reviewer answers and exposes the fallback', async () => {
    const { service } = fixture({ answers: { permission: { choice: 'allow' } } });
    await service.refresh();
    expect(await service.evaluate(action)).toMatchObject({ verdict: 'ask' });
    expect(service.getSnapshot()).toMatchObject({ effectiveMode: 'manual', reviewerModel: undefined });
  });

  it('does not truncate missing or oversized authority into an approval', async () => {
    const { service, fetcher } = fixture();
    await service.refresh();
    for (const task of ['', 'a'.repeat(MAX_PERMISSION_REVIEW_BYTES)])
      expect(await service.evaluate({ ...action, task })).toMatchObject({
        verdict: 'ask',
      });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('sends full long authority and a 5000-character patch without truncation', async () => {
    const { service, fetcher } = fixture();
    await service.refresh();
    const task = 'Preserve this exact authority. '.repeat(200);
    const args = { file_path: 'src/x.ts', patch: 'x'.repeat(5000) };
    expect(await service.evaluate({ ...action, toolName: 'apply-patch', task, args })).toMatchObject({
      verdict: 'allow',
      source: 'reviewer',
    });
    const body = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body));
    expect(body).toMatchObject({
      model: 'tev1:4b',
      state: {
        human_task: task,
        proposed_action: { tool: 'apply-patch', arguments: args },
        boundary: 'Bounded workspace edit',
      },
      questions: { permission: { type: 'choice' } },
    });
    expect(body.state.human_task).toBe(task);
    expect(body.state.proposed_action.arguments).toEqual(args);
  });

  it('budgets the exact serialized complete body at the byte boundary, including Unicode and questions', async () => {
    const { service, fetcher } = fixture();
    await service.refresh();
    await service.evaluate(action);
    const reference = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body));
    reference.state.human_task = '';
    const overhead = Buffer.byteLength(JSON.stringify(reference), 'utf8');
    const available = MAX_PERMISSION_REVIEW_BYTES - overhead;
    // Three-byte code points demonstrate why a character count cannot bound the request.
    const task = '界'.repeat(Math.floor(available / 3)) + 'a'.repeat(available % 3);
    const bounded = { ...action, task };
    const before = fetcher.mock.calls.length;
    expect(await service.evaluate(bounded)).toMatchObject({ verdict: 'allow', source: 'reviewer' });
    const exact = String(fetcher.mock.calls.at(-1)?.[1]?.body);
    expect(Buffer.byteLength(exact, 'utf8')).toBe(MAX_PERMISSION_REVIEW_BYTES);
    expect(JSON.parse(exact).state.human_task).toBe(task);
    expect(await service.evaluate({ ...bounded, task: task + 'a' })).toMatchObject({
      verdict: 'ask',
      reason: expect.stringContaining('64 KiB'),
    });
    expect(fetcher).toHaveBeenCalledTimes(before + 1);
  });

  it.each([400, 413, 422])('keeps a healthy reviewer ready after rejecting one proposal with HTTP %s', async status => {
    const { service, fetcher } = fixture();
    await service.refresh();
    fetcher.mockResolvedValueOnce(new Response('context overflow', { status }));
    expect(await service.evaluate({ ...action, task: 'authority '.repeat(400) })).toMatchObject({
      verdict: 'ask',
      reason: expect.stringContaining(`HTTP ${status}`),
    });
    expect(service.getSnapshot()).toMatchObject({ effectiveMode: 'auto', reviewerModel: 'tev1:4b', reviewing: false });
    expect(await service.evaluate(action)).toMatchObject({ verdict: 'allow', source: 'reviewer' });
  });

  it.each([401, 403, 404, 500])('falls back to manual when the reviewer fails with HTTP %s', async status => {
    const { service, fetcher } = fixture();
    await service.refresh();
    fetcher.mockResolvedValueOnce(new Response('reviewer failure', { status }));
    expect(await service.evaluate(action)).toMatchObject({
      verdict: 'ask',
      reason: expect.stringContaining(`HTTP ${status}`),
    });
    expect(service.getSnapshot()).toMatchObject({
      effectiveMode: 'manual',
      reviewerModel: undefined,
      reviewing: false,
    });
  });

  it('shadow review records recommendations but never grants permission', async () => {
    const { service } = fixture(answer('allow'), { reviewer_shadow: true });
    await service.refresh();
    expect(service.getSnapshot().effectiveMode).toBe('manual');
    expect(await service.evaluate(action)).toMatchObject({
      verdict: 'ask',
      source: 'shadow',
      reason: expect.stringContaining('allow'),
    });
  });

  it('does not inherit primary credentials across reviewer endpoint changes', async () => {
    const { service, fetcher } = fixture(answer('allow'), {
      api_key: 'primary-secret',
      reviewer_endpoint: 'http://reviewer:11434',
    });
    await service.refresh();
    for (const [, options] of fetcher.mock.calls) expect(options?.headers).not.toHaveProperty('Authorization');
  });

  it('never auto-selects cloud models or unrelated completion models', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        models: [
          { name: 'cloud', capabilities: ['decision'], remote_host: 'cloud.example' },
          { name: 'coding', capabilities: ['completion'] },
        ],
      })
    );
    const service = new PermissionPolicyService(fetcher as typeof fetch);
    services.push(service);
    service.configure(DEFAULT_CONFIG);
    await service.refresh();
    expect(service.getSnapshot()).toMatchObject({
      effectiveMode: 'manual',
      fallbackReason: expect.stringContaining('No local decision model'),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects a reviewer that fails the readiness decision', async () => {
    const { service, fetcher } = fixture();
    fetcher.mockResolvedValue(Response.json(answer('allow')));
    await service.refresh();
    expect(service.getSnapshot().effectiveMode).toBe('manual');
  });

  it.each([
    { name: 'always deny', positive: answer('deny'), negative: answer('deny') },
    {
      name: 'always allow',
      positive: answer('allow'),
      negative: answer('allow'),
    },
    {
      name: 'underconfident approval',
      positive: answer('allow', 0.949),
      negative: answer('deny'),
    },
  ])('falls back clearly for $name without granting an action', async ({ positive, negative }) => {
    const { service } = fixture(answer('allow'), {}, kind => (kind === 'positive' ? positive : negative));
    await service.refresh();
    expect(service.getSnapshot()).toMatchObject({
      effectiveMode: 'manual',
      reviewerModel: undefined,
      fallbackReason: expect.stringContaining('Manual approval'),
    });
    expect(await service.evaluate(action)).toMatchObject({
      verdict: 'ask',
      source: 'policy',
    });
  });

  it('accepts a conservative negative abstention after confident positive authorization', async () => {
    const { service } = fixture(answer('allow'), {}, kind =>
      kind === 'positive' ? answer('allow', 0.95) : answer('ask')
    );
    await service.refresh();
    expect(service.getSnapshot().effectiveMode).toBe('auto');
  });

  it.each(['mode change', 'cleanup'])(
    'does not continue probes or publish stale readiness after %s',
    async operation => {
      const { service, fetcher } = fixture();
      let resolve!: (value: Response) => void;
      fetcher.mockImplementationOnce(
        () =>
          new Promise<Response>(done => {
            resolve = done;
          })
      );
      const pending = service.refresh();
      await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
      const calls = fetcher.mock.calls.length;
      let cleanup: Promise<void> | undefined;
      if (operation === 'mode change')
        service.configure({
          ...DEFAULT_CONFIG,
          endpoint: 'http://fixture:11434',
          permission_mode: 'manual',
        });
      else cleanup = service.cleanup();
      resolve(Response.json(answer('allow')));
      await pending;
      await cleanup;
      expect(fetcher).toHaveBeenCalledTimes(calls);
      expect(service.getSnapshot()).toMatchObject({
        effectiveMode: 'manual',
        reviewerModel: undefined,
      });
    }
  );

  it('ignores a late review when the user changes modes', async () => {
    const { service, fetcher } = fixture();
    await service.refresh();
    let resolve!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>(done => {
          resolve = done;
        })
    );
    const pending = service.evaluate(action);
    await vi.waitFor(() => expect(service.getSnapshot().reviewing).toBe(true));
    service.configure({ ...DEFAULT_CONFIG, endpoint: 'http://fixture:11434', permission_mode: 'manual' });
    resolve(Response.json(answer('allow')));
    expect(await pending).toMatchObject({ verdict: 'ask' });
    expect(service.getSnapshot()).toMatchObject({ effectiveMode: 'manual', reviewing: false });
  });
});
