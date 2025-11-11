/**
 * useServiceInitialization - Initialize services and check for first-run setup
 *
 * This hook handles the initialization of command history, completion provider,
 * command handler, and checks if the setup wizard needs to be shown on first run.
 */

import { useEffect, useRef, useState } from 'react';
import { Agent } from '../../agent/Agent.js';
import { CommandHistory } from '../../services/CommandHistory.js';
import { CompletionProvider } from '../../services/CompletionProvider.js';
import { CommandHandler } from '../../agent/CommandHandler.js';
import { AgentManager } from '../../services/AgentManager.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ConfigManager } from '../../services/ConfigManager.js';
import { AppActions } from '../contexts/AppContext.js';

/**
 * Result of service initialization
 */
export interface ServiceInitializationResult {
  /** Command history instance */
  commandHistory: CommandHistory | null;
  /** Completion provider instance */
  completionProvider: CompletionProvider | null;
  /** Command handler instance */
  commandHandler: CommandHandler | null;
  /** Whether setup wizard should be shown */
  shouldShowSetupWizard: boolean;
}

/**
 * Initialize application services and check for first-run setup
 *
 * @param agent - The agent instance
 * @param actions - App context actions
 * @param showSetupWizard - Force show setup wizard (from --init flag)
 * @returns Service instances and setup wizard state
 *
 * @example
 * ```tsx
 * const { commandHistory, completionProvider, commandHandler, shouldShowSetupWizard } =
 *   useServiceInitialization(agent, actions, props.showSetupWizard);
 *
 * if (shouldShowSetupWizard) {
 *   setSetupWizardOpen(true);
 * }
 * ```
 */
export const useServiceInitialization = (
  agent: Agent,
  actions: AppActions,
  showSetupWizard?: boolean
): ServiceInitializationResult => {
  const commandHistory = useRef<CommandHistory | null>(null);
  const [completionProvider, setCompletionProvider] = useState<CompletionProvider | null>(null);
  const commandHandler = useRef<CommandHandler | null>(null);
  const [shouldShowSetupWizard, setShouldShowSetupWizard] = useState(false);
  const firstRunChecked = useRef(false);

  useEffect(() => {
    const initializeServices = async () => {
      try {
        // Get service registry and config manager
        const serviceRegistry = ServiceRegistry.getInstance();
        const configManager = serviceRegistry.get<ConfigManager>('config_manager');

        // First-run detection: Check if setup has been completed
        // OR if explicitly requested via --init flag
        // OR if required configuration values are missing
        if (configManager && !firstRunChecked.current) {
          firstRunChecked.current = true;
          const setupCompleted = configManager.getValue('setup_completed');

          // Check for required configuration values
          const endpoint = configManager.getValue('endpoint');
          const model = configManager.getValue('model');

          // Force setup if:
          // 1. Setup not completed
          // 2. Explicitly requested via --init flag
          // 3. Missing critical config (endpoint or model)
          const requiresSetup = !setupCompleted ||
                               showSetupWizard ||
                               !endpoint ||
                               !model;

          if (requiresSetup) {
            setShouldShowSetupWizard(true);
          }
        }

        // Create and load command history
        const history = new CommandHistory();
        await history.load();
        commandHistory.current = history;

        // Create completion provider with agent manager and config manager
        const agentManager = new AgentManager();
        const provider = new CompletionProvider(agentManager, configManager || undefined);
        setCompletionProvider(provider);

        // Create command handler with service registry and config manager
        if (configManager) {
          const handler = new CommandHandler(agent, configManager, serviceRegistry);
          commandHandler.current = handler;
        }

        // Initialize context usage from TokenManager
        const tokenManager = serviceRegistry.get('token_manager');
        if (tokenManager && typeof (tokenManager as any).getContextUsagePercentage === 'function') {
          const initialContextUsage = (tokenManager as any).getContextUsagePercentage();
          actions.setContextUsage(initialContextUsage);
        }
      } catch (error) {
        console.error('Failed to initialize input services:', error);
        // Continue without services
      }
    };

    initializeServices();
  }, [agent, actions, showSetupWizard]);

  return {
    commandHistory: commandHistory.current,
    completionProvider,
    commandHandler: commandHandler.current,
    shouldShowSetupWizard,
  };
};
