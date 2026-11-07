/** Wire the same model-switch transaction into commands and terminal selection. */
import type { Agent } from '../agent/Agent.js';
import { probeModelCapabilities } from '../llm/ProviderAdapter.js';
import { applyRuntimeConfigUpdates } from './RuntimeConfigSync.js';
import type { ServiceRegistry } from './ServiceRegistry.js';
import { ModelConfigCoordinator } from './ModelConfigCoordinator.js';

export function createModelConfigCoordinator(
  registry: ServiceRegistry,
  agent: Agent | null = registry.get('agent')
): ModelConfigCoordinator {
  return new ModelConfigCoordinator({
    getConfigManager: () => registry.get('config_manager'),
    applyRuntimeConfig: updates => {
      applyRuntimeConfigUpdates(registry, updates);
    },
    validatePrimaryModelSwitch: model =>
      agent?.getModelIdentityChangeBlock({ model }) ??
      registry.get('agent_pool')?.getModelIdentityChangeBlock({ model }) ??
      null,
    testModelCapabilities: async (_endpoint, model) => {
      const config = registry.get('config_manager')?.getConfig();
      if (!config) throw new Error('Configuration unavailable. Run /config setup.');
      const capabilities = await probeModelCapabilities(config, model);
      return {
        supportsTools: capabilities.tools !== 'unsupported',
        supportsImages: capabilities.images !== 'unsupported',
        toolsVerified: capabilities.tools !== 'unknown',
        fromCache: capabilities.fromCache ?? false,
      };
    },
  });
}
