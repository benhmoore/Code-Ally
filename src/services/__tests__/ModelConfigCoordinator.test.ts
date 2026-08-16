/**
 * Tests for ModelConfigCoordinator - the model switching and runtime config
 * logic extracted from useActivitySubscriptions.
 *
 * A switch writes to the user's persisted config and re-points the live model
 * clients, so the tests pin down what is persisted, in what order the live
 * services are told, and what the user is (and isn't) told on each failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelConfigCoordinator } from '../ModelConfigCoordinator.js';
import type {
  ModelConfigManager,
  ModelCapabilities,
  ModelCapabilityProbe,
} from '../ModelConfigCoordinator.js';

function makeCapabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { supportsTools: true, supportsImages: true, fromCache: false, ...overrides };
}

function makeConfigManager(
  overrides: Partial<ModelConfigManager> = {}
): ModelConfigManager & { setValue: ReturnType<typeof vi.fn> } {
  return {
    getConfig: () => ({ endpoint: 'http://host:1234' }) as ReturnType<ModelConfigManager['getConfig']>,
    setValue: vi.fn(async () => {}),
    ...overrides,
  } as ModelConfigManager & { setValue: ReturnType<typeof vi.fn> };
}

function makeCoordinator(
  configManager: ModelConfigManager | null,
  probe: ModelCapabilityProbe = vi.fn(async () => makeCapabilities())
) {
  const applyRuntimeConfig = vi.fn();
  const coordinator = new ModelConfigCoordinator({
    getConfigManager: () => configManager,
    applyRuntimeConfig,
    testModelCapabilities: probe,
  });
  return { coordinator, applyRuntimeConfig, probe };
}

describe('ModelConfigCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveModelSlot', () => {
    it('prefers the slot named by the response', () => {
      const { coordinator } = makeCoordinator(makeConfigManager());
      expect(coordinator.resolveModelSlot('service', 'ally')).toBe('service');
    });

    it('falls back to the still-open request when the response omits it', () => {
      const { coordinator } = makeCoordinator(makeConfigManager());
      expect(coordinator.resolveModelSlot(undefined, 'service')).toBe('service');
    });

    it('defaults to the ally slot with neither present', () => {
      const { coordinator } = makeCoordinator(makeConfigManager());
      expect(coordinator.resolveModelSlot(undefined, undefined)).toBe('ally');
    });

    it('treats an unrecognized slot name as the ally slot', () => {
      const { coordinator } = makeCoordinator(makeConfigManager());
      expect(coordinator.resolveModelSlot('nonsense')).toBe('ally');
    });
  });

  describe('switchModel', () => {
    it('probes, persists and syncs the ally model', async () => {
      const configManager = makeConfigManager();
      const probe = vi.fn(async () => makeCapabilities());
      const { coordinator, applyRuntimeConfig } = makeCoordinator(configManager, probe);

      const outcome = await coordinator.switchModel('llama3', 'ally');

      expect(probe).toHaveBeenCalledWith('http://host:1234', 'llama3');
      expect(configManager.setValue).toHaveBeenCalledWith('model', 'llama3');
      expect(applyRuntimeConfig).toHaveBeenCalledWith({ model: 'llama3' });
      expect(outcome).toEqual({
        status: 'switched',
        configUpdate: { model: 'llama3' },
        messages: ['Model changed to: llama3'],
      });
    });

    it('writes the service slot to its own config key', async () => {
      const configManager = makeConfigManager();
      const { coordinator, applyRuntimeConfig } = makeCoordinator(configManager);

      const outcome = await coordinator.switchModel('small', 'service');

      expect(configManager.setValue).toHaveBeenCalledWith('service_model', 'small');
      expect(applyRuntimeConfig).toHaveBeenCalledWith({ service_model: 'small' });
      expect(outcome.messages).toEqual(['Service model changed to: small']);
    });

    it('persists before syncing the live services', async () => {
      const order: string[] = [];
      const configManager = makeConfigManager({
        setValue: vi.fn(async () => {
          order.push('persist');
        }),
      });
      const coordinator = new ModelConfigCoordinator({
        getConfigManager: () => configManager,
        applyRuntimeConfig: () => order.push('sync'),
        testModelCapabilities: async () => makeCapabilities(),
      });

      await coordinator.switchModel('llama3', 'ally');

      expect(order).toEqual(['persist', 'sync']);
    });

    it('annotates a cached probe and missing image support', async () => {
      const { coordinator } = makeCoordinator(
        makeConfigManager(),
        async () => makeCapabilities({ fromCache: true, supportsImages: false })
      );

      const outcome = await coordinator.switchModel('llama3', 'ally');

      expect(outcome.messages).toEqual(['Model changed to: llama3 (cached) (no image support)']);
    });

    it('falls back to the default endpoint when none is configured', async () => {
      const probe = vi.fn(async () => makeCapabilities());
      const { coordinator } = makeCoordinator(
        makeConfigManager({
          getConfig: () => ({ endpoint: '' }) as ReturnType<ModelConfigManager['getConfig']>,
        }),
        probe
      );

      await coordinator.switchModel('llama3', 'ally');

      expect(probe).toHaveBeenCalledWith('http://localhost:11434', 'llama3');
    });

    it('refuses a tool-less model for the ally slot without persisting it', async () => {
      const configManager = makeConfigManager();
      const { coordinator, applyRuntimeConfig } = makeCoordinator(configManager, async () =>
        makeCapabilities({ supportsTools: false })
      );

      const outcome = await coordinator.switchModel('toyllm', 'ally');

      expect(outcome.status).toBe('unsupported');
      expect(outcome.configUpdate).toBeUndefined();
      expect(outcome.messages).toEqual([
        "Model 'toyllm' does not support tools. Ally model requires tool support.",
      ]);
      expect(configManager.setValue).not.toHaveBeenCalled();
      expect(applyRuntimeConfig).not.toHaveBeenCalled();
    });

    // Preserved behavior: the tool requirement is enforced for the ally slot
    // only. Background work (titles, idle messages) does not call tools.
    it('accepts a tool-less model for the service slot', async () => {
      const configManager = makeConfigManager();
      const { coordinator } = makeCoordinator(configManager, async () =>
        makeCapabilities({ supportsTools: false })
      );

      const outcome = await coordinator.switchModel('toyllm', 'service');

      expect(outcome.status).toBe('switched');
      expect(configManager.setValue).toHaveBeenCalledWith('service_model', 'toyllm');
    });

    // Preserved behavior: a missing ConfigManager is silent - the picker just
    // closes. Encoded as its own status so the oddity stays visible.
    it('reports a missing config manager without telling the user', async () => {
      const { coordinator, applyRuntimeConfig } = makeCoordinator(null);

      const outcome = await coordinator.switchModel('llama3', 'ally');

      expect(outcome).toEqual({ status: 'unavailable', messages: [] });
      expect(applyRuntimeConfig).not.toHaveBeenCalled();
    });

    it('reports a failed probe', async () => {
      const { coordinator, applyRuntimeConfig } = makeCoordinator(makeConfigManager(), async () => {
        throw new Error('endpoint unreachable');
      });

      const outcome = await coordinator.switchModel('llama3', 'ally');

      expect(outcome).toEqual({
        status: 'error',
        messages: ['Error changing model: endpoint unreachable'],
      });
      expect(applyRuntimeConfig).not.toHaveBeenCalled();
    });

    it('reports a failed write without syncing the live services', async () => {
      const configManager = makeConfigManager({
        setValue: vi.fn(async () => {
          throw new Error('config is read-only');
        }),
      });
      const { coordinator, applyRuntimeConfig } = makeCoordinator(configManager);

      const outcome = await coordinator.switchModel('llama3', 'ally');

      expect(outcome.status).toBe('error');
      expect(outcome.messages).toEqual(['Error changing model: config is read-only']);
      expect(applyRuntimeConfig).not.toHaveBeenCalled();
    });

    it('describes a non-Error rejection', async () => {
      const { coordinator } = makeCoordinator(makeConfigManager(), async () => {
        throw 'boom';
      });

      const outcome = await coordinator.switchModel('llama3', 'ally');

      expect(outcome.messages).toEqual(['Error changing model: Unknown error']);
    });
  });

  describe('config updates', () => {
    it('passes a usable patch through', () => {
      const { coordinator } = makeCoordinator(makeConfigManager());
      expect(coordinator.normalizeConfigUpdates({ model: 'llama3' })).toEqual({ model: 'llama3' });
    });

    it.each([[null], [undefined], ['model=llama3'], [42]])(
      'rejects %p as a config patch',
      (input) => {
        const { coordinator } = makeCoordinator(makeConfigManager());
        expect(coordinator.normalizeConfigUpdates(input)).toBeNull();
      }
    );

    it('forwards a patch to the live services', () => {
      const { coordinator, applyRuntimeConfig } = makeCoordinator(makeConfigManager());

      coordinator.applyRuntimeUpdates({ model: 'llama3' });

      expect(applyRuntimeConfig).toHaveBeenCalledWith({ model: 'llama3' });
    });
  });
});
