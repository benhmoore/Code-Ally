import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testModelCapabilities, testModelToolCalling, testModelImageSupport } from '../ModelValidation.js';
import { ModelCapabilitiesIndex } from '../../services/ModelCapabilitiesIndex.js';

vi.mock('../../services/ModelCapabilitiesIndex.js', () => ({
  ModelCapabilitiesIndex: { getInstance: vi.fn() },
}));

describe('model capability validation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('returns probe results when optional cache persistence fails', async () => {
    const setCapabilities = vi.fn().mockRejectedValue(new Error('Read-only home'));
    vi.mocked(ModelCapabilitiesIndex.getInstance).mockReturnValue({
      load: vi.fn().mockResolvedValue(undefined),
      getCapabilities: vi.fn().mockReturnValue(null),
      setCapabilities,
    } as unknown as ModelCapabilitiesIndex);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await expect(testModelCapabilities('http://test.invalid', 'model')).resolves.toEqual({
      supportsTools: true, supportsImages: true, fromCache: false, error: undefined,
    });
    expect(setCapabilities).toHaveBeenCalledExactlyOnceWith('model', 'http://test.invalid', {
      supportsTools: true, supportsImages: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases probe deadlines when the network fails before returning a response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
    await expect(testModelToolCalling('http://test.invalid', 'model')).resolves.toMatchObject({ error: 'Offline' });
    await expect(testModelImageSupport('http://test.invalid', 'model')).resolves.toMatchObject({ error: 'Offline' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
