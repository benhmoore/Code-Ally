/**
 * AgentLifecycleHandler - Handles peripheral lifecycle events for Agent
 *
 * Extracts cross-cutting concerns from Agent.ts:
 * - Idle coordinator notifications
 * - Auto tool cleanup processing
 * - Post-response housekeeping
 */

import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { logger } from '../services/Logger.js';
import type { Message } from '../types/index.js';

export interface PluginActivationResult {
  systemMessage?: Message;
}

export class AgentLifecycleHandler {
  private instanceId: string;

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  /**
   * Parse and activate plugins from user message
   * Returns system message to add if plugins were activated/deactivated
   */
  parsePluginActivations(message: string): PluginActivationResult {
    try {
      const registry = ServiceRegistry.getInstance();
      const activationManager = registry.getPluginActivationManager();
      const { activated, deactivated } = activationManager.parseAndActivateTags(message);

      const parts: string[] = [];
      if (activated.length > 0) parts.push(`Activated plugins: ${activated.join(', ')}`);
      if (deactivated.length > 0) parts.push(`Deactivated plugins: ${deactivated.join(', ')}`);

      if (parts.length > 0) {
        return {
          systemMessage: {
            role: 'system',
            content: `[System: ${parts.join('. ')}. Tools from active plugins are now available.]`,
            timestamp: Date.now(),
          }
        };
      }
    } catch (error) {
      logger.debug(`[AGENT_PLUGIN_ACTIVATION] Could not parse plugin tags: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {};
  }

  /**
   * Notify services that a user message was received
   */
  notifyUserMessageStart(): void {
    const registry = ServiceRegistry.getInstance();
    const coordinator = registry.get('idle_task_coordinator');
    if (coordinator) {
      (coordinator as any).notifyUserMessage();
      (coordinator as any).setOllamaActive(true);
      logger.debug('[AGENT_IDLE_COORD]', this.instanceId, 'Notified idle coordinator: user message, Ollama active');
    }
  }

  /**
   * Handle post-response lifecycle tasks
   */
  async handlePostResponse(
    messages: readonly Message[],
    queueCleanup: (ids: string[]) => void
  ): Promise<void> {
    const registry = ServiceRegistry.getInstance();
    const coordinator = registry.get('idle_task_coordinator');

    // Notify idle coordinator that Ollama is idle
    if (coordinator) {
      (coordinator as any).setOllamaActive(false);
      logger.debug('[AGENT_IDLE_COORD]', this.instanceId, 'Ollama inactive, checking for idle tasks');

      // Trigger idle tasks with context
      const projectContextDetector = registry.get('project_context_detector');
      const sessionManager = registry.get('session_manager');
      const currentSession = sessionManager ? (sessionManager as any).getCurrentSession() : null;
      const sessionTitle = currentSession?.title;
      const hasMeaningfulTitle = sessionTitle && !sessionTitle.startsWith('session_');

      (coordinator as any).checkAndRunIdleTasks(messages, {
        os: process.platform,
        sessionTitle: hasMeaningfulTitle ? sessionTitle : undefined,
        cwd: process.cwd(),
        projectContext: projectContextDetector ? (projectContextDetector as any).getCached() : undefined
      }).catch((error: Error) => {
        logger.debug('[AGENT_IDLE_COORD] Error checking idle tasks:', error);
      });
    }

    // Process queued tool cleanups from idle analysis
    await this.processQueuedCleanups(queueCleanup);
  }

  /**
   * Process any queued tool cleanups from idle analysis
   */
  private async processQueuedCleanups(queueCleanup: (ids: string[]) => void): Promise<void> {
    const registry = ServiceRegistry.getInstance();
    const autoToolCleanup = registry.get('auto_tool_cleanup');
    if (!autoToolCleanup) return;

    try {
      const sessionManager = registry.get('session_manager');
      const currentSession = sessionManager ? (sessionManager as any).getCurrentSession() : null;
      if (!currentSession) return;

      const session = await (sessionManager as any).loadSession(currentSession);
      const pendingCleanups = session?.metadata?.pendingToolCleanups;

      if (pendingCleanups && Array.isArray(pendingCleanups) && pendingCleanups.length > 0) {
        logger.debug('[AGENT]', `Executing ${pendingCleanups.length} queued tool cleanups:`, pendingCleanups.join(', '));
        queueCleanup(pendingCleanups);

        await (sessionManager as any).updateMetadata(currentSession, {
          pendingToolCleanups: [],
        });
        logger.debug('[AGENT]', 'Queued cleanups cleared from session metadata');
      }
    } catch (error) {
      logger.debug('[AGENT]', 'Error checking for pending tool cleanups:', error);
    }
  }

  /**
   * Notify services that Ollama is inactive (for cleanup paths)
   */
  notifyOllamaInactive(): void {
    const registry = ServiceRegistry.getInstance();
    const coordinator = registry.get('idle_task_coordinator');
    if (coordinator) {
      (coordinator as any).setOllamaActive(false);
      logger.debug('[AGENT_IDLE_COORD]', this.instanceId, 'Ollama inactive (cleanup)');
    }
  }
}
