/**
 * Centralized System Reminder Catalog
 *
 * This file contains ALL system reminder messages used throughout the application.
 * System reminders are instructions injected into the conversation to guide agent behavior.
 *
 * Reminder Types:
 * - Ephemeral (persist: false): Cleaned up after each turn, used for temporary coaching
 * - Persistent (persist: true): Kept forever in conversation history, used for permanent context
 *
 * By default, ALL reminders are ephemeral unless explicitly marked as persistent.
 */

/**
 * System reminder configuration
 */
export interface SystemReminderConfig {
  /** The reminder message content (can be string or template function) */
  text: string | ((...args: any[]) => string);
  /** Whether this reminder persists in conversation history (default: false) */
  persist: boolean;
}

/**
 * Centralized catalog of all system reminder messages
 *
 * Organized by category for maintainability:
 * - CONTINUATIONS: HTTP errors, empty responses
 * - VALIDATION: Tool call validation errors
 * - REQUIREMENTS: Required tool calls and requirements system
 * - INTERRUPTIONS: User interruptions and activity timeouts
 * - PROGRESS: Checkpoint reminders
 * - GUIDANCE: Exploratory tool warnings, time reminders, focus reminders
 * - CYCLE_DETECTION: Repeated tool calls and patterns
 * - CONTEXT: Context usage warnings
 * - TOOL_SPECIFIC: Reminders injected by specific tools
 */
