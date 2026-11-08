import { expect, it, vi } from 'vitest';
import { readSearchConfiguration, updateSearchConfiguration, updateSearchConfigurationFromString } from '../SearchConfiguration.js';
import type { IntegrationStore } from '../IntegrationStore.js';
function fixture() {
  const state = { searchProvider: 'brave', searchAPIKey: 'old-key', searchCount: 4 };
  const saveSettings = vi.fn(async () => {});
  const store = {
    getSettings: () => ({ ...state }),
    setSearchProvider: (value: string) => { if (value !== state.searchProvider) state.searchAPIKey = ''; state.searchProvider = value; },
    setSearchAPIKey: (value: string) => { state.searchAPIKey = value; },
    saveSettings,
  } as unknown as IntegrationStore;
  return { store, state, saveSettings };
}
it('uses the canonical integration owner and preserves complete credential strings', async () => {
  const { store, saveSettings } = fixture();
  await updateSearchConfigurationFromString(store, 'search_api_key', '"UX-FAKE-CANARY=complete value"');
  expect(await readSearchConfiguration(store)).toEqual({ search_provider: 'brave', search_api_key: 'UX-FAKE-CANARY=complete value' });
  expect(saveSettings).toHaveBeenCalledOnce();
});
it('uses the same durable route for reset and rolls back failed provider/key changes', async () => {
  const { store, state, saveSettings } = fixture();
  saveSettings.mockRejectedValueOnce(new Error('fixture write failure'));
  await expect(updateSearchConfiguration(store, 'search_provider', 'none')).rejects.toThrow('fixture write failure');
  expect(state).toEqual({ searchProvider: 'brave', searchAPIKey: 'old-key', searchCount: 4 });
  await updateSearchConfigurationFromString(store, 'search_api_key', 'null');
  expect((await readSearchConfiguration(store)).search_api_key).toBeNull();
  expect(saveSettings).toHaveBeenCalledTimes(2);
});
it('rejects invalid configuration before altering the live owner or saving', async () => {
  const { store, state, saveSettings } = fixture();
  await expect(updateSearchConfiguration(store, 'search_provider', 'invalid')).rejects.toThrow();
  expect(state.searchProvider).toBe('brave'); expect(saveSettings).not.toHaveBeenCalled();
});
