import type { Config } from '../types/index.js';
import { validateConfigValue } from '../config/defaults.js';
import type { IntegrationStore } from './IntegrationStore.js';

export const SEARCH_CONFIG_FIELDS = ['search_provider', 'search_api_key'] as const;
export type SearchConfigField = typeof SEARCH_CONFIG_FIELDS[number];
export function isSearchConfigField(key: string): key is SearchConfigField {
  return SEARCH_CONFIG_FIELDS.includes(key as SearchConfigField);
}
export async function readSearchConfiguration(store: IntegrationStore): Promise<Pick<Config, SearchConfigField>> {
  const settings = await store.getSettings();
  return { search_provider: settings.searchProvider, search_api_key: settings.searchAPIKey };
}

/** One durable transaction for every public configuration entry point. */
export async function updateSearchConfiguration(store: IntegrationStore, key: SearchConfigField, value: unknown) {
  const validation = validateConfigValue(key, value);
  if (!validation.valid) throw new Error(validation.error || `Invalid ${key}`);
  const previous = await store.getSettings();
  const oldValue = key === 'search_provider' ? previous.searchProvider : previous.searchAPIKey;
  if (key === 'search_provider') await store.setSearchProvider(validation.coercedValue);
  else await store.setSearchAPIKey(validation.coercedValue);
  try {
    await store.saveSettings();
  } catch (error) {
    await store.setSearchProvider(previous.searchProvider);
    await store.setSearchAPIKey(previous.searchAPIKey);
    throw error;
  }
  return { key, oldValue, newValue: validation.coercedValue };
}
export function updateSearchConfigurationFromString(store: IntegrationStore, key: SearchConfigField, value: string) {
  let parsed: unknown = value;
  try { parsed = JSON.parse(value); } catch { /* Plain string setting. */ }
  return updateSearchConfiguration(store, key, parsed);
}
