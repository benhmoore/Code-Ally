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
  /** Number of messages in the conversation */
  messageCount?: number;
  /** Session duration in seconds */
  sessionDuration?: number;
  /** Current git branch name */
  gitBranch?: string;
  /** User's home directory name */
  homeDirectory?: string;
  /** Total number of previous sessions */
  sessionCount?: number;
  /** Number of sessions created today */
  sessionsToday?: number;
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
  private messageQueue: string[] = [];
  private currentMessageIndex: number = 0;
  private isGenerating: boolean = false;
  private lastGenerationTime: number = 0;
  private minInterval: number;
  private readonly batchSize: number = 10;
  private readonly refillThreshold: number = 5;

  constructor(
    modelClient: ModelClient,
    config: IdleMessageGeneratorConfig = {}
  ) {
    this.modelClient = modelClient;
    this.minInterval = config.minInterval || 10000; // Default: 10 seconds between generations
    // Initialize with default message
    this.messageQueue.push('Idle');
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
    return [...this.messageQueue];
  }

  /**
   * Set the message queue (for restoration from session)
   */
  setQueue(messages: string[]): void {
    if (messages && messages.length > 0) {
      this.messageQueue = [...messages];
      this.currentMessageIndex = 0;
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
      const response = await this.modelClient.send(
        [{ role: 'user', content: messagePrompt }],
        {
          stream: false,
          temperature: 1.2, // Higher temperature for more creative/surprising messages
        }
      );

      const content = response.content.trim();

      // Parse the response - expecting numbered list or line-separated messages
      const messages = content
        .split('\n')
        .map(line => {
          // Remove numbering (1. 2. etc.) and quotes
          return line.replace(/^\d+\.\s*/, '').replace(/^["']|["']$/g, '').trim();
        })
        .filter(msg => msg.length > 0 && msg.length <= 60) // Filter valid messages
        .slice(0, this.batchSize); // Take up to batchSize messages

      // If we got valid messages, return them
      if (messages.length > 0) {
        return messages;
      }

      // Fallback: return default messages
      return ['Idle'];
    } catch (error) {
      console.error('Failed to generate idle message batch:', error);
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
      return;
    }

    // Check if enough time has passed since last generation (unless forced)
    const now = Date.now();
    if (!force && now - this.lastGenerationTime < this.minInterval) {
      return;
    }

    // Prevent concurrent generations
    if (this.isGenerating) {
      return;
    }

    this.isGenerating = true;
    this.lastGenerationTime = now;

    // Run in background
    this.generateAndRefillQueueAsync(recentMessages, context)
      .catch(error => {
        console.error('Background idle message generation failed:', error);
      })
      .finally(() => {
        this.isGenerating = false;
      });
  }

  /**
   * Generate batch of messages and refill queue asynchronously
   */
  private async generateAndRefillQueueAsync(recentMessages: Message[], context?: IdleContext): Promise<void> {
    const messages = await this.generateMessageBatch(recentMessages, context);

    // Replace the queue with new messages
    this.messageQueue = messages;
    this.currentMessageIndex = 0;
  }

  /**
   * Build the prompt for batch idle message generation
   */
  private buildBatchMessagePrompt(_recentMessages: Message[], context?: IdleContext): string {
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
    let dayOfWeek = '';
    if (context?.currentTime) {
      const hour = context.currentTime.getHours();
      const timeOfDay = hour < 6 ? 'very early morning' :
                        hour < 12 ? 'morning' :
                        hour < 17 ? 'afternoon' :
                        hour < 21 ? 'evening' :
                        'late night';

      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      dayOfWeek = days[context.currentTime.getDay()] || 'Unknown';

      timeContext = `\n\nCurrent time: ${context.currentTime.toLocaleTimeString()} (${timeOfDay}, ${dayOfWeek})`;
    }

    // Add message count context
    let messageCountContext = '';
    if (context?.messageCount !== undefined) {
      messageCountContext = `\n\nConversation length: ${context.messageCount} messages`;
      if (context.messageCount > 30) {
        messageCountContext += ' (long conversation - occasionally make explicit jokes about this, like "42 message marathon!" or "Haven\'t talked this much all day!")';
      }
    }

    // Add session duration context
    let sessionDurationContext = '';
    if (context?.sessionDuration !== undefined) {
      const minutes = Math.floor(context.sessionDuration / 60);
      const hours = Math.floor(minutes / 60);
      const displayMins = minutes % 60;

      if (hours > 0) {
        sessionDurationContext = `\n\nSession duration: ${hours}h ${displayMins}m`;
      } else if (minutes > 0) {
        sessionDurationContext = `\n\nSession duration: ${minutes} minutes`;
      }

      if (minutes > 60) {
        sessionDurationContext += ' (long session - can joke about this!)';
      }
    }

    // Add git branch context
    let gitBranchContext = '';
    if (context?.gitBranch) {
      gitBranchContext = `\n\nGit branch: ${context.gitBranch}`;
      if (context.gitBranch.includes('fix') || context.gitBranch.includes('hotfix')) {
        gitBranchContext += ' (fixing bugs - can joke about this!)';
      } else if (context.gitBranch.includes('feature') || context.gitBranch.includes('feat')) {
        gitBranchContext += ' (building features!)';
      }
    }

    // Add home directory context
    let homeDirContext = '';
    if (context?.homeDirectory) {
      homeDirContext = `\n\nUser's home directory name: ${context.homeDirectory} (you can occasionally make playful jokes about their username!)`;
    }

    // Add session count context
    let sessionCountContext = '';
    if (context?.sessionCount !== undefined) {
      sessionCountContext = `\n\nTotal previous sessions: ${context.sessionCount}`;
      if (context.sessionCount >= 5) {
        sessionCountContext += ' (lots of history! Can make humorous promises like "We won\'t make those mistakes again!" or reference their experience)';
      }
    }

    // Add sessions today context
    let sessionsTodayContext = '';
    if (context?.sessionsToday !== undefined && context.sessionsToday > 0) {
      sessionsTodayContext = `\n\nSessions created today: ${context.sessionsToday}`;
      if (context.sessionsToday >= 3) {
        sessionsTodayContext += ' (busy day! Can joke about how much they\'re chatting with you today)';
      }
    }

    return `You are Ally, a cheeky chick mascot with ADHD energy. Generate EXACTLY 10 surprising, unexpected idle messages (max 6 words each).

FORMAT: Return as a numbered list, one message per line:
1. First message
2. Second message
...
10. Tenth message

CRITICAL RULES:
- BE BOLD and SURPRISING - safe greetings are BORING
- USE the context provided - reference real details when possible
- NO generic "ready to code" or "let's go" phrases
- VARIETY is key - be creative and unpredictable
- Mix humor styles: fake facts, empty promises, playful observations, self-aware jokes

STRICT SAFETY RULES - NEVER BREAK THESE:
- NO messages that sound like errors or failures
- NO messages referencing user actions as if they failed or had issues
- NO technical status messages (avoid "Switched to X", "Built Y", "Installed Z", etc.)
- Keep jokes CLEARLY recognizable as jokes, not system messages
- When referencing technical context (git branch, etc.), be playful not status-like

Think: What would make someone laugh or smile unexpectedly WITHOUT confusing them?

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
- "We're on a roll!" (if long conversation)
- "Still going strong!" (if long conversation)
- "27 message marathon session!" (if long conversation - be explicit!)
- "Haven't talked this much all day!" (if long conversation)
- "My beak's getting tired!" (if very long conversation)
- "Is this a record?!" (if very long conversation)
- "Happy Monday!" (day of week)
- "TGIF vibes!" (if Friday)
- "Sunday Funday coding!" (if Sunday)
- "Hump day grind!" (if Wednesday)
- "2 hour session! Legend!" (if long session)
- "We've been at this 90 minutes!" (session duration)
- "I see you're on feature-branch!" (referencing branch name - playful, not status-like)
- "Feature branch vibes!" (if on feature branch)
- "Is your name really 'bhm128'?" (playful username joke)
- "Nice username, bhm128!" (home directory reference)
- "Nothing will go wrong today!" (humorous empty promise)
- "This time it'll work, promise!" (humorous promise)
- "No mistakes this time, right?" (if lots of sessions)
- "We're getting good at this!" (if lots of sessions)
- "Experts say code yourself!" (fake expert advice)
- "Studies show: more bugs = more fun!" (fake expert advice)
- "Research suggests coffee helps!" (fake expert wisdom)
- "Pros recommend: just ship it!" (fake expert advice)
- "You're really chatting me up today!" (if multiple sessions today)
- "Third session today? I'm flattered!" (if busy day)
- "We're best friends now, right?" (if lots of sessions today)
- "Someone's productive today!" (if multiple sessions)
${lastExchangeContext}${cwdContext}${todoContext}${timeContext}${messageCountContext}${sessionDurationContext}${gitBranchContext}${homeDirContext}${sessionCountContext}${sessionsTodayContext}

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
    const maxWait = 5000; // 5 seconds
    const startTime = Date.now();

    while (this.isGenerating && Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
