/**
 * Startup validation utilities
 */

import { logger } from '../services/Logger.js';

const VALIDATION_TIMEOUT = 5000;

export interface ValidationResult {
  ok: boolean;
  error?: string;
  data?: any;
}

/**
 * Check if Ollama is reachable at the endpoint
 */
export async function validateOllamaConnection(endpoint: string): Promise<ValidationResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT);

    const response = await fetch(`${endpoint}/api/tags`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { ok: true, data };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return { ok: false, error: 'Connection timeout' };
    }
    if (error.message?.includes('ECONNREFUSED')) {
      return { ok: false, error: 'Connection refused' };
    }
    return { ok: false, error: error.message || 'Unknown error' };
  }
}

/**
 * Check if a specific model is available in Ollama
 */
export async function validateModelAvailable(
  endpoint: string,
  modelName: string
): Promise<ValidationResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT);

    const response = await fetch(`${endpoint}/api/tags`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { ok: false, error: `Failed to list models: HTTP ${response.status}` };
    }

    const data: any = await response.json();
    const models = data.models || [];
    const model = models.find((m: any) => m.name === modelName);

    if (!model) {
      const modelPrefix: string = modelName.split(':')[0] || modelName;
      const similar = models
        .map((m: any) => m.name)
        .filter((name: string) => name.includes(modelPrefix))
        .slice(0, 3);

      return {
        ok: false,
        error: 'Model not found',
        data: { similar, availableCount: models.length },
      };
    }

    return { ok: true, data: model };
  } catch (error: any) {
    return { ok: false, error: error.message || 'Failed to check model' };
  }
}

/**
 * Check if critical configuration is missing
 */
export function needsSetup(config: any): boolean {
  return !config.model || !config.endpoint;
}

export interface StartupValidationResult {
  ok: boolean;
  ollamaConnected: boolean;
  modelFound: boolean;
  availableModels?: any[];
  error?: string;
  similarModels?: string[];
}

/**
 * Run all startup validation checks
 * Returns validation result instead of exiting on failure
 */
export async function runStartupValidation(config: any): Promise<StartupValidationResult> {
  // Check Ollama connectivity
  const ollamaCheck = await validateOllamaConnection(config.endpoint);

  if (!ollamaCheck.ok) {
    logger.error(`Cannot connect to Ollama at ${config.endpoint}: ${ollamaCheck.error}`);
    logger.error('Start Ollama with: ollama serve');
    return {
      ok: false,
      ollamaConnected: false,
      modelFound: false,
      error: ollamaCheck.error,
    };
  }

  // Check model availability
  const modelCheck = await validateModelAvailable(config.endpoint, config.model);

  if (!modelCheck.ok) {
    logger.error(`Model '${config.model}' not found`);

    if (modelCheck.data?.similar?.length > 0) {
      logger.error(`Similar models: ${modelCheck.data.similar.join(', ')}`);
    }

    logger.error(`Pull with: ollama pull ${config.model}`);

    // Fetch available models for the selector
    const availableModels = ollamaCheck.data?.models || [];

    return {
      ok: false,
      ollamaConnected: true,
      modelFound: false,
      availableModels,
      similarModels: modelCheck.data?.similar,
    };
  }

  return {
    ok: true,
    ollamaConnected: true,
    modelFound: true,
  };
}
