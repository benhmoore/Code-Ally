/**
 * Factory for ModelClient instances. This is the single place that maps a
 * provider setting to a concrete client, so call sites (cli bootstrap, per-agent
 * client resolution) never hardcode a backend. Adding a new backend means adding
 * one branch here.
 */

import { ModelClient, ModelClientConfig, SamplingParams } from './ModelClient.js';
import type { Config } from '../types/index.js';

/**
 * Collect the explicitly-configured sampling overrides from a Config. Returns
 * undefined when none are set, so the backend's model-tuned defaults are kept.
 */
export function samplingFromConfig(
  config: Pick<Config, 'top_p' | 'top_k' | 'min_p' | 'repeat_penalty' | 'stop'>
): SamplingParams | undefined {
  const s: SamplingParams = {};
  if (config.top_p !== undefined) s.top_p = config.top_p;
  if (config.top_k !== undefined) s.top_k = config.top_k;
  if (config.min_p !== undefined) s.min_p = config.min_p;
  if (config.repeat_penalty !== undefined) s.repeat_penalty = config.repeat_penalty;
  if (config.stop !== undefined && config.stop.length > 0) s.stop = config.stop;
  return Object.keys(s).length > 0 ? s : undefined;
}

/** Per-request overrides applied on top of the global Config. */
export interface CreateModelClientOptions {
  config: Config;
  /** Model name override (defaults to config.model). Pass null/'' for unset. */
  modelName?: string | null;
  reasoningEffort?: string;
  temperature?: number;
  maxTokens?: number;
  contextSize?: number;
  keepAlive?: number;
  activityStream?: any;
}

/**
 * Build the provider-agnostic ModelClientConfig from a Config + overrides.
 * Exposed for clients that are constructed directly (e.g. existing tests).
 */
export function toModelClientConfig(opts: CreateModelClientOptions): ModelClientConfig {
  const { config } = opts;
  return {
    endpoint: config.endpoint,
    modelName: opts.modelName !== undefined ? opts.modelName : config.model,
    temperature: opts.temperature ?? config.temperature,
    contextSize: opts.contextSize ?? config.context_size,
    maxTokens: opts.maxTokens ?? config.max_tokens,
    reasoningEffort: opts.reasoningEffort ?? config.reasoning_effort,
    keepAlive: opts.keepAlive,
    sampling: samplingFromConfig(config),
    apiKey: config.api_key ?? undefined,
    activityStream: opts.activityStream,
  };
}

/**
 * Create the appropriate ModelClient for the configured provider. Dynamic
 * imports keep the unused backend out of the dependency graph and avoid the
 * circular-import issues that direct construction has historically hit.
 */
export async function createModelClient(opts: CreateModelClientOptions): Promise<ModelClient> {
  const clientConfig = toModelClientConfig(opts);
  const provider = opts.config.provider ?? 'ollama';

  if (provider === 'openai-compat') {
    const { OpenAICompatClient } = await import('./OpenAICompatClient.js');
    return new OpenAICompatClient(clientConfig);
  }

  const { OllamaClient } = await import('./OllamaClient.js');
  return new OllamaClient(clientConfig);
}
