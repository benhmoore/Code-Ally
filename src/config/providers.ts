/** Shared provider choices for configuration, setup, discovery, and transport. */
export const MODEL_PROVIDERS = [
  { value: 'ollama', label: 'Ollama', transport: 'ollama', endpoint: 'http://localhost:11434' },
  {
    value: 'rapid-mlx',
    label: 'Rapid-MLX',
    transport: 'openai-compat',
    endpoint: 'http://127.0.0.1:8000',
  },
  {
    value: 'openai-compat',
    label: 'OpenAI-compatible',
    transport: 'openai-compat',
    endpoint: 'http://127.0.0.1:8000',
  },
  {
    value: 'openai-responses',
    label: 'OpenAI Responses',
    transport: 'openai-responses',
    endpoint: 'https://api.openai.com',
  },
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number]['value'];
export type ModelTransport = (typeof MODEL_PROVIDERS)[number]['transport'];

export function getModelProvider(provider: ModelProvider = 'ollama') {
  const entry = MODEL_PROVIDERS.find(entry => entry.value === provider);
  if (!entry) throw new Error(`Unknown model provider: ${provider}`);
  return entry;
}

/** Follow provider defaults only when the old endpoint was also a default.
 * Explicit/custom endpoints are preserved; credentials belong to a provider.
 */
export function providerConfigUpdates<
  T extends { provider?: ModelProvider; endpoint?: string; api_key?: string | null },
>(current: T, updates: Partial<T>): Partial<T> {
  if (!updates.provider || updates.provider === (current.provider ?? 'ollama')) return updates;
  const result = { ...updates };
  if (
    !Object.prototype.hasOwnProperty.call(updates, 'endpoint') &&
    current.endpoint === getModelProvider(current.provider).endpoint
  ) {
    result.endpoint = getModelProvider(updates.provider).endpoint;
  }
  if (!Object.prototype.hasOwnProperty.call(updates, 'api_key')) result.api_key = null;
  return result;
}
