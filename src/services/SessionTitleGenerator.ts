/**
 * SessionTitleGenerator - Auto-generates descriptive session titles
 *
 * Uses LLM to generate concise, descriptive titles for conversation sessions
 * based on the first user message. Operates in background to avoid blocking.
 */

import { ModelClient } from '../llm/ModelClient.js';
import { Message, BackgroundTask } from '../types/index.js';
import { CancellableService } from '../types/CancellableService.js';
import { logger } from './Logger.js';
import { POLLING_INTERVALS, TEXT_LIMITS, API_TIMEOUTS } from '../config/constants.js';
import type { SessionManager } from './SessionManager.js';

/**
 * Configuration for SessionTitleGenerator
 */
export interface SessionTitleGeneratorConfig {
  /** Maximum tokens for title generation */
  maxTokens?: number;
  /** Temperature for title generation (lower = more deterministic) */
  temperature?: number;
}

/**
 * SessionTitleGenerator auto-generates session titles using LLM
 */
export class SessionTitleGenerator implements CancellableService, BackgroundTask {
  private modelClient: ModelClient;
  private sessionManager: SessionManager;
  private pendingGenerations = new Set<string>();
  private isGenerating: boolean = false;

  private enableGeneration: boolean;

  get isActive(): boolean {
    return this.isGenerating;
  }

  constructor(
    modelClient: ModelClient,
    sessionManager: SessionManager,
    enableGeneration: boolean = true,
    _config: SessionTitleGeneratorConfig = {}
  ) {
    this.modelClient = modelClient;
    this.sessionManager = sessionManager;
    this.enableGeneration = enableGeneration;
    // Note: maxTokens and temperature are available in _config but not used directly
    // They could be passed to modelClient.send() if needed in the future
  }

  /**
   * Create fallback title from last user message
   * Uses last user message truncated to SESSION_TITLE_MAX
   */
  private createFallbackTitle(messages: Message[]): string {
    // Find last user message (iterate backwards)
    const lastUserMessage = [...messages].reverse().find(msg => msg.role === 'user');

    if (!lastUserMessage) {
      return 'New Session';
    }

    // Normalize whitespace and truncate to SESSION_TITLE_MAX
    const content = lastUserMessage.content.trim();
    const cleanContent = content.replace(/\s+/g, ' ');

    return cleanContent.length > TEXT_LIMITS.SESSION_TITLE_MAX
      ? cleanContent.slice(0, TEXT_LIMITS.SESSION_TITLE_MAX) + '...'
      : cleanContent;
  }

  /**
   * Cancel any ongoing title generation
   *
   * Called before main agent starts processing to avoid resource competition.
   * The service will naturally retry later when a new session is created.
   */
  cancel(): void {
    if (this.isGenerating) {
      logger.debug('[TITLE_GEN] 🛑 Cancelling ongoing generation (user interaction started)');

      // Cancel all active requests on the model client
      if (typeof this.modelClient.cancel === 'function') {
        this.modelClient.cancel();
      }

      // Reset flag and clear pending
      this.isGenerating = false;
      this.pendingGenerations.clear();
    }
  }

