/**
 * IdleTaskCoordinator - Manages priority-based idle task execution
 *
 * Coordinates three background idle tasks with different priorities:
 * 1. Priority 1: Session title regeneration (when title needs updating)
 * 2. Priority 2: Idle message generation (when queue is low)
 * 3. Priority 3: Tool cleanup analysis (when tool results accumulate)
 *
 * Only runs idle tasks when Ollama is not actively processing requests.
 */

import { SessionTitleGenerator } from './SessionTitleGenerator.js';
import { IdleMessageGenerator, IdleContext } from './IdleMessageGenerator.js';
import { AutoToolCleanupService } from './AutoToolCleanupService.js';
import { SessionManager } from './SessionManager.js';
import { Message, IService } from '../types/index.js';
import { logger } from './Logger.js';
import { setTerminalTitle } from '../utils/terminal.js';
import { POLLING_INTERVALS } from '../config/constants.js';

/**
 * IdleTaskCoordinator manages priority-based execution of background tasks
 */
export class IdleTaskCoordinator implements IService {
  private lastUserMessageTimestamp: number = 0;
  private lastTitleGenerationTimestamp: number = 0;
  private isOllamaActive: boolean = false;
  private lastModelResponseTimestamp: number = 0;
  private retryTimeoutId: NodeJS.Timeout | null = null;
  private activeAgentCount: number = 0; // Track nested agent activity with reference counting

  constructor(
    private sessionTitleGenerator: SessionTitleGenerator | null,
    private idleMessageGenerator: IdleMessageGenerator | null,
    private autoToolCleanup: AutoToolCleanupService | null,
    private sessionManager: SessionManager
  ) {}

  async initialize(): Promise<void> {
    logger.debug('[IDLE_COORD] IdleTaskCoordinator initialized');
  }