export const SYSTEM_REMINDERS = {
  // ===========================================
  // CONTINUATIONS (Ephemeral)
  // ===========================================
  CONTINUATIONS: {
    /** HTTP error continuation - prod agent to continue after connection error */
    HTTP_ERROR: {
      text: (errorMessage: string) =>
        `Your previous response encountered an error and was interrupted: ${errorMessage}. Please continue where you left off.`,
      persist: false,
    },

    /** Truly empty response (no content, no tools) - request continuation */
    EMPTY_RESPONSE: {
      text: 'Your response appears incomplete. Please continue where you left off.',
      persist: false,
    },

    /** Empty response after tool execution - request response based on tool results */
    EMPTY_AFTER_TOOLS: {
      text: 'You just executed tool calls but did not provide any response. Please provide your response now based on the tool results.',
      persist: false,
    },
  },

  // ===========================================
  // VALIDATION (Ephemeral)
  // ===========================================
  VALIDATION: {
    /** Tool call validation errors - request properly formatted retry */
    TOOL_CALL_ERRORS: {
      text: (errors: string[]) => {
        const errorDetails = errors.join('\n- ');
        return `Your previous response contained tool call validation errors:\n- ${errorDetails}\n\nPlease try again with properly formatted tool calls.`;
      },
      persist: false,
    },
  },

  // ===========================================
  // REQUIREMENTS (Ephemeral)
  // ===========================================
  REQUIREMENTS: {
    /** Required tools not called - warn agent to call them */
    REQUIRED_TOOLS_WARNING: {
      text: (missingTools: string[]) =>
        `You must call the following required tool(s) before completing your task: ${missingTools.join(', ')}\nPlease call ${missingTools.length === 1 ? 'this tool' : 'these tools'} now.`,
      persist: false,
    },

    /** Requirements not met - remind agent of requirements */
    REQUIREMENTS_NOT_MET: {
      text: (reminderMessage: string) => reminderMessage,
      persist: false,
    },
  },

  // ===========================================
  // INTERRUPTIONS (Ephemeral)
  // ===========================================
  INTERRUPTIONS: {
    /** User interrupted - prioritize new prompt over todo list */
    USER_INTERRUPTED: {
      text: 'User interrupted. Prioritize answering their new prompt over continuing your todo list. After responding, reassess if the todo list is still relevant. Do not blindly continue with pending todos.',
      persist: false,
    },

    /** Activity timeout - agent stuck generating tokens without tool calls */
    ACTIVITY_TIMEOUT: {
      text: (elapsedSeconds: number, attempt: number, maxAttempts: number) =>
        `Activity timeout: no tool calls for ${elapsedSeconds} seconds (attempt ${attempt}/${maxAttempts}). Make a tool call or complete your response now.`,
      persist: false,
    },

    /** Activity timeout continuation - prompt agent to continue after timeout */
    ACTIVITY_TIMEOUT_CONTINUATION: {
      text: 'You exceeded the activity timeout without making tool calls. Please continue your work and make progress by calling tools or providing a response.',
      persist: false,
    },
  },

  // ===========================================
  // PROGRESS (Ephemeral)
  // ===========================================
  PROGRESS: {
    /** Checkpoint reminder - verify alignment with original request */
    CHECKPOINT: {
      text: (toolCallCount: number, originalPrompt: string) =>
        `Progress checkpoint (${toolCallCount} tool calls):

Original request: "${originalPrompt}"

Verify alignment:
- Are you still working toward this goal?
- Have you drifted into unrelated improvements?
- Course-correct now if off-track, or continue if aligned.`,
      persist: false,
    },
  },

  // ===========================================
  // GUIDANCE - EXPLORATORY TOOLS (Ephemeral)
  // ===========================================
  EXPLORATORY: {
    /** Gentle warning - suggest explore() for efficiency */
    GENTLE_WARNING: {
      text: (consecutiveCount: number) =>
        `You've made ${consecutiveCount} consecutive exploratory tool calls (read/grep/glob/ls/tree). For complex multi-file investigations, consider using explore() instead - it delegates to a specialized agent with its own context budget, protecting your token budget and enabling more thorough investigation.

Recommended workflow:
1. First, use cleanup-call to remove recent exploratory tool results from context
2. Then call explore() with a detailed task_prompt that summarizes:
   - What you're looking for
   - What you've learned so far (files found, patterns discovered)
   - Any specific areas to investigate

When to use explore():
- Unknown scope/location - don't know where code is
- Multi-file synthesis - understanding patterns across files
- Complex architectural analysis
- Any investigation requiring 5+ file operations

Only use direct read/grep/glob when you know specific paths or need a quick lookup.`,
      persist: false,
    },

    /** Stern warning - agent wasting significant context */
    STERN_WARNING: {
      text: (consecutiveCount: number) =>
        `⚠️ CRITICAL: You've made ${consecutiveCount} consecutive exploratory tool calls. You are wasting valuable context budget on manual exploration.

STOP exploring manually. You MUST use explore() now.

Required actions:
1. IMMEDIATELY use cleanup-call to remove all recent exploratory results
2. Use explore() with a detailed task_prompt that includes:
   - What you're looking for
   - What you've learned so far (files found, patterns discovered)
   - Where else to look

Example:
explore(
  task_prompt="Find all color and theming constants in the codebase. Already found src/ui/constants/colors.ts which has PROFILE_COLOR_PALETTE and UI_COLORS. Need to search config/, services/, and plugins/ directories for additional theme-related constants."
)

Continuing to use read/grep/glob/ls/tree is inefficient and wastes your limited context budget. The explore agent has its own context budget and is designed for exactly this type of investigation.`,
      persist: false,
    },
  },

  // ===========================================
  // GUIDANCE - TIME REMINDERS (Ephemeral)
  // ===========================================
  TIME: {
    /** 50% time used - gentle reminder */
    HALFWAY: {
      text: (remaining: string) =>
        `You're halfway through your allotted time (${remaining} remaining). Keep your exploration focused and efficient.`,
      persist: false,
    },

    /** 75% time used - warning to wrap up */
    WARNING_75: {
      text: (remaining: string, percentRemaining: number) =>
        `⏰ You have ${remaining} left (${percentRemaining}% remaining). Start wrapping up your exploration.`,
      persist: false,
    },

    /** 90% time used - urgent finish current work */
    URGENT_90: {
      text: (remaining: string, percentRemaining: number) =>
        `⏰ URGENT: You have ${remaining} left (${percentRemaining}% remaining). Finish your current work and prepare to wrap up.`,
      persist: false,
    },

    /** 100%+ time used - critical wrap up immediately */
    EXCEEDED_100: {
      text: '⏰ TIME EXCEEDED! You have surpassed your allotted time. Wrap up your work immediately and summarize what is left, if any.',
      persist: false,
    },
  },

  // ===========================================
  // GUIDANCE - FOCUS REMINDER (Ephemeral)
  // ===========================================
  FOCUS: {
    /** Focus reminder based on in_progress todo */
    TODO_FOCUS: {
      text: (todoTask: string, toolCallSummary: string) =>
        `Stay focused. You're working on: ${todoTask}.${toolCallSummary}

Stay on task. Use todo-update to mark todos as complete when finished.`,
      persist: false,
    },
  },

  // ===========================================
  // CYCLE DETECTION (Ephemeral)
  // ===========================================
  CYCLE_DETECTION: {
    /** Generic cycle warning - same tool with same args repeatedly */
    CYCLE_WARNING: {
      text: (toolName: string, count: number) =>
        `You've called "${toolName}" with identical arguments ${count} times recently, getting the same results. This suggests you're stuck in a loop. Consider trying a different approach or re-reading previous results.`,
      persist: false,
    },

    /** Empty search streak - multiple searches returning nothing */
    EMPTY_SEARCH_STREAK: {
      text: (streakCount: number) =>
        `You've had ${streakCount} consecutive searches return no results. Consider broadening your search patterns, checking different directories, or trying alternative search strategies.`,
      persist: false,
    },

    /** Low hit rate - many searches, few successes */
    LOW_HIT_RATE: {
      text: (hitRate: number, searchCount: number) =>
        `Your search success rate is low (${Math.round(hitRate * 100)}% across ${searchCount} searches). Consider: 1) Using more specific patterns, 2) Searching in the right directories, 3) Using glob to first find relevant files.`,
      persist: false,
    },
  },

  // ===========================================
  // CONTEXT USAGE (Persistent)
  // ===========================================
  CONTEXT: {
    /** Context usage warning for specialized agents */
    USAGE_WARNING: {
      text: (contextUsage: number) =>
        `Context usage at ${contextUsage}% - too high for specialized agent to execute more tools. You MUST provide your final summary now. Do NOT request any more tool calls. Summarize your work, findings, and recommendations based on the information you have gathered.`,
      persist: true, // Persistent - explains why specialized agent stopped (constraint on result)
    },
  },

  // ===========================================
  // TOOL-SPECIFIC REMINDERS
  // ===========================================
  TOOLS: {
    /** Agent persistence reminder - encourage agent-ask for follow-ups */
    AGENT_PERSISTENCE: {
      text: (agentId: string) =>
        `Agent persists as ${agentId}. For related follow-ups, USE agent-ask(agent_id="${agentId}", message="...") - dramatically more efficient than starting fresh. Start new agents only for unrelated problems.`,
      persist: false, // Ephemeral - temporary coaching about tool efficiency
    },

    /** Agent task context - explains specialized agent's purpose (PERSISTENT) */
    AGENT_TASK_CONTEXT: {
      text: (agentType: string, taskPrompt: string, maxDuration: string | null, thoroughness: string) => {
        let context = `This agent is a specialized ${agentType} agent created for:\n\n"${taskPrompt}"`;
        if (maxDuration) {
          context += `\n\nTime budget: ${maxDuration}`;
        }
        context += `\nThoroughness: ${thoroughness}`;
        context += '\n\nStay focused on this task. Provide findings and recommendations.';
        return context;
      },
      persist: true, // Persistent - explains agent purpose and constraints
    },

    /** Plan acceptance notification */
    PLAN_ACCEPTED: {
      text: "The plan has been automatically accepted and todos activated. If this plan doesn't align with user intent, use deny-proposal to reject it and explain why.",
      persist: false, // Ephemeral - one-time notification about plan activation
    },

    /** Write-temp file hint */
    WRITE_TEMP_HINT: {
      text: (filePath: string) =>
        `You can read this file back with read(file_path="${filePath}") to review your notes.`,
      persist: false, // Ephemeral - temporary hint about file location
    },
  },

  // ===========================================
  // TODO LIST REMINDERS (Ephemeral)
  // ===========================================
  TODO: {
    /** Empty todo list - suggest creating todos for multi-step tasks */
    EMPTY_LIST: {
      text: 'Todo list empty. For multi-step tasks, use todo-add to track progress.',
      persist: false,
    },

    /** Active todo list with current state */
    ACTIVE_LIST: {
      text: (todoSummary: string, currentTask: string | null, guidance: string) => {
        let content = `Current todos:\n${todoSummary}`;
        if (currentTask) {
          content += `\n\nCurrently working on: "${currentTask}". Stay focused unless blocked.`;
        }
        content += `\n\n${guidance}`;
        return content;
      },
      persist: false,
    },
  },
} as const;

/**
 * Type helper to extract text function parameters
 */
export type ReminderTextFunction = (...args: any[]) => string;

/**
 * Type guard to check if reminder text is a function
 */
export function isReminderFunction(
  text: string | ReminderTextFunction
): text is ReminderTextFunction {
  return typeof text === 'function';
}
