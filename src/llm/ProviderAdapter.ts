import type { Config } from '../types/index.js';
import { testModelCapabilities } from './ModelValidation.js';
import { getModelProvider } from '../config/providers.js';

export interface ProviderModel {
  name: string;
  size?: number;
  modified?: string;
  capabilities?: ModelCapabilities;
  contextWindow?: number;
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

function provider(config: Pick<Config, 'provider'>) {
  return getModelProvider(config.provider).transport;
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
  timeoutMs = 5000,
  signal?: AbortSignal,
): Promise<{ supported: boolean; models: ProviderModel[]; error?: string }> {
  const kind = provider(config);
  const url = kind === 'ollama' ? `${config.endpoint.replace(/\/+$/, '')}/api/tags` : `${apiBase(config.endpoint)}/models`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: headers(config),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
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
        .map((model: any): ProviderModel => ({
          name: String(kind === 'ollama' ? model.name : model.id ?? ''),
          size: typeof model.size === 'number' ? model.size : undefined,
          modified: typeof model.modified_at === 'string' ? model.modified_at : undefined,
          ...(Array.isArray(model.capabilities) ? { capabilities: {
            tools: model.capabilities.includes('tools') ? 'supported' : 'unsupported',
            images: model.capabilities.includes('vision') || model.capabilities.includes('images') ? 'supported' : 'unsupported',
          } } : {}),
          ...(typeof model.context_window === 'number' ? { contextWindow: model.context_window } : {}),
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
  config: Pick<Config, 'provider' | 'endpoint' | 'api_key' | 'model'>,
  signal?: AbortSignal,
): Promise<ProviderValidation> {
  const discovery = await listProviderModels(config, 5000, signal);
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
  config: Pick<Config, 'provider' | 'endpoint'> & Partial<Pick<Config, 'api_key'>>,
  modelName: string
): Promise<ModelCapabilities> {
  if (provider(config) !== 'ollama') {
    const discovery = await listProviderModels({ ...config, api_key: config.api_key ?? null });
    return discovery.models.find(model => model.name === modelName)?.capabilities
      ?? { tools: 'unknown', images: 'unknown' };
  }
  const capabilities = await testModelCapabilities(config.endpoint, modelName);
  return {
    tools: capabilities.supportsTools ? 'supported' : 'unsupported',
    images: capabilities.supportsImages ? 'supported' : 'unsupported',
    fromCache: capabilities.fromCache,
  };
}
