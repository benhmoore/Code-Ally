/**
 * Tool-specific constants and defaults
 *
 * This file contains constants for:
 * - Tool operation limits (max results, max file sizes, max depths)
 * - Tool behavior defaults (exclusion patterns, timeouts)
 * - Tool output estimation (for context budgeting)
 * - Context usage thresholds (for progressive truncation)
 *
 * For application-wide constants (timeouts, UI, animations, etc.), see constants.ts
 */

/**
 * Limits for tool result sizes and operations
 */
export const TOOL_LIMITS = {
  /** Maximum number of search results to return */
  MAX_SEARCH_RESULTS: 100,

  /** Maximum number of directory entries to list */
  MAX_DIRECTORY_ENTRIES: 1000,

  /** Maximum file size to process (1MB) */
  MAX_FILE_SIZE: 1024 * 1024,

  /** Maximum context lines to show around matches */
  MAX_CONTEXT_LINES: 10,

  /** Maximum output size for plugin execution (10MB) */
  MAX_PLUGIN_OUTPUT_SIZE: 10 * 1024 * 1024,
} as const;

/**
 * Default file and directory exclusion patterns
 */
export const FILE_EXCLUSIONS = {
  DEFAULT: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
  ],
} as const;

/**
 * Timeout limits for command execution
 */
export const TIMEOUT_LIMITS = {
  /** Fallback default timeout if config is not available (5 seconds) - BashTool uses config.bash_timeout as primary default */
  DEFAULT: 5000,

  /** Maximum timeout for bash commands (20 minutes) */
  MAX: 1200000,

  /** Graceful shutdown delay between SIGTERM and SIGKILL (500ms) */
  GRACEFUL_SHUTDOWN_DELAY: 500,

  /** Idle timeout for detecting interactive commands waiting for input (25 seconds) */
  IDLE_DETECTION_TIMEOUT: 25000,

  /** Interval for checking idle status (1 second) */
  IDLE_CHECK_INTERVAL: 1000,
} as const;

/**
 * Token count estimates for tool outputs
 *
 * These are used for context budgeting when results haven't been generated yet.
 */
export const TOOL_OUTPUT_ESTIMATES = {
  /** Default tool output estimate (400 tokens) */
  DEFAULT: 400,

  /** Read tool output estimate (800 tokens) */
  READ: 800,

  /** Grep tool output estimate (600 tokens) */
  GREP: 600,

  /** Bash tool output estimate (400 tokens) */
  BASH: 400,

  /** Glob tool output estimate (300 tokens) */
  GLOB: 300,

  /** Ls tool output estimate (300 tokens) */
  LS: 300,
} as const;

/**
 * Context usage thresholds for progressive truncation
 *
 * Thresholds based on empirical testing:
 * - 70%: Enough headroom for normal tool execution
 * - 75%: Add moderate reminder to system prompt
 * - 85%: Start conserving tokens for critical operations
 * - 90%: Add strong warning to system prompt
 * - 95%: Emergency mode - minimal results only
 */
export const CONTEXT_THRESHOLDS = {
  VISIBILITY: 50,
  NORMAL: 70,
  MODERATE_REMINDER: 75,
  WARNING: 85,
  STRONG_REMINDER: 90,
  CRITICAL: 95,
  /** Emergency truncation threshold - skip summarization, just truncate */
  EMERGENCY: 98,
  MAX_PERCENT: 100,

  WARNINGS: {
    70: 'Context filling: Prioritize essential operations',
    85: 'Approaching limit: Complete current task then wrap up',
    95: 'CRITICAL: Stop tool use after current operation and summarize immediately',
  },

  // System prompt reminders (injected at 75% and 90%)
  SYSTEM_REMINDERS: {
    75: 'Context budget is filling up. Be more selective with tool use - prioritize essential operations and avoid exploratory tasks.',
    90: 'WARNING: Context budget nearly exhausted. Minimize tool use. Focus on completing your current task efficiently, then wrap up your response.',
  },
} as const;

/**
 * Tool name constants
 */
export const TOOL_NAMES = {
  /** Todo management tools */
  TODO_MANAGEMENT_TOOLS: ['todo-write'],
  /** Exploration-only tools (internal to explore agents) */
  EXPLORATION_ONLY_TOOLS: ['write-temp'],
} as const;
