import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupWizard } from '../SetupWizard.js';
import type { ConfigManager } from '../ConfigManager.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';

const config = { ...DEFAULT_CONFIG, provider: 'ollama' as const };
const manager = { getConfig: () => config } as ConfigManager;
afterEach(() => vi.unstubAllGlobals());

describe('essential setup services', () => {
  it('recommends 32K while retaining a previously saved context option', () => {
    const choices = new SetupWizard(manager).getContextSizeOptions(16384);
    expect(choices[0]?.value).toBe(32768);
    expect(choices.some(option => option.value === 16384)).toBe(true);
  });

  it('uses metadata to verify tools without generating responses or testing images', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ capabilities: ['completion', 'tools'] }));
    vi.stubGlobal('fetch', fetch);
    const result = await new SetupWizard(manager).inspectModel(
      { provider: 'ollama', endpoint: 'http://fixture', api_key: null, model: 'local-model', context_size: 32768 },
      undefined,
      new AbortController().signal
    );
    expect(result.tools).toBe('supported');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'http://fixture/api/show',
      expect.objectContaining({ method: 'POST', body: '{"model":"local-model"}' })
    );
  });

  it('returns an explicit unverified result after a metadata failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await new SetupWizard(manager).inspectModel(
      { provider: 'ollama', endpoint: 'http://fixture', api_key: null, model: 'local-model', context_size: 32768 },
      undefined,
      new AbortController().signal
    );
    expect(result.tools).toBe('unknown');
    expect(result.note).toContain('offline');
  });
});
