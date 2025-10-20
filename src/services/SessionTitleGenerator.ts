/**
 * SessionTitleGenerator - Auto-generates descriptive session titles
 *
 * Uses LLM to generate concise, descriptive titles for conversation sessions
 * based on the first user message. Operates in background to avoid blocking.
 */

import { ModelClient } from '../llm/ModelClient.js';
import { Message } from '../types/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';

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
export class SessionTitleGenerator {
  private modelClient: ModelClient;
  private pendingGenerations = new Set<string>();

  constructor(
    modelClient: ModelClient,
    _config: SessionTitleGeneratorConfig = {}
  ) {
    this.modelClient = modelClient;
    // Note: maxTokens and temperature are available in _config but not used directly
    // They could be passed to modelClient.send() if needed in the future
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
        }
      );

      const title = response.content.trim();

      // Clean up title - remove quotes, limit length
      let cleanTitle = title.replace(/^["']|["']$/g, '').trim();
      if (cleanTitle.length > 60) {
        cleanTitle = cleanTitle.slice(0, 57) + '...';
      }

      return cleanTitle || 'New Session';
    } catch (error) {
      console.error('Failed to generate session title:', error);
      // Fallback: use first 40 chars of first message
      const content = firstUserMessage.content.trim();
      const cleanContent = content.replace(/\s+/g, ' ');
      return cleanContent.length > 40
        ? cleanContent.slice(0, 40) + '...'
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
      return;
    }

    this.pendingGenerations.add(sessionName);

    // Run in background
    this.generateAndSaveTitleAsync(sessionName, firstUserMessage, sessionsDir)
      .catch(error => {
        console.error(`Background title generation failed for ${sessionName}:`, error);
      })
      .finally(() => {
        this.pendingGenerations.delete(sessionName);
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
      }
    } catch (error) {
      console.error(`Failed to save generated title for ${sessionName}:`, error);
    }
  }

  /**
   * Build the prompt for title generation
   */
  private buildTitlePrompt(firstMessage: string): string {
    return `Generate a very concise, descriptive title (max 8 words) for a conversation that starts with:

"${firstMessage.slice(0, 200)}"

Reply with ONLY the title, nothing else. No quotes, no punctuation at the end.`;
  }

  /**
   * Cleanup any pending operations
   */
  async cleanup(): Promise<void> {
    // Wait for pending generations to complete
    const maxWait = 5000; // 5 seconds
    const startTime = Date.now();

    while (this.pendingGenerations.size > 0 && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
