/**
 * IdleMessageGenerator - Auto-generates casual idle messages
 *
 * Uses LLM to generate short, cute, relevant messages to display when
 * the agent is idle. Operates in background to avoid blocking.
 */

import { ModelClient } from '../llm/ModelClient.js';
import { Message } from '../types/index.js';

/**
 * Configuration for IdleMessageGenerator
 */
export interface IdleMessageGeneratorConfig {
  /** Maximum tokens for message generation */
  maxTokens?: number;
  /** Temperature for message generation (higher = more creative) */
  temperature?: number;
  /** Minimum time between generation requests (ms) */
  minInterval?: number;
}

/**
 * IdleMessageGenerator auto-generates idle messages using LLM
 */
export class IdleMessageGenerator {
  private modelClient: ModelClient;
  private currentMessage: string = 'Idle';
  private isGenerating: boolean = false;
  private lastGenerationTime: number = 0;
  private minInterval: number;

  constructor(
    modelClient: ModelClient,
    config: IdleMessageGeneratorConfig = {}
  ) {
    this.modelClient = modelClient;
    this.minInterval = config.minInterval || 30000; // Default: 30 seconds between generations
  }

  /**
   * Get the current idle message
   */
  getCurrentMessage(): string {
    return this.currentMessage;
  }

  /**
   * Generate a new idle message based on recent conversation context
   *
   * @param recentMessages - Recent conversation messages for context
   * @returns Generated message
   */
  async generateMessage(recentMessages: Message[] = []): Promise<string> {
    const messagePrompt = this.buildMessagePrompt(recentMessages);

    try {
      const response = await this.modelClient.send(
        [{ role: 'user', content: messagePrompt }],
        {
          stream: false,
        }
      );

      const message = response.content.trim();

      // Clean up message - remove quotes, ensure reasonable length
      let cleanMessage = message.replace(/^["']|["']$/g, '').trim();
      if (cleanMessage.length > 60) {
        cleanMessage = cleanMessage.slice(0, 57) + '...';
      }

      return cleanMessage || 'Idle';
    } catch (error) {
      console.error('Failed to generate idle message:', error);
      return 'Idle';
    }
  }

  /**
   * Generate an idle message in the background (non-blocking)
   *
   * Useful for periodically updating the idle message without blocking the UI
   *
   * @param recentMessages - Recent conversation messages for context
   */
  generateMessageBackground(recentMessages: Message[] = []): void {
    // Check if enough time has passed since last generation
    const now = Date.now();
    if (now - this.lastGenerationTime < this.minInterval) {
      return;
    }

    // Prevent concurrent generations
    if (this.isGenerating) {
      return;
    }

    this.isGenerating = true;
    this.lastGenerationTime = now;

    // Run in background
    this.generateAndStoreMessageAsync(recentMessages)
      .catch(error => {
        console.error('Background idle message generation failed:', error);
      })
      .finally(() => {
        this.isGenerating = false;
      });
  }

  /**
   * Generate and store message asynchronously
   */
  private async generateAndStoreMessageAsync(recentMessages: Message[]): Promise<void> {
    const message = await this.generateMessage(recentMessages);
    this.currentMessage = message;
  }

  /**
   * Build the prompt for idle message generation
   */
  private buildMessagePrompt(recentMessages: Message[]): string {
    const contextSummary = recentMessages.length > 0
      ? `\n\nRecent conversation context:\n${recentMessages.slice(-3).map(m => `${m.role}: ${(m.content || '').slice(0, 100)}`).join('\n')}`
      : '';

    return `You are Ally, an AI coding assistant represented by a cute chick mascot. Generate a single, very short (max 6 words), casual, and slightly playful idle message to display while waiting for the user's next input.

The message should be friendly and can occasionally reference being a helpful chick assistant (but don't overdo it).

Examples:
- "Ready when you are!"
- "What's next?"
- "Pecking away at problems..."
- "Your turn!"
- "Waiting patiently..."
- "Chirp if you need help!"
- "Let's code together!"
${contextSummary}

Reply with ONLY the message, nothing else. No quotes, no punctuation unless natural.`;
  }

  /**
   * Reset to default idle message
   */
  reset(): void {
    this.currentMessage = 'Idle';
  }

  /**
   * Cleanup any pending operations
   */
  async cleanup(): Promise<void> {
    // Wait for pending generation to complete
    const maxWait = 5000; // 5 seconds
    const startTime = Date.now();

    while (this.isGenerating && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
