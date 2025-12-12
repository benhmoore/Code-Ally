/**
 * useBackgroundTaskProd - Prod Ally when background tasks complete
 *
 * When a background task (agent or bash) completes and Ally is idle
 * (not thinking, last turn ended naturally), automatically send a
 * silent system message to prod Ally to check on the completed task.
 * The prod is invisible to the user - only Ally's response is shown.
 */

import { useRef, useEffect } from 'react';
import { ActivityEventType } from '@shared/index.js';
import { useActivityEvent } from './useActivityEvent.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { Agent } from '@agent/Agent.js';
import { logger } from '@services/Logger.js';
import { BACKGROUND_TASK_PROD } from '@config/constants.js';

interface UseBackgroundTaskProdOptions {
  /** Whether Ally is currently thinking */
  isThinking: boolean;
  /** Callback to set thinking state */
  setIsThinking: (value: boolean) => void;
}

/**
 * Hook to automatically prod Ally when background tasks complete
 *
 * @param options - Configuration options
 */
export const useBackgroundTaskProd = (options: UseBackgroundTaskProdOptions): void => {
  const { isThinking, setIsThinking } = options;

  // Track whether the last agent turn ended naturally (vs interrupted)
  const lastTurnEndedNaturally = useRef(true);

  // Track whether we're currently in a prod (to avoid double-prodding)
  const isProdding = useRef(false);

  // Debounce timer to batch multiple completions
  const prodDebounceTimer = useRef<NodeJS.Timeout | null>(null);

  // Store pending prod message
  const pendingProdRef = useRef<string | null>(null);

  // Track isThinking in ref for use in callbacks
  const isThinkingRef = useRef(isThinking);
  useEffect(() => {
    isThinkingRef.current = isThinking;
  }, [isThinking]);

  // Track setIsThinking in ref
  const setIsThinkingRef = useRef(setIsThinking);
  useEffect(() => {
    setIsThinkingRef.current = setIsThinking;
  }, [setIsThinking]);

  /**
   * Send a silent prod to the agent (no visible user message)
   */
  const sendSilentProd = async (message: string): Promise<void> => {
    const registry = ServiceRegistry.getInstance();
    const agent = registry.get<Agent>('agent');

    if (!agent) {
      logger.debug('[BG_TASK_PROD] No agent available');
      return;
    }

    // Set thinking state so UI shows activity
    setIsThinkingRef.current(true);

    try {
      // Send directly to agent - the prod message won't appear in UI
      // but the response will be added to conversation normally
      await agent.sendMessage(message);
    } finally {
      setIsThinkingRef.current(false);
    }
  };

  /**
   * Attempt to send prod if conditions are met
   */
  const attemptProd = (message: string) => {
    // Don't prod if already thinking
    if (isThinkingRef.current) {
      logger.debug('[BG_TASK_PROD] Skipping prod - Ally is currently thinking');
      return;
    }

    // Don't prod if last turn was interrupted (user cancelled)
    if (!lastTurnEndedNaturally.current) {
      logger.debug('[BG_TASK_PROD] Skipping prod - last turn was interrupted by user');
      return;
    }

    // Don't double-prod
    if (isProdding.current) {
      logger.debug('[BG_TASK_PROD] Skipping prod - already prodding');
      return;
    }

    // Clear any pending debounce
    if (prodDebounceTimer.current) {
      clearTimeout(prodDebounceTimer.current);
      prodDebounceTimer.current = null;
    }

    // Store the message and debounce
    pendingProdRef.current = message;

    // Debounce to batch multiple completions that happen close together
    prodDebounceTimer.current = setTimeout(async () => {
      prodDebounceTimer.current = null;

      // Re-check conditions after debounce
      if (isThinkingRef.current || !lastTurnEndedNaturally.current || isProdding.current) {
        logger.debug('[BG_TASK_PROD] Conditions changed during debounce, skipping prod');
        pendingProdRef.current = null;
        return;
      }

      const prodMessage = pendingProdRef.current;
      pendingProdRef.current = null;

      if (!prodMessage) return;

      logger.debug('[BG_TASK_PROD] Sending silent prod');
      isProdding.current = true;

      try {
        await sendSilentProd(prodMessage);
      } catch (error) {
        logger.debug('[BG_TASK_PROD] Prod failed:', error);
      } finally {
        isProdding.current = false;
      }
    }, BACKGROUND_TASK_PROD.DEBOUNCE_MS);
  };

  // Track agent end to determine if turn ended naturally
  useActivityEvent(ActivityEventType.AGENT_END, (event) => {
    const isSpecialized = event.data?.isSpecializedAgent || false;
    const wasInterrupted = event.data?.interrupted || false;

    // Only track root agent ends (not sub-agents)
    if (!isSpecialized) {
      lastTurnEndedNaturally.current = !wasInterrupted;
      logger.debug('[BG_TASK_PROD] Root agent ended, natural:', !wasInterrupted);
    }
  });

  // Track user interrupts
  useActivityEvent(ActivityEventType.USER_INTERRUPT_INITIATED, () => {
    lastTurnEndedNaturally.current = false;
    logger.debug('[BG_TASK_PROD] User interrupt detected');

    // Clear any pending prod
    if (prodDebounceTimer.current) {
      clearTimeout(prodDebounceTimer.current);
      prodDebounceTimer.current = null;
    }
    pendingProdRef.current = null;
  });

  // Listen for background agent completion
  useActivityEvent(ActivityEventType.BACKGROUND_AGENT_COMPLETE, (event) => {
    const agentId = event.data?.agentId;
    logger.debug('[BG_TASK_PROD] Background agent completed:', agentId);
    attemptProd(BACKGROUND_TASK_PROD.AGENT_COMPLETE_MESSAGE);
  });

  // Listen for background agent error
  useActivityEvent(ActivityEventType.BACKGROUND_AGENT_ERROR, (event) => {
    const agentId = event.data?.agentId;
    logger.debug('[BG_TASK_PROD] Background agent errored:', agentId);
    attemptProd(BACKGROUND_TASK_PROD.AGENT_ERROR_MESSAGE);
  });

  // Listen for background process exit
  useActivityEvent(ActivityEventType.BACKGROUND_PROCESS_EXIT, (event) => {
    const shellId = event.data?.shellId;
    const exitCode = event.data?.exitCode;
    logger.debug('[BG_TASK_PROD] Background process exited:', shellId, 'code:', exitCode);

    // Only prod for unexpected exits (exit code !== 0) or completed processes
    // Skip for normal server shutdowns etc
    if (exitCode === 0) {
      attemptProd(BACKGROUND_TASK_PROD.PROCESS_COMPLETE_MESSAGE);
    } else {
      attemptProd(BACKGROUND_TASK_PROD.PROCESS_ERROR_MESSAGE);
    }
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (prodDebounceTimer.current) {
        clearTimeout(prodDebounceTimer.current);
      }
    };
  }, []);
};
