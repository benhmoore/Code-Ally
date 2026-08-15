import { afterEach, describe, expect, it, vi } from 'vitest';
import { listProviderModels, validateProvider } from '../ProviderAdapter.js';

describe('ProviderAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists native Ollama models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: 'qwen:latest', size: 42, modified_at: 'today' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await listProviderModels({ provider: 'ollama', endpoint: 'http://localhost:11434', api_key: null });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.anything());
    expect(result.models).toEqual([{ name: 'qwen:latest', size: 42, modified: 'today' }]);
  });

  it('lists OpenAI-compatible models with authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'model-a' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await listProviderModels({
      provider: 'openai-compat', endpoint: 'https://models.example/v1', api_key: 'secret',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://models.example/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }));
    expect(result.models.map((model) => model.name)).toEqual(['model-a']);
  });

  it('allows manual model configuration when discovery is unsupported', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    const result = await validateProvider({
      provider: 'openai-compat', endpoint: 'https://models.example', api_key: null, model: 'manual-model',
    });
    expect(result).toMatchObject({ connected: true, modelStatus: 'unknown', discoverySupported: false });
  });

  it('reports a missing model when authoritative discovery succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'other' }] }), { status: 200 })));
    const result = await validateProvider({
      provider: 'openai-compat', endpoint: 'https://models.example', api_key: null, model: 'wanted',
    });
    expect(result.modelStatus).toBe('missing');
  });
});
