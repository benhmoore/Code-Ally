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
          temperature: 1.2, // Higher temperature for more creative/surprising messages
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

    return `You are Ally, a cheeky chick mascot with ADHD energy. Generate ONE surprising, unexpected idle message (max 6 words).

CRITICAL RULES:
- BE BOLD and SURPRISING - safe greetings are BORING
- USE the context provided - reference real details when possible
- NO generic "ready to code" or "let's go" phrases
- VARIETY is key - be creative and unpredictable
- Mix humor styles: fake facts, empty promises, playful observations, self-aware jokes

Think: What would make someone laugh or smile unexpectedly?

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
- "Working on 'fix-the-fix' branch?" (referencing branch name)
- "Feature branch energy!" (if on feature branch)
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
