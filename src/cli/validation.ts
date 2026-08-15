/** Provider-aware startup validation. */

import type { Config } from '../types/index.js';
import { validateProvider, type ProviderModel } from '../llm/ProviderAdapter.js';
import { logger } from '../services/Logger.js';

export function needsSetup(config: Pick<Config, 'model' | 'endpoint'>): boolean {
  return !config.model || !config.endpoint;
}

export interface StartupValidationResult {
  ok: boolean;
  providerConnected: boolean;
  modelStatus: 'found' | 'missing' | 'unknown';
  discoverySupported: boolean;
  availableModels?: ProviderModel[];
  error?: string;
  similarModels?: string[];
}

export async function runStartupValidation(config: Config): Promise<StartupValidationResult> {
  const result = await validateProvider(config);
  const providerName = config.provider ?? 'ollama';

  if (!result.connected) {
    logger.error(`Cannot connect to ${providerName} endpoint ${config.endpoint}: ${result.error}`);
    return {
      ok: false,
      providerConnected: false,
      modelStatus: 'unknown',
      discoverySupported: result.discoverySupported,
      error: result.error,
    };
  }

  if (result.modelStatus === 'missing') {
    const prefix = config.model?.split(':')[0] ?? '';
    const similarModels = result.models
      .map((model) => model.name)
      .filter((name) => prefix && name.includes(prefix))
      .slice(0, 3);
    logger.error(`Model '${config.model}' was not reported by ${providerName}`);
    return {
      ok: false,
      providerConnected: true,
      modelStatus: 'missing',
      discoverySupported: true,
      availableModels: result.models,
      similarModels,
    };
  }

  return {
    ok: true,
    providerConnected: true,
    modelStatus: result.modelStatus,
    discoverySupported: result.discoverySupported,
  };
}