  /**
   * Generate a title for a session based on messages
   *
   * @param messages - Conversation messages (typically first 1-2 messages)
   * @returns Generated title
   */
  async generateTitle(messages: Message[]): Promise<string> {
    // If generation is disabled, use fallback immediately
    if (!this.enableGeneration) {
      return this.createFallbackTitle(messages);
    }

    if (messages.length === 0) {
      return 'New Session';
    }

    // Find first user message
    const firstUserMessage = messages.find(msg => msg.role === 'user');
    if (!firstUserMessage) {
      return 'New Session';
    }

    const titlePrompt = this.buildTitlePrompt(firstUserMessage.content);

    try {
      const response = await this.modelClient.send(
        [{ role: 'user', content: titlePrompt }],
        {
          stream: false,
          suppressThinking: true, // Don't show thinking for background title generation
        }
      );

      // Check if response was interrupted or had an error - don't process it
      if ((response as any).interrupted || (response as any).error) {
        logger.debug('[TITLE_GEN] ⚠️  Response was interrupted/error, skipping title generation');
        throw new Error('Generation interrupted or failed');
      }

      const title = response.content.trim();

      // Clean up title - remove quotes, limit length
      let cleanTitle = title.replace(/^["']|["']$/g, '').trim();
      if (cleanTitle.length > TEXT_LIMITS.SESSION_TITLE_MAX) {
        cleanTitle = cleanTitle.slice(0, TEXT_LIMITS.SESSION_TITLE_MAX - 3) + '...';
      }

      return cleanTitle || 'New Session';
    } catch (error) {
      logger.debug('[TITLE_GEN] ❌ Failed to generate session title:', error);
      return this.createFallbackTitle(messages);
    }
  }

  /**
   * Generate a title in the background (non-blocking)
   *
   * Useful for real-time session creation without blocking the user
   *
   * @param sessionName - Name of the session
   * @param firstUserMessage - First user message content
   */
  generateTitleBackground(
    sessionName: string,
    firstUserMessage: string
  ): void {
    // Prevent duplicate generations
    if (this.pendingGenerations.has(sessionName)) {
      logger.debug(`[TITLE_GEN] ⏭️  Skipping - already generating title for ${sessionName}`);
      return;
    }

    logger.debug(`[TITLE_GEN] 🚀 Starting background title generation for session ${sessionName}`);
    this.pendingGenerations.add(sessionName);
    this.isGenerating = true;

    // Run in background
    this.generateAndSaveTitleAsync(sessionName, firstUserMessage)
      .catch(error => {
        // Ignore abort/interrupt errors (expected when cancelled)
        if (error.name === 'AbortError' || error.message?.includes('abort') || error.message?.includes('interrupt')) {
          logger.debug(`[TITLE_GEN] ⚠️  Generation cancelled for ${sessionName}`);
        } else {
          logger.error(`[TITLE_GEN] ❌ Generation failed for ${sessionName}:`, error);
        }
      })
      .finally(() => {
        this.pendingGenerations.delete(sessionName);
        this.isGenerating = false;
        logger.debug(`[TITLE_GEN] ✅ Generation completed for ${sessionName}`);
      });
  }

  /**
   * Regenerate title for an existing session based on recent conversation
   *
   * Unlike generateTitleBackground, this method:
   * - Uses the last 5-10 messages for context (not just first message)
   * - ALWAYS regenerates (ignores existing title)
   * - Calls onComplete callback when done
   * - Notifies coordinator of completion
   *
   * @param sessionName - Name of the session
   * @param messages - Full message array from the conversation
   * @param onComplete - Callback to execute when regeneration completes (coordinator notification)
   */
  regenerateTitleBackground(
    sessionName: string,
    messages: Message[],
    onComplete?: () => void
  ): void {
    // Prevent duplicate regenerations
    if (this.pendingGenerations.has(sessionName)) {
      logger.debug(`[TITLE_GEN] ⏭️  Skipping - already regenerating title for ${sessionName}`);
      return;
    }

    logger.debug(`[TITLE_GEN] 🔄 Starting background title regeneration for session ${sessionName}`);
    this.pendingGenerations.add(sessionName);
    this.isGenerating = true;

    // Run in background
    this.generateAndSaveTitleAsync(sessionName, messages, true)
      .catch(error => {
        // Ignore abort/interrupt errors (expected when cancelled)
        if (error.name === 'AbortError' || error.message?.includes('abort') || error.message?.includes('interrupt')) {
          logger.debug(`[TITLE_GEN] ⚠️  Regeneration cancelled for ${sessionName}`);
        } else {
          logger.error(`[TITLE_GEN] ❌ Regeneration failed for ${sessionName}:`, error);
        }
      })
      .finally(() => {
        this.pendingGenerations.delete(sessionName);
        this.isGenerating = false;
        logger.debug(`[TITLE_GEN] ✅ Regeneration completed for ${sessionName}`);
        if (onComplete) {
          onComplete();
        }
      });
  }

  /**
   * Generate and save title asynchronously
   */
  private async generateAndSaveTitleAsync(
    sessionName: string,
    messagesOrFirstMessage: Message[] | string,
    forceRegenerate: boolean = false
  ): Promise<void> {
    // Generate title based on whether this is initial generation or regeneration
    let title: string;
    if (forceRegenerate && Array.isArray(messagesOrFirstMessage)) {
      logger.debug(`[TITLE_GEN] 🔄 Regenerating title from ${messagesOrFirstMessage.length} messages`);
      title = await this.regenerateTitle(messagesOrFirstMessage);
    } else {
      const firstMessage = typeof messagesOrFirstMessage === 'string'
        ? messagesOrFirstMessage
        : messagesOrFirstMessage[0]?.content || '';
      title = await this.generateTitle([
        { role: 'user', content: firstMessage },
      ]);
    }
    logger.debug(`[TITLE_GEN] 📝 Generated title: "${title}"`);

    // Update session metadata using SessionManager's serialized write
    try {
      // Check if we should skip (only if not forcing regeneration)
      if (!forceRegenerate) {
        const session = await this.sessionManager.loadSession(sessionName);
        if (session?.metadata?.title) {
          logger.debug(`[TITLE_GEN] ⏭️  Session ${sessionName} already has title, skipping save`);
          return;
        }
      }

      // Use SessionManager's updateMetadata to ensure serialized writes
      const success = await this.sessionManager.updateMetadata(sessionName, {
        title,
        lastTitleGeneratedAt: Date.now(),
      });

      if (success) {
        logger.debug(`[TITLE_GEN] 💾 Saved title to session ${sessionName}`);
      } else {
        logger.error(`[TITLE_GEN] ❌ Failed to save title for ${sessionName}: updateMetadata returned false`);
      }
    } catch (error) {
      logger.error(`[TITLE_GEN] ❌ Failed to save title for ${sessionName}:`, error);
      throw error;
    }
  }

  /**
   * Regenerate title based on recent conversation context
   *
   * @param messages - Full conversation messages
   * @returns Regenerated title
   */
  private async regenerateTitle(messages: Message[]): Promise<string> {
    // If generation is disabled, use fallback immediately
    if (!this.enableGeneration) {
      return this.createFallbackTitle(messages);
    }

    if (messages.length === 0) {
      return 'New Session';
    }

    // Get last 5-10 user/assistant messages (filter out system/tool messages)
    const relevantMessages = messages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .slice(-10);

    if (relevantMessages.length === 0) {
      return 'New Session';
    }

    const titlePrompt = this.buildRegenerationPrompt(relevantMessages);

    try {
      const response = await this.modelClient.send(
        [{ role: 'user', content: titlePrompt }],
        {
          stream: false,
          suppressThinking: true, // Don't show thinking for background title generation
        }
      );

      // Check if response was interrupted or had an error - don't process it
      if ((response as any).interrupted || (response as any).error) {
        logger.debug('[TITLE_GEN] ⚠️  Response was interrupted/error, skipping title regeneration');
        throw new Error('Regeneration interrupted or failed');
      }

      const title = response.content.trim();

      // Clean up title - remove quotes, limit length
      let cleanTitle = title.replace(/^["']|["']$/g, '').trim();
      if (cleanTitle.length > TEXT_LIMITS.SESSION_TITLE_MAX) {
        cleanTitle = cleanTitle.slice(0, TEXT_LIMITS.SESSION_TITLE_MAX - 3) + '...';
      }

      return cleanTitle || 'New Session';
    } catch (error) {
      logger.debug('[TITLE_GEN] ❌ Failed to regenerate session title:', error);
      return this.createFallbackTitle(messages);
    }
  }

  /**
   * Build the prompt for title generation (initial)
   */
  private buildTitlePrompt(firstMessage: string): string {
    return `Generate a very concise, descriptive title (max 8 words) for a conversation that starts with:

"${firstMessage.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX)}"

Reply with ONLY the title, nothing else. No quotes, no punctuation at the end.`;
  }

  /**
   * Build the prompt for title regeneration based on conversation context
   */
  private buildRegenerationPrompt(messages: Message[]): string {
    // Build context summary from recent messages
    const context = messages
      .map(msg => {
        const preview = msg.content.slice(0, 150).replace(/\s+/g, ' ');
        return `${msg.role}: ${preview}`;
      })
      .join('\n');

    return `Generate a concise, descriptive title (max 8 words) for this conversation based on the recent discussion:

${context}

Reply with ONLY the title, nothing else. No quotes, no punctuation at the end.`;
  }

  /**
   * Cleanup any pending operations
   */
  async cleanup(): Promise<void> {
    // Wait for pending generations to complete
    const startTime = Date.now();

    while (this.pendingGenerations.size > 0 && Date.now() - startTime < API_TIMEOUTS.CLEANUP_MAX_WAIT) {
      await new Promise(resolve => setTimeout(resolve, POLLING_INTERVALS.CLEANUP));
    }
  }
}
