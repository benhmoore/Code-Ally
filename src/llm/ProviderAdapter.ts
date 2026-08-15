import type { Config } from '../types/index.js';
import { testModelCapabilities } from './ModelValidation.js';

export interface ProviderModel {
  name: string;
  size?: number;
  modified?: string;
}

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface ModelCapabilities {
  tools: CapabilityState;
  images: CapabilityState;
  fromCache?: boolean;
}

export interface ProviderValidation {
  connected: boolean;
  modelStatus: 'found' | 'missing' | 'unknown';
  models: ProviderModel[];
  discoverySupported: boolean;
  error?: string;
}

function provider(config: Pick<Config, 'provider'>): NonNullable<Config['provider']> {
  return config.provider ?? 'ollama';
}

function apiBase(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

function headers(config: Pick<Config, 'api_key'>): Record<string, string> {
  return config.api_key
    ? { Accept: 'application/json', Authorization: `Bearer ${config.api_key}` }
    : { Accept: 'application/json' };
}

export async function listProviderModels(
  config: Pick<Config, 'provider' | 'endpoint' | 'api_key'>,
  timeoutMs = 5000
): Promise<{ supported: boolean; models: ProviderModel[]; error?: string }> {
  const kind = provider(config);
  const url = kind === 'ollama' ? `${config.endpoint.replace(/\/+$/, '')}/api/tags` : `${apiBase(config.endpoint)}/models`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: headers(config),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      if (kind === 'openai-compat' && [404, 405, 501].includes(response.status)) {
        return { supported: false, models: [] };
      }
      return { supported: true, models: [], error: `HTTP ${response.status}` };
    }

    const data = await response.json() as any;
    const rawModels = kind === 'ollama' ? data.models : data.data;
    if (!Array.isArray(rawModels)) return { supported: true, models: [], error: 'Invalid model-list response' };
    return {
      supported: true,
      models: rawModels
        .map((model: any) => ({
          name: String(kind === 'ollama' ? model.name : model.id ?? ''),
          size: typeof model.size === 'number' ? model.size : undefined,
          modified: typeof model.modified_at === 'string' ? model.modified_at : undefined,
        }))
        .filter((model: ProviderModel) => model.name),
    };
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Connection timeout'
      : error instanceof Error ? error.message : 'Connection failed';
    return { supported: true, models: [], error: message };
  }
}

export async function validateProvider(
  config: Pick<Config, 'provider' | 'endpoint' | 'api_key' | 'model'>
): Promise<ProviderValidation> {
  const discovery = await listProviderModels(config);
  if (discovery.error) {
    return {
      connected: false,
      modelStatus: 'unknown',
      models: [],
      discoverySupported: discovery.supported,
      error: discovery.error,
    };
  }
  if (!discovery.supported) {
    return { connected: true, modelStatus: 'unknown', models: [], discoverySupported: false };
  }
  const found = discovery.models.some((model) => model.name === config.model);
  return {
    connected: true,
    modelStatus: found ? 'found' : 'missing',
    models: discovery.models,
    discoverySupported: true,
  };
}

export async function probeModelCapabilities(
  config: Pick<Config, 'provider' | 'endpoint'>,
  modelName: string
): Promise<ModelCapabilities> {
  if (provider(config) !== 'ollama') return { tools: 'unknown', images: 'unknown' };
  const capabilities = await testModelCapabilities(config.endpoint, modelName);
  return {
    tools: capabilities.supportsTools ? 'supported' : 'unsupported',
    images: capabilities.supportsImages ? 'supported' : 'unsupported',
    fromCache: capabilities.fromCache,
  };
}
