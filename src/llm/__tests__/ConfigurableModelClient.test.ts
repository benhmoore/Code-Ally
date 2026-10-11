import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurableModelClient } from '../ConfigurableModelClient.js';
import { ModelClient, type LLMResponse } from '../ModelClient.js';
import { createModelClient } from '../createModelClient.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { Agent } from '../../agent/Agent.js';

afterEach(() => vi.unstubAllGlobals());

describe('live provider transport changes', () => {
  it('finishes an existing request on its original transport and uses the new transport next', async () => {
    let finish!: (response: LLMResponse) => void;
    const old = {
      send: vi.fn(
        () =>
          new Promise<LLMResponse>(resolve => {
            finish = resolve;
          })
      ),
      close: vi.fn(),
    } as unknown as ModelClient;
    const next = {
      send: vi.fn(async () => ({ role: 'assistant', content: 'new' })),
      close: vi.fn(),
    } as unknown as ModelClient;
    const factory = vi.fn().mockReturnValueOnce(old).mockReturnValue(next);
    const client = new ConfigurableModelClient(
      'ollama',
      { endpoint: 'http://localhost:11434', modelName: 'test', maxTokens: 64, contextSize: 16384 },
      factory
    );
    const signal = new AbortController().signal;
    const first = client.send([], { signal });
    client.setProvider('rapid-mlx');
    expect(old.close).not.toHaveBeenCalled();
    expect(await client.send([], { signal })).toMatchObject({ content: 'new' });
    finish({ role: 'assistant', content: 'old' });
    expect(await first).toMatchObject({ content: 'old' });
    expect(old.close).toHaveBeenCalledOnce();
    await client.close();
    expect(next.close).toHaveBeenCalledOnce();
  });

  it('updates credentials on the actual wire and clears them when requested', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = await createModelClient({
      config: { ...DEFAULT_CONFIG, provider: 'rapid-mlx', endpoint: 'http://127.0.0.1:8000', model: 'test' },
    });
    expect(client).toBeInstanceOf(ConfigurableModelClient);
    const live = client as ConfigurableModelClient;
    const options = { signal: new AbortController().signal };
    live.setApiKey('updated-key');
    expect(await live.send([{ role: 'user', content: 'ping' }], options)).toMatchObject({ content: 'OK' });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8000/v1/chat/completions',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer updated-key' }) })
    );
    live.setApiKey(null);
    await live.send([{ role: 'user', content: 'ping' }], options);
    expect(fetchMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ headers: expect.not.objectContaining({ Authorization: expect.anything() }) })
    );
    live.setProvider('openai-responses');
    expect(live.providerId).toBe('openai-responses');
    expect(live.capabilities.nativeCompaction).toBe(true);
    live.setProvider('ollama');
    expect(live.capabilities.nativeCompaction).toBe(false);
    expect(live.previewRequest([], options)?.url).toBe('http://127.0.0.1:8000/api/chat');
    await live.close();
  });

  it('allows idle chat sessions to switch and protects active turns and native replay', () => {
    const agent = Object.create(Agent.prototype);
    agent.appConfig = { provider: 'ollama', model: 'test' };
    agent.modelClient = { endpoint: 'http://localhost:11434', modelName: 'test', providerId: 'chat' };
    agent.isProcessing = () => false;
    agent.conversationManager = { getProviderState: () => ({ kind: 'chat' }) };
    expect(agent.getModelIdentityChangeBlock({ provider: 'rapid-mlx' })).toBeNull();
    agent.isProcessing = () => true;
    expect(agent.getModelIdentityChangeBlock({ provider: 'rapid-mlx' })).toContain('current turn');
    agent.isProcessing = () => false;
    agent.conversationManager.getProviderState = () => ({ kind: 'openai-responses' });
    for (const change of [{ provider: 'rapid-mlx' }, { endpoint: 'http://other' }, { model: 'other' }]) {
      expect(agent.getModelIdentityChangeBlock(change)).toContain('provider-native state');
    }
  });
});
