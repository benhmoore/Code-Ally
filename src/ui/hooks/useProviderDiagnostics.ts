import { useEffect } from 'react';
import { runStartupValidation } from '../../cli/validation.js';
import type { ActivityStream } from '../../services/ActivityStream.js';
import { ActivityEventType, type Config } from '../../types/index.js';

/** Advisory discovery runs after mount and never takes focus from active input. */
export function useProviderDiagnostics(enabled: boolean, config: Config, stream: ActivityStream): void {
  const { provider, endpoint, model, api_key } = config;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const report = (message: string) => {
      if (controller.signal.aborted) return;
      stream.emit({ id: `provider-diagnostic-${Date.now()}`, timestamp: Date.now(),
        type: ActivityEventType.STATUS_MESSAGE, data: { message } });
    };
    // Snapshot only the values discovery uses, so unrelated config updates do
    // not restart requests. Cleanup rejects stale results after a model switch.
    void runStartupValidation({ provider, endpoint, model, api_key } as Config, controller.signal).then(result => {
      if (!result.providerConnected) {
        report(`Cannot connect to ${provider ?? 'ollama'} endpoint ${endpoint}: ${result.error ?? 'Connection failed'}. Use /config setup to configure the provider, or start the server and try again.`);
      } else if (result.modelStatus === 'missing') {
        report(`Model '${model}' was not reported by ${provider ?? 'ollama'}. Use /model to choose an available model.`);
      }
    }).catch(error => {
      if (!controller.signal.aborted) report(`Provider check failed: ${error instanceof Error ? error.message : String(error)}. Use /config setup to review your configuration.`);
    });
    return () => controller.abort();
  }, [enabled, provider, endpoint, model, api_key, stream]);
}
