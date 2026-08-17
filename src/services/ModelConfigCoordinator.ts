/**
 * ModelConfigCoordinator - Business logic behind model switching and runtime
 * config propagation
 *
 * Owns the non-rendering work of the model/config cluster:
 *   - validating a picked model's capabilities before adopting it
 *   - persisting the choice through ConfigManager
 *   - pushing config changes into the live services (RuntimeConfigSync)
 *   - normalizing CONFIG_UPDATED payloads emitted by slash commands
 *
 * The UI layer keeps only event plumbing: it toggles the picker modal, applies
 * the returned config patch to React state and renders the returned messages.
 * No ConfigManager writes and no runtime sync happen in the hook.
 *
 * Collaborators are constructor-injected as suppliers (matching
 * {@link UndoCoordinator}) so the coordinator can be built before the underlying
 * services exist and never touches ServiceRegistry itself.
 */

import type { Config } from '../types/index.js';

/** The two model slots the picker can target. */
export type ModelSlot = 'ally' | 'service';

/** Subset of ConfigManager the model switch depends on */
export interface ModelConfigManager {
  getConfig(): Readonly<Pick<Config, 'endpoint'>> & Record<string, unknown>;
  setValue(key: 'model' | 'service_model', value: string): Promise<void>;
}

/** Result of probing a model before adopting it */
export interface ModelCapabilities {
  supportsTools: boolean;
  supportsImages: boolean;
  fromCache: boolean;
}

export type ModelCapabilityProbe = (
  endpoint: string,
  modelName: string
) => Promise<ModelCapabilities>;

export interface ModelConfigCoordinatorDeps {
  getConfigManager: () => ModelConfigManager | null | undefined;
  /** Applies a config patch to the live services (RuntimeConfigSync). */
  applyRuntimeConfig: (updates: Partial<Config>) => void;
  /**
   * Capability probe. Defaults to a lazy import of `@llm/ModelValidation.js`
   * so the model index is only loaded when a switch actually happens, and is
   * overridable so tests need no network or model index.
   */
  testModelCapabilities?: ModelCapabilityProbe;
  /** Returns a user-facing reason when the active conversation cannot switch safely. */
  validatePrimaryModelSwitch?: (modelName: string) => string | null;
}

/**
 * Outcome of a model switch.
 *
 * `configUpdate` is the patch the UI must apply to its own config state, and it
 * is populated only on success. The hook applies it before dismissing the
 * picker.
 *
 * `unavailable` - a missing ConfigManager - carries no message: the picker just
 * closes, so a misconfigured registry looks to the user like nothing happened.
 * It is a distinct status rather than an error message so the oddity is visible
 * to callers instead of being papered over.
 */
export interface ModelSwitchOutcome {
  status: 'unavailable' | 'unsupported' | 'switched' | 'error';
  /** Assistant messages to surface, in order. */
  messages: string[];
  /** Config patch for React state; only present on success. */
  configUpdate?: Partial<Config>;
}

const DEFAULT_ENDPOINT = 'http://localhost:11434';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export class ModelConfigCoordinator {
  constructor(private readonly deps: ModelConfigCoordinatorDeps) {}

  /**
   * Resolve which slot a MODEL_SELECT_RESPONSE targets.
   *
   * The response event may omit the type, in which case the still-open request
   * decides; with neither present the main ("ally") model is assumed.
   */
  resolveModelSlot(responseType?: string, pendingRequestType?: string): ModelSlot {
    const resolved = responseType || pendingRequestType || 'ally';
    return resolved === 'service' ? 'service' : 'ally';
  }

  /**
   * Probe, persist and adopt a newly selected model.
   *
   * Order is load-bearing:
   *   1. probe capabilities against the configured endpoint
   *   2. reject a tool-less model for the ally slot
   *   3. persist through ConfigManager
   *   4. sync the live services
   *
   * The tool-support requirement applies to the ally slot only. A service model
   * is adopted even when the probe says it cannot call tools, since background
   * work (titles, idle messages) never calls any; the probe still runs and its
   * cache/image notes are still reported.
   */
  async switchModel(modelName: string, slot: ModelSlot): Promise<ModelSwitchOutcome> {
    const configManager = this.deps.getConfigManager();
    if (!configManager) {
      return { status: 'unavailable', messages: [] };
    }

    try {
      if (slot === 'ally') {
        const block = this.deps.validatePrimaryModelSwitch?.(modelName);
        if (block) return { status: 'error', messages: [block] };
      }
      const config = configManager.getConfig();
      const endpoint = config.endpoint || DEFAULT_ENDPOINT;

      const probe = this.deps.testModelCapabilities ?? (await loadDefaultProbe());
      const capabilities = await probe(endpoint, modelName);

      if (slot === 'ally' && !capabilities.supportsTools) {
        return {
          status: 'unsupported',
          messages: [
            `Model '${modelName}' does not support tools. Ally model requires tool support.`,
          ],
        };
      }

      const configKey = slot === 'service' ? 'service_model' : 'model';

      await configManager.setValue(configKey, modelName);

      const updates = { [configKey]: modelName } as Partial<Config>;
      this.deps.applyRuntimeConfig(updates);

      const typeName = slot === 'service' ? 'Service model' : 'Model';
      const capInfo = capabilities.fromCache ? ' (cached)' : '';
      const imageNote = capabilities.supportsImages ? '' : ' (no image support)';

      return {
        status: 'switched',
        configUpdate: updates,
        messages: [`${typeName} changed to: ${modelName}${capInfo}${imageNote}`],
      };
    } catch (error) {
      return {
        status: 'error',
        messages: [`Error changing model: ${describeError(error)}`],
      };
    }
  }

  /**
   * Validate a CONFIG_UPDATED payload.
   * Returns null when the payload is not a usable config patch.
   */
  normalizeConfigUpdates(updates: unknown): Partial<Config> | null {
    if (!updates || typeof updates !== 'object') return null;
    return updates as Partial<Config>;
  }

  /**
   * Push a config patch into the live services.
   *
   * Kept separate from {@link normalizeConfigUpdates} so the hook can update its
   * own config state in between: UI state first, runtime services second.
   */
  applyRuntimeUpdates(updates: Partial<Config>): void {
    this.deps.applyRuntimeConfig(updates);
  }
}

async function loadDefaultProbe(): Promise<ModelCapabilityProbe> {
  const { testModelCapabilities } = await import('../llm/ModelValidation.js');
  return testModelCapabilities;
}
