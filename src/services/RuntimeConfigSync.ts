import type { Config } from '../types/index.js';
import { MessageHistory } from '../llm/MessageHistory.js';
import { ServiceRegistry } from './ServiceRegistry.js';
import { IdleMessageGenerator } from './IdleMessageGenerator.js';
import { SessionTitleGenerator } from './SessionTitleGenerator.js';
import { logger } from './Logger.js';

function hasUpdate<K extends keyof Config>(updates: Partial<Config>, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(updates, key);
}

function setIfAvailable(target: unknown, method: string, value: unknown): void {
  const fn = (target as any)?.[method];
  if (typeof fn === 'function') {
    fn.call(target, value);
  }
}

function syncCommonModelClientSettings(client: unknown, updates: Partial<Config>): void {
  if (hasUpdate(updates, 'endpoint')) {
    setIfAvailable(client, 'setEndpoint', updates.endpoint);
  }
  if (hasUpdate(updates, 'temperature')) {
    setIfAvailable(client, 'setTemperature', updates.temperature);
  }
  if (hasUpdate(updates, 'context_size')) {
    setIfAvailable(client, 'setContextSize', updates.context_size);
  }
  if (hasUpdate(updates, 'max_tokens')) {
    setIfAvailable(client, 'setMaxTokens', updates.max_tokens);
  }
  if (hasUpdate(updates, 'reasoning_effort')) {
    setIfAvailable(client, 'setReasoningEffort', updates.reasoning_effort);
  }
}

/**
 * Synchronize live runtime services after ConfigManager has changed.
 *
 * ConfigManager is the durable source of truth, but several runtime objects keep
 * construction-time copies for speed or ownership isolation. This function is
 * the single place that pushes typed config changes into those live objects.
 */
export function applyRuntimeConfigUpdates(
  serviceRegistry: ServiceRegistry,
  updates: Partial<Config>
): Config | null {
  const configManager = serviceRegistry.get<any>('config_manager');
  const fullConfig = configManager?.getConfig?.() as Config | undefined;

  if (!fullConfig) {
    logger.warn('[RUNTIME_CONFIG] ConfigManager unavailable; skipped runtime config sync');
    return null;
  }

  const modelClient = serviceRegistry.get<any>('model_client');
  const serviceModelClient = serviceRegistry.get<any>('service_model_client');

  syncCommonModelClientSettings(modelClient, updates);
  syncCommonModelClientSettings(serviceModelClient, updates);

  if (hasUpdate(updates, 'model')) {
    setIfAvailable(modelClient, 'setModelName', fullConfig.model ?? '');
  }

  if (hasUpdate(updates, 'service_model') || (hasUpdate(updates, 'model') && !fullConfig.service_model)) {
    setIfAvailable(serviceModelClient, 'setModelName', fullConfig.service_model ?? fullConfig.model ?? '');
  }

  const activeAgent = serviceRegistry.get<any>('agent');
  if (typeof activeAgent?.applyConfigUpdates === 'function') {
    activeAgent.applyConfigUpdates(updates);

    if (typeof activeAgent.getTokenManager === 'function') {
      serviceRegistry.registerInstance('token_manager', activeAgent.getTokenManager());
    }
  }

  const agentPool = serviceRegistry.get<any>('agent_pool');
  if (typeof agentPool?.applyConfigUpdates === 'function') {
    agentPool.applyConfigUpdates(updates);
  }

  if (hasUpdate(updates, 'context_size')) {
    const messageHistory = serviceRegistry.get<MessageHistory>('message_history');
    messageHistory?.setMaxTokens(fullConfig.context_size);
  }

  if (hasUpdate(updates, 'auto_confirm')) {
    const trustManager = serviceRegistry.get<any>('trust_manager');
    setIfAvailable(trustManager, 'setAutoConfirm', fullConfig.auto_confirm);
  }

  const toolManager = serviceRegistry.get<any>('tool_manager');
  const bashTool = toolManager?.getTool?.('bash');
  if (typeof bashTool?.setConfig === 'function') {
    bashTool.setConfig(fullConfig);
  }

  if (hasUpdate(updates, 'enable_idle_messages')) {
    const idleMessageGenerator = serviceRegistry.get<any>('idle_message_generator');
    if (fullConfig.enable_idle_messages) {
      if (!idleMessageGenerator) {
        if (serviceModelClient) {
          serviceRegistry.registerInstance('idle_message_generator', new IdleMessageGenerator(serviceModelClient));
        } else {
          logger.warn('[RUNTIME_CONFIG] Cannot enable idle messages: service model client unavailable');
        }
      }
    } else {
      idleMessageGenerator?.cancel?.();
      serviceRegistry.registerInstance('idle_message_generator', null);
    }
  }

  if (hasUpdate(updates, 'enable_session_title_generation')) {
    let sessionTitleGenerator = serviceRegistry.get<any>('session_title_generator');
    if (!sessionTitleGenerator && serviceModelClient) {
      const sessionManager = serviceRegistry.get<any>('session_manager');
      if (sessionManager) {
        sessionTitleGenerator = new SessionTitleGenerator(
          serviceModelClient,
          sessionManager,
          fullConfig.enable_session_title_generation
        );
        serviceRegistry.registerInstance('session_title_generator', sessionTitleGenerator);
      }
    }
    if (!fullConfig.enable_session_title_generation) {
      sessionTitleGenerator?.cancel?.();
    }
    setIfAvailable(sessionTitleGenerator, 'setEnabled', fullConfig.enable_session_title_generation);
  }

  return fullConfig;
}
