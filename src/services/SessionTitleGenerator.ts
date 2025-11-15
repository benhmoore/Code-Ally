/**
 * SessionTitleGenerator - Auto-generates descriptive session titles
 *
 * Uses LLM to generate concise, descriptive titles for conversation sessions
 * based on the first user message. Operates in background to avoid blocking.
 */

import { ModelClient } from '../llm/ModelClient.js';
import { Message } from '../types/index.js';
import { CancellableService } from '../types/CancellableService.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from './Logger.js';
import { POLLING_INTERVALS, TEXT_LIMITS, API_TIMEOUTS } from '../config/constants.js';

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
export class SessionTitleGenerator implements CancellableService {
  private modelClient: ModelClient;
  private pendingGenerations = new Set<string>();
  private isGenerating: boolean = false;

  constructor(
    modelClient: ModelClient,
    _config: SessionTitleGeneratorConfig = {}
  ) {
    this.modelClient = modelClient;
    // Note: maxTokens and temperature are available in _config but not used directly
    // They could be passed to modelClient.send() if needed in the future
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
      // Fallback: use first 40 chars of first message
      const content = firstUserMessage.content.trim();
      const cleanContent = content.replace(/\s+/g, ' ');
      return cleanContent.length > TEXT_LIMITS.COMMAND_DISPLAY_MAX
        ? cleanContent.slice(0, TEXT_LIMITS.COMMAND_DISPLAY_MAX) + '...'
        : cleanContent;
    }
  }

  /**
   * Generate a title in the background (non-blocking)
   *
   * Useful for real-time session creation without blocking the user
   *
   * @param sessionName - Name of the session
   * @param firstUserMessage - First user message content
   * @param sessionsDir - Directory where sessions are stored
   */
  generateTitleBackground(
    sessionName: string,
    firstUserMessage: string,
    sessionsDir: string
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
    this.generateAndSaveTitleAsync(sessionName, firstUserMessage, sessionsDir)
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
   * Generate and save title asynchronously
   */
  private async generateAndSaveTitleAsync(
    sessionName: string,
    firstUserMessage: string,
    sessionsDir: string
  ): Promise<void> {
    const sessionPath = join(sessionsDir, `${sessionName}.json`);

    // Generate title
    const title = await this.generateTitle([
      { role: 'user', content: firstUserMessage },
    ]);
    logger.debug(`[TITLE_GEN] 📝 Generated title: "${title}"`);

    // Load session and update title
    try {
      const content = await fs.readFile(sessionPath, 'utf-8');
      const session = JSON.parse(content);

      // Only update if no title exists yet
      if (!session.metadata?.title) {
        session.metadata = session.metadata || {};
        session.metadata.title = title;
        session.updated_at = new Date().toISOString();

        await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
        logger.debug(`[TITLE_GEN] 💾 Saved title to session ${sessionName}`);
      } else {
        logger.debug(`[TITLE_GEN] ⏭️  Session ${sessionName} already has title, skipping save`);
      }
    } catch (error) {
      logger.error(`[TITLE_GEN] ❌ Failed to save title for ${sessionName}:`, error);
      throw error;
    }
  }

  /**
   * Build the prompt for title generation
   */
  private buildTitlePrompt(firstMessage: string): string {
    return `Generate a very concise, descriptive title (max 8 words) for a conversation that starts with:

"${firstMessage.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX)}"

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