  async cleanup(): Promise<void> {
    logger.debug('[IDLE_COORD] IdleTaskCoordinator cleanup');

    // Clear any pending retry timeout
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }
  }

  /**
   * Set whether Ollama is currently active
   *
   * Uses reference counting to track nested agent activity.
   * Only marks as truly idle when all agents have completed.
   *
   * @param active - True if Ollama is processing a request
   */
  setOllamaActive(active: boolean): void {
    if (active) {
      // Increment counter when any agent starts
      this.activeAgentCount++;
      logger.debug(`[IDLE_COORD] Agent started, active count: ${this.activeAgentCount}`);

      // Mark as active
      this.isOllamaActive = true;

      // Clear any pending retry when new agent starts
      if (this.retryTimeoutId) {
        logger.debug('[IDLE_COORD] Agent started, cancelling pending retry');
        clearTimeout(this.retryTimeoutId);
        this.retryTimeoutId = null;
      }
    } else {
      // Decrement counter when any agent finishes
      this.activeAgentCount = Math.max(0, this.activeAgentCount - 1);
      logger.debug(`[IDLE_COORD] Agent finished, active count: ${this.activeAgentCount}`);

      // Only mark as truly idle when ALL agents have completed
      if (this.activeAgentCount === 0) {
        this.isOllamaActive = false;
        this.lastModelResponseTimestamp = Date.now();
        logger.debug(`[IDLE_COORD] All agents completed at: ${this.lastModelResponseTimestamp}`);
      } else {
        logger.debug(`[IDLE_COORD] Still ${this.activeAgentCount} active agent(s), remaining active`);
      }
    }
  }

  /**
   * Notify coordinator that user sent a message
   *
   * Updates lastUserMessageTimestamp to track when title regeneration might be needed.
   */
  notifyUserMessage(): void {
    this.lastUserMessageTimestamp = Date.now();
    logger.debug(`[IDLE_COORD] User message timestamp updated: ${this.lastUserMessageTimestamp}`);
  }

  /**
   * Notify coordinator that title generation completed
   *
   * Updates lastTitleGenerationTimestamp to prevent redundant regeneration.
   */
  notifyTitleGenerated(): void {
    this.lastTitleGenerationTimestamp = Date.now();
    logger.debug(`[IDLE_COORD] Title generation timestamp updated: ${this.lastTitleGenerationTimestamp}`);
  }

  /**
   * Initialize coordinator from session data
   *
   * Restores lastTitleGenerationTimestamp from persisted session metadata.
   * This should be called when loading a session to restore state.
   *
   * @param session - Session data with metadata
   */
  initializeFromSession(session: any): void {
    if (session?.metadata?.lastTitleGeneratedAt) {
      this.lastTitleGenerationTimestamp = session.metadata.lastTitleGeneratedAt;
      logger.debug(`[IDLE_COORD] Restored lastTitleGenTimestamp from session: ${this.lastTitleGenerationTimestamp}`);
    }
  }

  /**
   * Check and run idle tasks based on priority
   *
   * Priority 1: Session title regeneration (if needed)
   * Priority 2: Idle message generation (if queue low)
   * Priority 3: Tool cleanup analysis (if tool results accumulate)
   *
   * @param messages - Current conversation messages
   * @param context - Additional context for idle message generation
   */
  async checkAndRunIdleTasks(messages: Message[], context?: IdleContext): Promise<void> {
    logger.debug('[IDLE_COORD] checkAndRunIdleTasks called');

    // Return immediately if Ollama is active
    if (this.isOllamaActive) {
      logger.debug('[IDLE_COORD] Skipping idle tasks - Ollama is active');
      return;
    }

    // Check cooldown period after model response
    const now = Date.now();
    const timeSinceResponse = now - this.lastModelResponseTimestamp;
    if (timeSinceResponse < POLLING_INTERVALS.IDLE_TASK_COOLDOWN) {
      const timeLeft = POLLING_INTERVALS.IDLE_TASK_COOLDOWN - timeSinceResponse;
      const timeLeftSeconds = Math.round(timeLeft / 1000);
      logger.debug(`[IDLE_COORD] Cooldown active (${timeLeftSeconds}s remaining), scheduling retry`);

      // Clear any existing retry timeout
      if (this.retryTimeoutId) {
        clearTimeout(this.retryTimeoutId);
      }

      // Schedule retry after cooldown period expires
      this.retryTimeoutId = setTimeout(() => {
        logger.debug('[IDLE_COORD] Cooldown expired, retrying idle tasks');
        this.retryTimeoutId = null;
        this.checkAndRunIdleTasks(messages, context).catch((error: Error) => {
          logger.debug('[IDLE_COORD] Error during retry:', error);
        });
      }, timeLeft);

      return;
    }

    // Check if generators are initialized
    if (!this.sessionTitleGenerator && !this.idleMessageGenerator && !this.autoToolCleanup) {
      logger.debug('[IDLE_COORD] No generators initialized, skipping idle tasks');
      return;
    }

    // Priority 1: Check if title needs generation or regeneration
    logger.debug('[IDLE_COORD] Checking if title work needed...');
    if (await this.needsTitleWork()) {
      logger.debug('[IDLE_COORD] Title work needed, running regeneration');
      this.runTitleRegeneration(messages);
      return; // Only run one task at a time
    }

    // Priority 2: Check if idle messages needed
    if (this.needsIdleMessages()) {
      this.runIdleMessageGeneration(messages, context);
      return;
    }

    // Priority 3: Check if tool cleanup needed
    if (await this.needsToolCleanup(messages)) {
      this.runToolCleanup(messages);
      return;
    }

    logger.debug('[IDLE_COORD] No idle tasks needed at this time');
  }

  /**
   * Check if title work is needed (generation or regeneration)
   *
   * Title needs work if:
   * - Session has no title (initial generation)
   * - User sent a message more recently than last title generation (regeneration)
   * - Title generator exists and is not currently generating
   */
  private async needsTitleWork(): Promise<boolean> {
    if (!this.sessionTitleGenerator) {
      return false;
    }

    // Check if generator is already running
    if (this.sessionTitleGenerator.isActive) {
      logger.debug('[IDLE_COORD] Title generator already running');
      return false;
    }

    const currentSessionName = this.sessionManager.getCurrentSession();
    if (!currentSessionName) {
      return false;
    }

    // Load session to check if it has a title
    let hasNoTitle = false;
    try {
      const session = await this.sessionManager.loadSession(currentSessionName);
      hasNoTitle = !session?.metadata?.title && !session?.title;
    } catch (error) {
      logger.debug('[IDLE_COORD] Failed to load session for title check:', error);
      // On error, fall back to checking timestamp only
    }

    // Check if there's a new user message since last title generation (regeneration needed)
    const needsRegen = this.lastUserMessageTimestamp > this.lastTitleGenerationTimestamp;

    if (hasNoTitle) {
      logger.debug('[IDLE_COORD] Title generation needed - session has no title');
    } else if (needsRegen) {
      logger.debug('[IDLE_COORD] Title regeneration needed - user message more recent than last generation');
    }

    return hasNoTitle || needsRegen;
  }

  /**
   * Check if idle message generation is needed
   *
   * Idle messages needed if:
   * - Idle message generator exists and is not currently generating
   * - Queue is below refill threshold (handled by generator)
   */
  private needsIdleMessages(): boolean {
    if (!this.idleMessageGenerator) {
      return false;
    }

    // Check if generator is already running
    if (this.idleMessageGenerator.isActive) {
      logger.debug('[IDLE_COORD] Idle message generator already running');
      return false;
    }

    // Check queue size - if below threshold, generation is needed
    const queueSize = this.idleMessageGenerator.getQueueSize();
    const threshold = 5; // Match BUFFER_SIZES.IDLE_MESSAGE_REFILL_THRESHOLD
    const needsMessages = queueSize < threshold;

    if (needsMessages) {
      logger.debug(`[IDLE_COORD] Idle message generation needed - queue size ${queueSize} below threshold ${threshold}`);
    }

    return needsMessages;
  }

  /**
   * Run title regeneration
   *
   * @param messages - Current conversation messages
   */
  private runTitleRegeneration(messages: Message[]): void {
    if (!this.sessionTitleGenerator) {
      logger.warn('[IDLE_COORD] Title generator not initialized');
      return;
    }

    const currentSession = this.sessionManager.getCurrentSession();
    if (!currentSession) {
      logger.debug('[IDLE_COORD] No current session, skipping title regeneration');
      return;
    }

    // Find first user message for title generation
    const firstUserMessage = messages.find(msg => msg.role === 'user');
    if (!firstUserMessage) {
      logger.debug('[IDLE_COORD] No user messages found, skipping title regeneration');
      return;
    }

    // Check if session already has assistant response (required for title generation)
    const hasAssistantResponse = messages.some(msg => msg.role === 'assistant');
    if (!hasAssistantResponse) {
      logger.debug('[IDLE_COORD] No assistant response yet, skipping title regeneration');
      return;
    }

    logger.debug(`[IDLE_COORD] Starting title regeneration for session ${currentSession}`);

    // Trigger background title regeneration with callback to notify coordinator
    this.sessionTitleGenerator.regenerateTitleBackground(
      currentSession,
      messages,
      async () => {
        logger.debug(`[IDLE_COORD] Title generation callback fired for session ${currentSession}`);

        // Notify coordinator that title generation completed
        this.notifyTitleGenerated();

        // Update terminal title with new session title
        try {
          const session = await this.sessionManager.loadSession(currentSession);
          if (session?.metadata?.title) {
            logger.debug(`[IDLE_COORD] Loaded session title: "${session.metadata.title}", updating terminal title`);
            setTerminalTitle(session.metadata.title);
            logger.debug(`[IDLE_COORD] ✓ Terminal title updated successfully`);
          } else {
            logger.debug(`[IDLE_COORD] ⚠️  No title in session metadata (session: ${JSON.stringify(session?.metadata)})`);
          }
        } catch (error) {
          logger.error('[IDLE_COORD] ❌ Failed to update terminal title:', error);
        }
      }
    );

    // Update timestamp to prevent immediate re-triggering
    this.lastTitleGenerationTimestamp = Date.now();
  }

  /**
   * Run idle message generation
   *
   * @param messages - Current conversation messages
   * @param context - Additional context for generation
   */
  private runIdleMessageGeneration(messages: Message[], context?: IdleContext): void {
    if (!this.idleMessageGenerator) {
      logger.warn('[IDLE_COORD] Idle message generator not initialized');
      return;
    }

    logger.debug('[IDLE_COORD] Starting idle message generation');

    // Get recent messages for context (last 5 exchanges)
    const recentMessages = messages.slice(-10);

    // Trigger background idle message generation
    // Pass force=false to respect time interval
    this.idleMessageGenerator.generateMessageBackground(recentMessages, context, false);
  }

  /**
   * Check if tool cleanup is needed
   *
   * Tool cleanup needed if:
   * - AutoToolCleanupService exists and is not currently analyzing
   * - Service's shouldAnalyze method returns true (checks tool result count and time interval)
   */
  private async needsToolCleanup(messages: Message[]): Promise<boolean> {
    if (!this.autoToolCleanup) {
      return false;
    }

    // Check if service is already analyzing
    if (this.autoToolCleanup.isActive) {
      logger.debug('[IDLE_COORD]', 'Tool cleanup already running');
      return false;
    }

    // Get last analysis timestamp from session
    const currentSession = this.sessionManager.getCurrentSession();
    if (!currentSession) {
      return false;
    }

    // Load session to get lastCleanupAnalysisAt
    let lastAnalysisAt: number | undefined;
    try {
      const session = await this.sessionManager.loadSession(currentSession);
      lastAnalysisAt = session?.metadata?.lastCleanupAnalysisAt;
    } catch (error) {
      logger.debug('[IDLE_COORD]', 'Could not load session for cleanup check:', error);
      // If we can't load session, proceed without timestamp check
    }

    const shouldAnalyze = this.autoToolCleanup.shouldAnalyze(messages, lastAnalysisAt);
    if (shouldAnalyze) {
      const toolCount = messages.filter(msg => msg.role === 'tool').length;
      logger.debug('[IDLE_COORD]', `Tool cleanup needed - ${toolCount} tool results in conversation`);
    }
    return shouldAnalyze;
  }

  /**
   * Run tool cleanup analysis
   *
   * @param messages - Current conversation messages
   */
  private runToolCleanup(messages: Message[]): void {
    if (!this.autoToolCleanup) {
      logger.debug('[IDLE_COORD]', 'Tool cleanup service not initialized');
      return;
    }

    const sessionName = this.sessionManager.getCurrentSession();
    if (!sessionName) {
      logger.debug('[IDLE_COORD]', 'No current session, skipping tool cleanup');
      return;
    }

    logger.debug('[IDLE_COORD]', 'Starting tool cleanup analysis');
    this.autoToolCleanup.cleanupBackground(sessionName, messages);
  }

  /**
   * Cancel all ongoing idle tasks
   *
   * Called when main agent needs exclusive access to resources
   */
  cancel(): void {
    logger.debug('[IDLE_COORD] Cancelling all idle tasks');

    // Clear any pending retry timeout
    if (this.retryTimeoutId) {
      logger.debug('[IDLE_COORD] Clearing pending retry timeout');
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }

    if (this.sessionTitleGenerator && this.sessionTitleGenerator.isActive) {
      this.sessionTitleGenerator.cancel();
    }

    if (this.idleMessageGenerator && this.idleMessageGenerator.isActive) {
      this.idleMessageGenerator.cancel();
    }

    if (this.autoToolCleanup && this.autoToolCleanup.isActive) {
      this.autoToolCleanup.cancel();
    }
  }
}
