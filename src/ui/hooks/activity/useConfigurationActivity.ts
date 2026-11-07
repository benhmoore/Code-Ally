/** Terminal activity domain: configuration. */
import { useEffect, useMemo, useRef } from 'react';
import { ActivityEventType } from '@shared/index.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { applyRuntimeConfigUpdates } from '@services/RuntimeConfigSync.js';
import { ModelConfigCoordinator } from '@services/ModelConfigCoordinator.js';
import { probeModelCapabilities } from '@llm/ProviderAdapter.js';
import type { ActivitySubscriptionContext } from './ActivitySubscriptionContext.js';
import { useDomainActivityEvent } from './useDomainActivityEvent.js';

export function useConfigurationActivity({ actions, modal, agent, lifetime }: ActivitySubscriptionContext) {
  const currentModal = useRef(modal);
  currentModal.current = modal;
  const mounted = useRef(true);
  const loadingOwner = useRef<symbol | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const modelConfigCoordinator = useMemo(
    () =>
      new ModelConfigCoordinator({
        getConfigManager: () => ServiceRegistry.getInstance().get('config_manager'),
        applyRuntimeConfig: updates => applyRuntimeConfigUpdates(ServiceRegistry.getInstance(), updates),
        validatePrimaryModelSwitch: modelName => agent.getModelIdentityChangeBlock({ model: modelName }),
        testModelCapabilities: async (_endpoint, modelName) => {
          const config = ServiceRegistry.getInstance().get('config_manager')?.getConfig();
          if (!config) return { supportsTools: true, supportsImages: true, fromCache: false };
          const capabilities = await probeModelCapabilities(config, modelName);
          return {
            supportsTools: capabilities.tools !== 'unsupported',
            supportsImages: capabilities.images !== 'unsupported',
            fromCache: capabilities.fromCache ?? false,
          };
        },
      }),
    [agent]
  );

  useDomainActivityEvent(
    ActivityEventType.MODEL_SELECT_REQUEST,
    event => {
      const { requestId, models, currentModel, modelType, typeName } = event.data;
      loadingOwner.current = undefined;
      modal.setModelSelectRequest({ requestId, models, currentModel, modelType, typeName });
      modal.setModelSelectedIndex(0);
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.SETUP_WIZARD_REQUEST,
    () => {
      modal.setSetupWizardOpen(true);
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.SETUP_WIZARD_COMPLETE,
    async (_event, isCurrent) => {
      modal.setSetupWizardOpen(false);

      const registry = ServiceRegistry.getInstance();
      const configManager = registry.get('config_manager');

      if (configManager) {
        try {
          await configManager.initialize();
          if (!isCurrent()) return;
          const newConfig = configManager.getConfig();

          applyRuntimeConfigUpdates(registry, newConfig);

          actions.updateConfig(newConfig);

          actions.addMessage({
            role: 'assistant',
            content: 'Setup completed successfully! Code Ally is ready to use.',
          });
        } catch (error) {
          if (!isCurrent()) return;
          actions.addMessage({
            role: 'assistant',
            content: `Setup completed, but failed to apply some changes: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      } else {
        actions.addMessage({
          role: 'assistant',
          content: 'Setup completed successfully! Code Ally is ready to use.',
        });
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.SETUP_WIZARD_SKIP,
    () => {
      modal.setSetupWizardOpen(false);
      actions.addMessage({
        role: 'assistant',
        content: 'Setup wizard skipped. You can run /init anytime to configure Code Ally.',
      });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.MODEL_SELECT_RESPONSE,
    async (event, isCurrent) => {
      const { modelName, modelType } = event.data;

      const slot = modelConfigCoordinator.resolveModelSlot(modelType, modal.modelSelectRequest?.modelType);

      // If cancelled (no model selected), just clear the UI
      if (!modelName) {
        loadingOwner.current = undefined;
        modal.setModelSelectLoading(false);
        modal.setModelSelectRequest(undefined);
        modal.setModelSelectedIndex(0);
        return;
      }

      // Show loading state while testing capabilities
      const owner = Symbol('model selection');
      loadingOwner.current = owner;
      modal.setModelSelectLoading(true);

      const pendingRequestId = currentModal.current.modelSelectRequest?.requestId;
      const outcome = await modelConfigCoordinator.switchModel(modelName, slot, isCurrent);
      // Committed model state belongs to the root configuration, even when the
      // initiating picker or foreground conversation has since changed.
      if (outcome.configUpdate && mounted.current) {
        const authoritative = ServiceRegistry.getInstance().get('config_manager')?.getConfig();
        actions.updateConfig(authoritative ?? outcome.configUpdate);
      }
      if (!isCurrent()) {
        if (
          mounted.current &&
          loadingOwner.current === owner &&
          pendingRequestId &&
          currentModal.current.modelSelectRequest?.requestId === pendingRequestId
        ) {
          modal.setModelSelectLoading(false);
        }
        return;
      }

      loadingOwner.current = undefined;
      modal.setModelSelectLoading(false);
      modal.setModelSelectRequest(undefined);
      modal.setModelSelectedIndex(0);

      for (const content of outcome.messages) {
        actions.addMessage({ role: 'assistant', content });
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.CONFIG_UPDATED,
    event => {
      const updates = modelConfigCoordinator.normalizeConfigUpdates(event.data);
      if (!updates) return;

      // UI state first, runtime services second.
      actions.updateConfig(updates);
      modelConfigCoordinator.applyRuntimeUpdates(updates);
    },
    lifetime
  );
}
