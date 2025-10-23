/**
 * IdleMessageGenerator - Auto-generates casual idle messages
 *
 * Uses LLM to generate short, cute, relevant messages to display when
 * the agent is idle. Operates in background to avoid blocking.
 */

import { ModelClient } from '../llm/ModelClient.js';
import { Message } from '../types/index.js';

/**
 * Additional context for idle message generation
 */
export interface IdleContext {
  /** Current working directory */
  cwd?: string;
  /** Active todo items */
  todos?: Array<{ task: string; status: string }>;
  /** Current time for time-aware messages */
  currentTime?: Date;
  /** Last user prompt */
  lastUserMessage?: string;
  /** Last assistant response */
  lastAssistantMessage?: string;
}

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
    this.minInterval = config.minInterval || 10000; // Default: 10 seconds between generations
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
   * @param context - Additional context (cwd, todos)
   * @returns Generated message
   */
  async generateMessage(recentMessages: Message[] = [], context?: IdleContext): Promise<string> {
    const messagePrompt = this.buildMessagePrompt(recentMessages, context);

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
   * @param context - Additional context (cwd, todos)
   */
  generateMessageBackground(recentMessages: Message[] = [], context?: IdleContext): void {
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
    this.generateAndStoreMessageAsync(recentMessages, context)
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
  private async generateAndStoreMessageAsync(recentMessages: Message[], context?: IdleContext): Promise<void> {
    const message = await this.generateMessage(recentMessages, context);
    this.currentMessage = message;
  }

  /**
   * Build the prompt for idle message generation
   */
  private buildMessagePrompt(_recentMessages: Message[], context?: IdleContext): string {
    // Add last exchange context (most important)
    let lastExchangeContext = '';
    if (context?.lastUserMessage && context?.lastAssistantMessage) {
      lastExchangeContext = `\n\nLast exchange:
User: ${context.lastUserMessage.slice(0, 150)}
Assistant: ${context.lastAssistantMessage.slice(0, 150)}`;
    }

    // Add working directory context
    const cwdContext = context?.cwd
      ? `\n\nCurrent working directory: ${context.cwd}`
      : '';

    // Add todo list context
    let todoContext = '';
    if (context?.todos && context.todos.length > 0) {
      const pendingTodos = context.todos.filter(t => t.status === 'pending' || t.status === 'in_progress');
      if (pendingTodos.length > 0) {
        todoContext = `\n\nActive tasks:\n${pendingTodos.map(t => `- ${t.task}`).join('\n')}`;
      }
    }

    // Add time context
    let timeContext = '';
    if (context?.currentTime) {
      const hour = context.currentTime.getHours();
      const timeOfDay = hour < 6 ? 'very early morning' :
                        hour < 12 ? 'morning' :
                        hour < 17 ? 'afternoon' :
                        hour < 21 ? 'evening' :
                        'late night';
      timeContext = `\n\nCurrent time: ${context.currentTime.toLocaleTimeString()} (${timeOfDay})`;
    }

    return `You are Ally, an AI coding assistant represented by a cute chick mascot. Generate a single, very short (max 6 words), casual, upbeat, and humorous idle message to display while waiting for the user's next input.

Be playful, witty, and use casual language or slang when appropriate. Keep it fun and lighthearted! You can occasionally reference being a helpful chick assistant (but don't overdo it).

You can subtly reference what was just discussed, active tasks, the project context, or make time-appropriate comments.

Examples:
- "Let's goooo!"
- "Vibing and ready!"
- "What's cookin'?"
- "Hit me with it!"
- "Ready to crush it!"
- "Let's ship this!"
- "You're up late!" (if late night)
- "Early bird gets the bug!" (if early morning)
- "That was fire!" (after success)
- "Nailed it!"
- "Feeling lucky today!"
- "Bring it on!"
- "Code time!"
${lastExchangeContext}${cwdContext}${todoContext}${timeContext}

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
