import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionPolicyService } from '../PermissionPolicyService.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
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
function fixture(review: unknown = answer('allow'), overrides = {}) {
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    if (String(url).endsWith('/api/tags'))
      return Response.json({ models: [{ name: 'tev1:4b', capabilities: ['decision'] }] });
    const body = JSON.parse(String(options?.body));
    return Response.json(typeof body.state.proposed_action === 'string' ? answer('deny') : review);
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
    expect(service.getSnapshot()).toMatchObject({ effectiveMode: 'auto', reviewerModel: 'tev1:4b' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await service.evaluate(action)).toMatchObject({ verdict: 'allow', source: 'reviewer' });
  });

  it('uses deterministic decisions without another model request', async () => {
    const { service, fetcher } = fixture();
    await service.refresh();
    classify.mockResolvedValueOnce({ kind: 'allow', reason: 'Read-only workspace operation' });
    expect(await service.evaluate(action)).toMatchObject({ verdict: 'allow', source: 'policy' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('cannot let the reviewer override an action outside the bounded envelope', async () => {
    const { service, fetcher } = fixture();
    await service.refresh();
    classify.mockResolvedValueOnce({ kind: 'ask', reason: 'Arbitrary scripts require approval' });
    expect(await service.evaluate({ ...action, toolName: 'bash', args: { command: 'npm test' } })).toMatchObject({
      verdict: 'ask',
      source: 'policy',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('abstains on uncertain classification rather than treating confidence as authority', async () => {
    const { service } = fixture(answer('allow', 0.8));
    await service.refresh();
    expect(await service.evaluate(action)).toMatchObject({ verdict: 'ask' });
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
    for (const task of ['', 'a'.repeat(2001)])
      expect(await service.evaluate({ ...action, task })).toMatchObject({ verdict: 'ask' });
    expect(fetcher).toHaveBeenCalledTimes(2);
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
