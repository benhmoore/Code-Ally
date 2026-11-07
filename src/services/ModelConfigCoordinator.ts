/**
 * ModelConfigCoordinator - Business logic behind model switching and runtime
 * config propagation
 *
 * Owns the non-rendering work of the model/config cluster:
 *   - validating a picked model's capabilities before adopting it
 *   - persisting the choice through ConfigManager
 *   - pushing config changes into the live services (RuntimeConfigSync)
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
  getConfig(): Readonly<Pick<Config, 'endpoint'>> &
    Partial<Pick<Config, 'provider' | 'api_key'>> &
    Record<string, unknown>;
  setValue(key: 'model' | 'service_model', value: string): Promise<void>;
}

/** Result of probing a model before adopting it */
export interface ModelCapabilities {
  supportsTools: boolean;
  supportsImages: boolean;
  fromCache: boolean;
  toolsVerified?: boolean;
}

export type ModelCapabilityProbe = (endpoint: string, modelName: string) => Promise<ModelCapabilities>;

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
  status: 'unavailable' | 'unsupported' | 'switched' | 'superseded' | 'error';
  /** Assistant messages to surface, in order. */
  messages: string[];
  /** Config patch for React state; only present on success. */
  configUpdate?: Partial<Config>;
}

// Commits share the config owner's lifetime, including across foreground routes.
const modelSelectionVersions = new WeakMap<ModelConfigManager, Map<ModelSlot, number>>();
const modelCommitQueues = new WeakMap<ModelConfigManager, Promise<void>>();

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
  async switchModel(
    modelName: string,
    slot: ModelSlot,
    ownsRequest: () => boolean = () => true
  ): Promise<ModelSwitchOutcome> {
    const configManager = this.deps.getConfigManager();
    if (!configManager) return { status: 'unavailable', messages: ['Configuration unavailable. Run /config setup.'] };
    let versions = modelSelectionVersions.get(configManager);
    if (!versions) {
      versions = new Map();
      modelSelectionVersions.set(configManager, versions);
    }
    const version = (versions.get(slot) ?? 0) + 1;
    versions.set(slot, version);
    const isCurrent = () => versions.get(slot) === version && ownsRequest();
    const superseded: ModelSwitchOutcome = { status: 'superseded', messages: [] };

    let phase: 'probe' | 'save' | 'apply' = 'probe';
    let savedUpdate: Partial<Config> | undefined;
    try {
      if (slot === 'ally') {
        const block = this.deps.validatePrimaryModelSwitch?.(modelName);
        if (block) return { status: 'error', messages: [block] };
      }
      const config = configManager.getConfig();
      const endpoint = config.endpoint || DEFAULT_ENDPOINT;

      const probe = this.deps.testModelCapabilities ?? (await loadDefaultProbe(config));
      const capabilities = await probe(endpoint, modelName);
      if (!isCurrent()) return superseded;

      if (slot === 'ally' && !capabilities.supportsTools) {
        return {
          status: 'unsupported',
          messages: [
            `Model '${modelName}' does not support tools. Choose another model with /model, or use /model service ${modelName} for background work.`,
          ],
        };
      }

      const configKey = slot === 'service' ? 'service_model' : 'model';

      const previous = modelCommitQueues.get(configManager) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>(resolve => {
        release = resolve;
      });
      modelCommitQueues.set(configManager, tail);
      const updates = { [configKey]: modelName } as Partial<Config>;
      try {
        await previous;
        if (!isCurrent()) return superseded;
        // Once admitted, persistence and runtime adoption finish together. A
        // newer selection waits, so an older write cannot finish after it.
        if (slot === 'ally') {
          const block = this.deps.validatePrimaryModelSwitch?.(modelName);
          if (block) return { status: 'error', messages: [block] };
        }
        phase = 'save';
        await configManager.setValue(configKey, modelName);
        savedUpdate = updates;
        phase = 'apply';
        this.deps.applyRuntimeConfig(updates);
      } finally {
        release();
        if (modelCommitQueues.get(configManager) === tail) modelCommitQueues.delete(configManager);
      }

      const typeName = slot === 'service' ? 'Service model' : 'Model';
      const capInfo = capabilities.fromCache ? ' (cached)' : '';
      const imageNote = capabilities.supportsImages ? '' : ' (no image support)';
      const verificationNote =
        capabilities.toolsVerified === false
          ? '\nTool support is unverified; choose a model that supports function calling.'
          : '';

      return {
        status: 'switched',
        configUpdate: updates,
        messages: [
          `${typeName} changed to: ${modelName}${capInfo}${imageNote}\nSaved to profile and applied to subsequent requests.${verificationNote}`,
        ],
      };
    } catch (error) {
      const detail = describeError(error);
      if (phase === 'apply') {
        return {
          status: 'error',
          configUpdate: savedUpdate,
          messages: [
            `Model saved, but could not be applied: ${detail}\nRetry the selection or restart Ally to use the saved model.`,
          ],
        };
      }
      const recovery =
        phase === 'save'
          ? 'Check the configuration file permissions, then retry /model.'
          : 'Check the connection with /config setup, then retry /model.';
      return { status: 'error', messages: [`Error changing model: ${detail}\n${recovery}`] };
    }
  }
}

async function loadDefaultProbe(
  config: Pick<Config, 'endpoint' | 'provider'> & Partial<Pick<Config, 'api_key'>>
): Promise<ModelCapabilityProbe> {
  const { probeModelCapabilities } = await import('../llm/ProviderAdapter.js');
  return async (_endpoint, model) => {
    const result = await probeModelCapabilities(config, model);
    return {
      supportsTools: result.tools !== 'unsupported',
      supportsImages: result.images !== 'unsupported',
      fromCache: result.fromCache ?? false,
    };
  };
}
