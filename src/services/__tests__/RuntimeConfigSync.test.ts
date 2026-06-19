import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { TokenManager } from '../../agent/TokenManager.js';
import { ServiceRegistry } from '../ServiceRegistry.js';
import { applyRuntimeConfigUpdates } from '../RuntimeConfigSync.js';
import type { Config } from '../../types/index.js';

describe('applyRuntimeConfigUpdates', () => {
  let registry: ServiceRegistry;
  let config: Config;

  beforeEach(async () => {
    registry = ServiceRegistry.getInstance();
    await registry.shutdown();
    config = {
      ...DEFAULT_CONFIG,
      model: 'main-model',
      service_model: null,
      context_size: 262144,
    };
    registry.registerInstance('config_manager', {
      getConfig: () => ({ ...config }),
    });
  });

  afterEach(async () => {
    await registry.shutdown();
  });

  it('updates active agent context accounting and re-registers its token manager', () => {
    const tokenManager = new TokenManager(16384);
    const activeAgent = {
      applyConfigUpdates: vi.fn((updates: Partial<Config>) => {
        if (typeof updates.context_size === 'number') {
          tokenManager.setContextSize(updates.context_size);
        }
      }),
      getTokenManager: vi.fn(() => tokenManager),
    };

    registry.registerInstance('agent', activeAgent);

    applyRuntimeConfigUpdates(registry, { context_size: 262144 });

    expect(activeAgent.applyConfigUpdates).toHaveBeenCalledWith({ context_size: 262144 });
    expect(tokenManager.getContextSize()).toBe(262144);
    expect(registry.get('token_manager')).toBe(tokenManager);
  });

  it('keeps main and service model clients in sync with model config', () => {
    const mainClient = {
      setModelName: vi.fn(),
      setContextSize: vi.fn(),
      setEndpoint: vi.fn(),
    };
    const serviceClient = {
      setModelName: vi.fn(),
      setContextSize: vi.fn(),
      setEndpoint: vi.fn(),
    };

    config = {
      ...config,
      model: 'new-main-model',
      endpoint: 'http://localhost:9999',
    };

    registry.registerInstance('model_client', mainClient);
    registry.registerInstance('service_model_client', serviceClient);

    applyRuntimeConfigUpdates(registry, {
      model: 'new-main-model',
      endpoint: 'http://localhost:9999',
      context_size: 262144,
    });

    expect(mainClient.setModelName).toHaveBeenCalledWith('new-main-model');
    expect(serviceClient.setModelName).toHaveBeenCalledWith('new-main-model');
    expect(mainClient.setEndpoint).toHaveBeenCalledWith('http://localhost:9999');
    expect(serviceClient.setEndpoint).toHaveBeenCalledWith('http://localhost:9999');
    expect(mainClient.setContextSize).toHaveBeenCalledWith(262144);
    expect(serviceClient.setContextSize).toHaveBeenCalledWith(262144);
  });
});
