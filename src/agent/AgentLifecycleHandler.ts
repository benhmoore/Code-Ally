/** Owns idle-model admission and post-response cleanup for one agent turn. */
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import type { IdleTaskCoordinator } from '../services/IdleTaskCoordinator.js';
import { logger } from '../services/Logger.js';
import type { Message } from '../types/index.js';

export class AgentLifecycleHandler {
  private coordinator?: IdleTaskCoordinator;
  private completedMessages?: readonly Message[];

  constructor(private readonly instanceId: string, private readonly ownsSession = true) {}

  notifyUserMessageStart(): void {
    if (this.coordinator) return;
    const coordinator = ServiceRegistry.getInstance().get('idle_task_coordinator');
    if (!coordinator) return;
    this.coordinator = coordinator;
    coordinator.cancel();
    coordinator.notifyUserMessage();
    coordinator.setOllamaActive(true);
  }

  async handlePostResponse(
    messages: readonly Message[],
    queueCleanup: (ids: string[]) => void,
  ): Promise<void> {
    // Finalization can re-enter generation on steering. Keep the model lease
    // until the whole admitted turn settles, including its final hooks.
    this.completedMessages = messages;
    const registry = ServiceRegistry.getInstance();
    if (!this.ownsSession || !registry.get('auto_tool_cleanup')) return;
    const sessionManager = registry.get('session_manager');
    const sessionName = sessionManager?.getCurrentSession();
    if (!sessionManager || !sessionName) return;
    try {
      const session = await sessionManager.loadSession(sessionName);
      const pending = session?.metadata?.pendingToolCleanups;
      if (pending?.length) {
        queueCleanup(pending);
        await sessionManager.updateMetadata(sessionName, { pendingToolCleanups: [] });
      }
    } catch (error) {
      logger.debug('[AGENT]', 'Error checking pending tool cleanups:', error);
    }
  }

  /** Release exactly the owner acquired at start, even on repeated cleanup. */
  notifyOllamaInactive(): void {
    const coordinator = this.coordinator;
    const messages = this.completedMessages;
    this.coordinator = undefined;
    this.completedMessages = undefined;
    if (!coordinator) return;
    coordinator.setOllamaActive(false);
    if (!messages || !this.ownsSession) return;
    const detector = ServiceRegistry.getInstance().get('project_context_detector');
    void coordinator.checkAndRunIdleTasks([...messages], {
      os: process.platform,
      cwd: process.cwd(),
      projectContext: detector?.getCached() ?? undefined,
    }).catch(error => {
      logger.debug('[AGENT_IDLE_COORD]', this.instanceId, 'Error checking idle tasks:', error);
    });
  }
}
