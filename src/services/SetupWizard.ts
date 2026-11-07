/** Essential first-run connection settings; optional integrations use their own commands. */
import { PermissionPolicyService, type PermissionSnapshot } from './PermissionPolicyService.js';
import type { PermissionMode } from '../security/PermissionMode.js';
import { ConfigManager } from './ConfigManager.js';
import { API_TIMEOUTS, CONTEXT_SIZES } from '../config/constants.js';
import { listProviderModels, type ProviderModel, type CapabilityState } from '../llm/ProviderAdapter.js';
import { getModelProvider, type ModelProvider } from '../config/providers.js';

export interface SetupConfig {
  provider: ModelProvider;
  endpoint: string;
  api_key: string | null;
  model: string;
  context_size: number;
  permission_mode?: PermissionMode;
  reviewer_model?: string | null;
  reviewer_endpoint?: string | null;
  reviewer_api_key?: string | null;
}

export class SetupWizard {
  constructor(private readonly configManager: ConfigManager) {}

  discoverModels(
    endpoint: string,
    provider = this.configManager.getConfig().provider,
    apiKey = this.configManager.getConfig().api_key,
    signal?: AbortSignal
  ) {
    return listProviderModels({ provider, endpoint, api_key: apiKey }, API_TIMEOUTS.OLLAMA_ENDPOINT_VALIDATION, signal);
  }

  /** Read advertised tool support without loading a local model or generating tokens. */
  async inspectModel(
    config: SetupConfig,
    advertised: ProviderModel | undefined,
    signal: AbortSignal
  ): Promise<{ tools: CapabilityState; note?: string }> {
    if (advertised?.capabilities) return { tools: advertised.capabilities.tools };
    if (getModelProvider(config.provider).transport !== 'ollama') {
      return {
        tools: 'unknown',
        note: 'This server does not advertise tool support. Choose a model that supports function calling.',
      };
    }
    try {
      const response = await fetch(`${config.endpoint.replace(/\/+$/, '')}/api/show`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.api_key ? { Authorization: `Bearer ${config.api_key}` } : {}),
        },
        body: JSON.stringify({ model: config.model }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUTS.OLLAMA_ENDPOINT_VALIDATION)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value: unknown = await response.json();
      const capabilities = (value as { capabilities?: unknown })?.capabilities;
      if (Array.isArray(capabilities)) return { tools: capabilities.includes('tools') ? 'supported' : 'unsupported' };
      return {
        tools: 'unknown',
        note: 'Tool support was not advertised. Choose a model that supports function calling.',
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        tools: 'unknown',
        note: `Could not verify tool support: ${error instanceof Error ? error.message : String(error)}. You can retry or continue.`,
      };
    }
  }

  /** Probe a disposable policy owner; never changes the active session's permissions. */
  async inspectPermissions(config: SetupConfig, signal: AbortSignal): Promise<PermissionSnapshot> {
    const policy = new PermissionPolicyService();
    const cancel = () => {
      void policy.cleanup();
    };
    signal.throwIfAborted();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      policy.configure({ ...this.configManager.getConfig(), ...config });
      await policy.refresh();
      signal.throwIfAborted();
      return policy.getSnapshot();
    } finally {
      signal.removeEventListener('abort', cancel);
      await policy.cleanup();
    }
  }

  async applySetupConfig(config: SetupConfig): Promise<void> {
    await this.configManager.setValues({
      ...config,
      ...(config.provider !== this.configManager.getConfig().provider ? { service_model: null } : {}),
      setup_completed: true,
    });
  }

  getContextSizeOptions(savedSize?: number): Array<{ value: number; label: string }> {
    const options: Array<{ value: number; label: string }> = [
      { value: CONTEXT_SIZES.MEDIUM, label: '32K · Recommended starting point' },
      { value: CONTEXT_SIZES.LARGE, label: '64K · More working context' },
      { value: CONTEXT_SIZES.XLARGE, label: '128K · Requires more memory' },
      { value: CONTEXT_SIZES.XXLARGE, label: '256K · Requires more memory' },
    ];
    if (savedSize && !options.some(option => option.value === savedSize))
      options.push({ value: savedSize, label: `${savedSize.toLocaleString()} tokens · Saved setting` });
    return options;
  }
}
