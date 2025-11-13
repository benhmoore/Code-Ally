/**
 * IdleMessageGenerator - Auto-generates casual idle messages
 *
 * Uses LLM to generate short, cute, relevant messages to display when
 * the agent is idle. Operates in background to avoid blocking.
 */

import { ModelClient } from '../llm/ModelClient.js';
import { Message } from '../types/index.js';
import { CancellableService } from '../types/CancellableService.js';
import { logger } from './Logger.js';
import {
  POLLING_INTERVALS,
  BUFFER_SIZES,
  API_TIMEOUTS,
  TEXT_LIMITS,
  IDLE_MESSAGE_GENERATION,
} from '../config/constants.js';

/**
 * Additional context for idle message generation
 */
export interface IdleContext {
  /** Current working directory */
  cwd?: string;
  /** Active todo items */
  todos?: Array<{ task: string; status: string }>;
  /** Current git branch name */
  gitBranch?: string;
  /** User's home directory name */
  homeDirectory?: string;
  /** Project context (languages, frameworks, etc.) */
  projectContext?: {
    languages: string[];
    frameworks: string[];
    projectName?: string;
    projectType?: string;
    hasGit: boolean;
    packageManager?: string;
    scale: 'small' | 'medium' | 'large';
    hasDocker?: boolean;
    cicd?: string[];
  };
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
export class IdleMessageGenerator implements CancellableService {
  private modelClient: ModelClient;
  private messageQueue: string[] = [];
  private currentMessageIndex: number = 0;
  private isGenerating: boolean = false;
  private lastGenerationTime: number = 0;
  private minInterval: number;
  private readonly batchSize: number = BUFFER_SIZES.IDLE_MESSAGE_BATCH_SIZE;
  private readonly refillThreshold: number = BUFFER_SIZES.IDLE_MESSAGE_REFILL_THRESHOLD;
  private onQueueUpdated?: () => void;

  constructor(
    modelClient: ModelClient,
    config: IdleMessageGeneratorConfig = {}
  ) {
    this.modelClient = modelClient;
    this.minInterval = config.minInterval || POLLING_INTERVALS.IDLE_MESSAGE_MIN;
    // Initialize with default message
    this.messageQueue.push('Idle');
  }

  /**
   * Set callback to be called when queue is updated with new messages
   */
  setOnQueueUpdated(callback: () => void): void {
    this.onQueueUpdated = callback;
  }

  /**
   * Cancel any ongoing idle message generation
   *
   * Called before main agent starts processing to avoid resource competition.
   * The service will naturally retry later when idle conditions are met.
   */
  cancel(): void {
    if (this.isGenerating) {
      logger.debug('[IDLE_MSG] 🛑 Cancelling ongoing generation (user interaction started)');

      // Cancel all active requests on the model client
      // This is safe because we call this BEFORE the agent starts its request
      if (typeof this.modelClient.cancel === 'function') {
        this.modelClient.cancel();
      }

      // Reset flag - the background promise will handle cleanup in finally block
      this.isGenerating = false;
    }
  }

  /**
   * Get the current idle message
   */
  getCurrentMessage(): string {
    // If queue is empty, return fallback
    if (this.messageQueue.length === 0) {
      return 'Idle';
    }

    // Return current message (cycling through the queue)
    const message = this.messageQueue[this.currentMessageIndex % this.messageQueue.length];
    return message || 'Idle';
  }

  /**
   * Move to the next message in the queue
   */
  nextMessage(): void {
    if (this.messageQueue.length > 0) {
      this.currentMessageIndex = (this.currentMessageIndex + 1) % this.messageQueue.length;
    }
  }

  /**
   * Get number of messages remaining in queue
   */
  getQueueSize(): number {
    return this.messageQueue.length;
  }

  /**
   * Get the entire message queue (for persistence)
   */
  getQueue(): string[] {
    logger.debug(`[IDLE_MSG] getQueue called, returning ${this.messageQueue.length} messages: ${JSON.stringify(this.messageQueue.slice(0, 3))}...`);
    return [...this.messageQueue];
  }

  /**
   * Set the message queue (for restoration from session)
   */
  setQueue(messages: string[]): void {
    if (messages && messages.length > 0) {
      logger.debug(`[IDLE_MSG] setQueue called with ${messages.length} messages: ${JSON.stringify(messages.slice(0, 3))}...`);
      this.messageQueue = [...messages];
      this.currentMessageIndex = 0;
    } else {
      logger.debug(`[IDLE_MSG] setQueue called with empty/invalid messages: ${JSON.stringify(messages)}`);
    }
  }

