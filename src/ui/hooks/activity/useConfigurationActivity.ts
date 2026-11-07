/** Terminal activity domain: configuration. */
import { useEffect, useMemo, useRef } from 'react';
import { ActivityEventType } from '@shared/index.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { createModelConfigCoordinator } from '@services/createModelConfigCoordinator.js';
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
    () => createModelConfigCoordinator(ServiceRegistry.getInstance(), agent),
    [agent]
  );

  useDomainActivityEvent(
    ActivityEventType.MODEL_SELECT_REQUEST,
    event => {
      const { requestId, models, currentModel, modelType, typeName } = event.data;
      loadingOwner.current = undefined;
      modal.setModelSelectRequest({ requestId, models, currentModel, modelType, typeName });
      const current = models.findIndex(model => model.name === currentModel);
      modal.setModelSelectedIndex(Math.max(0, current));
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
    () => {
      modal.setSetupWizardOpen(false);
      actions.addMessage({ role: 'assistant', content: 'Setup complete. Your saved settings are active.' });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.SETUP_WIZARD_SKIP,
    () => {
      modal.setSetupWizardOpen(false);
      actions.addMessage({
        role: 'assistant',
        content: 'Setup closed. Run /config setup to return.',
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
      // Commands publish saved configuration, including saved changes awaiting runtime recovery.
      actions.updateConfig(event.data);
    },
    lifetime
  );
}