  /**
   * Generate a batch of idle messages based on recent conversation context
   *
   * @param recentMessages - Recent conversation messages for context
   * @param context - Additional context (cwd, todos)
   * @returns Array of generated messages
   */
  async generateMessageBatch(recentMessages: Message[] = [], context?: IdleContext): Promise<string[]> {
    const messagePrompt = this.buildBatchMessagePrompt(recentMessages, context);

    try {
      logger.debug('[IDLE_MSG] Sending request to model...');
      const response = await this.modelClient.send(
        [{ role: 'user', content: messagePrompt }],
        {
          stream: false,
          temperature: 1.2, // Higher temperature for more creative/surprising messages
        }
      );

      // Check if response was interrupted or had an error - don't process it
      if ((response as any).interrupted || (response as any).error) {
        logger.debug('[IDLE_MSG] ⚠️  Response was interrupted/error, keeping existing queue');
        throw new Error('Generation interrupted or failed');
      }

      logger.debug(`[IDLE_MSG] Got response from model, length: ${response.content.length}`);
      const content = response.content.trim();

      // Parse the response - expecting numbered list or line-separated messages
      const messages = content
        .split('\n')
        .map(line => {
          // Remove numbering (1. 2. etc.) and quotes
          return line.replace(/^\d+\.\s*/, '').replace(/^["']|["']$/g, '').trim();
        })
        .filter(msg => msg.length > 0 && msg.length <= TEXT_LIMITS.IDLE_MESSAGE_MAX) // Filter valid messages
        .slice(0, this.batchSize); // Take up to batchSize messages

      // If we got valid messages, return them
      if (messages.length > 0) {
        return messages;
      }

      // Fallback: return default messages
      logger.warn('[IDLE_MSG] No valid messages parsed, returning fallback');
      return ['Idle'];
    } catch (error) {
      // Don't log interrupted/cancelled errors - they're expected
      if (error instanceof Error && error.message.includes('interrupt')) {
        throw error; // Re-throw to be handled by caller
      }
      logger.error('[IDLE_MSG] Failed to generate idle message batch:', error);
      return ['Idle'];
    }
  }

  /**
   * Generate idle messages in the background (non-blocking)
   *
   * Generates a batch of messages and refills the queue.
   * Only triggers if queue has less than 5 messages remaining.
   *
   * @param recentMessages - Recent conversation messages for context
   * @param context - Additional context (cwd, todos)
   * @param force - Force generation even if time interval hasn't passed (for initial startup)
   */
  generateMessageBackground(recentMessages: Message[] = [], context?: IdleContext, force: boolean = false): void {
    // Only generate if queue is running low (less than 5 messages)
    if (this.messageQueue.length >= this.refillThreshold) {
      logger.debug(`[IDLE_MSG] ⏭️  Skipping generation - queue has ${this.messageQueue.length} messages (threshold: ${this.refillThreshold})`);
      return;
    }

    // Check if enough time has passed since last generation (unless forced)
    const now = Date.now();
    if (!force && now - this.lastGenerationTime < this.minInterval) {
      const timeLeft = Math.round((this.minInterval - (now - this.lastGenerationTime)) / 1000);
      logger.debug(`[IDLE_MSG] ⏭️  Skipping generation - ${timeLeft}s until next allowed generation`);
      return;
    }

    // Prevent concurrent generations
    if (this.isGenerating) {
      logger.debug('[IDLE_MSG] ⏭️  Skipping generation - already generating');
      return;
    }

    logger.debug('[IDLE_MSG] 🚀 Starting background idle message generation');
    this.isGenerating = true;
    this.lastGenerationTime = now;

    // Run in background
    this.generateAndRefillQueueAsync(recentMessages, context)
      .catch(error => {
        // Ignore abort/interrupt errors (expected when cancelled)
        if (error.name === 'AbortError' || error.message?.includes('abort') || error.message?.includes('interrupt')) {
          logger.debug('[IDLE_MSG] ⚠️  Generation cancelled (aborted by user interaction)');
        } else {
          logger.error('[IDLE_MSG] ❌ Generation failed:', error);
        }
      })
      .finally(() => {
        this.isGenerating = false;
        logger.debug('[IDLE_MSG] ✅ Generation completed, isGenerating reset to false');
      });
  }

  /**
   * Generate batch of messages and refill queue asynchronously
   */
  private async generateAndRefillQueueAsync(recentMessages: Message[], context?: IdleContext): Promise<void> {
    const messages = await this.generateMessageBatch(recentMessages, context);
    logger.debug(`[IDLE_MSG] 💬 Generated ${messages.length} new messages - first: "${messages[0]}"`);

    // Replace the queue with new messages
    this.messageQueue = messages;
    this.currentMessageIndex = 0;

    // Notify that queue has been updated (e.g., to trigger session save)
    if (this.onQueueUpdated) {
      try {
        this.onQueueUpdated();
      } catch (error) {
        logger.warn('[IDLE_MSG] ⚠️  onQueueUpdated callback failed:', error);
      }
    }
  }

  /**
   * Build the prompt for batch idle message generation
   */
  private buildBatchMessagePrompt(_recentMessages: Message[], context?: IdleContext): string {
    // Add working directory context
    const cwdContext = context?.cwd
      ? `\n\nWorking directory: ${context.cwd}`
      : '';

    // Add git branch context
    let gitBranchContext = '';
    if (context?.gitBranch) {
      gitBranchContext = `\n\nGit branch: ${context.gitBranch}`;
      if (context.gitBranch.includes('fix') || context.gitBranch.includes('hotfix')) {
        gitBranchContext += ' (fixing bugs!)';
      } else if (context.gitBranch.includes('feature') || context.gitBranch.includes('feat')) {
        gitBranchContext += ' (building features!)';
      }
    }

    // Add home directory context
    let homeDirContext = '';
    if (context?.homeDirectory) {
      homeDirContext = `\n\nUsername: ${context.homeDirectory}`;
    }

    // Add project context (stable, safe to persist)
    let projectContext = '';
    if (context?.projectContext) {
      const pc = context.projectContext;
      projectContext = '\n\nProject:';

      if (pc.projectName) {
        projectContext += `\n- Name: ${pc.projectName}`;
      }

      if (pc.projectType) {
        projectContext += `\n- Type: ${pc.projectType}`;
      }

      if (pc.languages.length > 0) {
        projectContext += `\n- Languages: ${pc.languages.join(', ')}`;
      }

      if (pc.frameworks.length > 0) {
        projectContext += `\n- Frameworks: ${pc.frameworks.join(', ')}`;
      }

      if (pc.packageManager) {
        projectContext += `\n- Package manager: ${pc.packageManager}`;
      }

      if (pc.hasDocker) {
        projectContext += `\n- Docker: Yes (containerized!)`;
      }

      if (pc.cicd && pc.cicd.length > 0) {
        projectContext += `\n- CI/CD: ${pc.cicd.join(', ')}`;
      }

      projectContext += `\n\n(Feel free to make playful references to the tech stack, Docker, and CI/CD!)`;
    }

    return `You are Ally, a cheeky chick mascot with ADHD energy. Generate EXACTLY ${IDLE_MESSAGE_GENERATION.GENERATION_COUNT} surprising, unexpected idle messages (max ${IDLE_MESSAGE_GENERATION.MAX_WORDS} words each).

FORMAT: Return as a numbered list, one message per line:
1. First message
2. Second message
...
10. Tenth message

MARKDOWN SUPPORT:
- You can use **bold**, *italic*, \`inline code\`, and other markdown formatting
- Use markdown to add emphasis and make messages more expressive
- Examples: "**Ready** to code!", "*Feeling* productive", "\`git push\` energy"

CRITICAL RULES:
- BE BOLD and SURPRISING - safe greetings are BORING
- USE the context provided - reference real details when possible
- OCCASIONALLY use syntax from the primary language (e.g., "let code = 'time';" for JavaScript, "impl Ready {}" for Rust)
- Use markdown formatting to add emphasis and expressiveness
- NO generic "ready to code" or "let's go" phrases
- VARIETY is key - be creative and unpredictable
- Mix humor styles: fake facts, empty promises, playful observations, self-aware jokes, language syntax

STRICT SAFETY RULES - NEVER BREAK THESE:
- NO messages that sound like errors or failures
- NO messages referencing user actions as if they failed or had issues
- NO technical status messages (avoid "Switched to X", "Built Y", "Installed Z", etc.)
- Keep jokes CLEARLY recognizable as jokes, not system messages
- When referencing technical context (git branch, etc.), be playful not status-like

Think: What would make someone laugh or smile unexpectedly WITHOUT confusing them?

Examples (be creative, don't copy these):
- "Let's **goooo**!"
- "What's *cookin'*?"
- "Nothing will go wrong today!" (humorous empty promise)
- "Experts say **code yourself**!" (fake expert advice with bold)
- "Feature branch *vibes*!" (if on feature branch)
- "\`const ready = true;\`" (JavaScript syntax in code formatting)
- "\`impl Ready {}\`" (Rust syntax, if Rust project)
${cwdContext}${gitBranchContext}${homeDirContext}${projectContext}

Reply with ONLY the numbered list, nothing else. No quotes around messages, no punctuation unless natural.`;
  }

  /**
   * Reset to default idle message
   */
  reset(): void {
    this.messageQueue = ['Idle'];
    this.currentMessageIndex = 0;
  }

  /**
   * Cleanup any pending operations
   */
  async cleanup(): Promise<void> {
    // Wait for pending generation to complete
    const startTime = Date.now();

    while (this.isGenerating && Date.now() - startTime < API_TIMEOUTS.CLEANUP_MAX_WAIT) {
      await new Promise(resolve => setTimeout(resolve, POLLING_INTERVALS.CLEANUP));
    }
  }
}
