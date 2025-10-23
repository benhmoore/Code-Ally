/**
 * Shared constants and defaults for tool implementations
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
  /** Default timeout for bash commands (5 seconds) */
  DEFAULT: 5000,

  /** Maximum timeout for bash commands (60 seconds) */
  MAX: 60000,

  /** Graceful shutdown delay between SIGTERM and SIGKILL (1 second) */
  GRACEFUL_SHUTDOWN_DELAY: 1000,
} as const;

/**
 * Debounce and timing constants
 */
export const TIMING_CONSTANTS = {
  /** Debounce delay for command history saves (100ms) */
  SAVE_DEBOUNCE_MS: 100,

  /** Minimum interval between idle messages (10 seconds) */
  IDLE_MESSAGE_MIN_INTERVAL_MS: 10000,

  /** Idle message variation interval (5 seconds) */
  IDLE_MESSAGE_VARIATION_MS: 5000,

  /** API request timeout (5 seconds) */
  API_TIMEOUT_MS: 5000,

  /** Animation frame duration ~12fps to match Ink (83ms) */
  ANIMATION_FRAME_MS: 83,
} as const;

/**
 * Context usage thresholds for progressive truncation
 *
 * Thresholds based on empirical testing:
 * - 70%: Enough headroom for normal tool execution
 * - 85%: Start conserving tokens for critical operations
 * - 95%: Emergency mode - minimal results only
 */
export const CONTEXT_THRESHOLDS = {
  NORMAL: 70,
  WARNING: 85,
  CRITICAL: 95,

  WARNINGS: {
    70: 'Context filling: Prioritize essential operations',
    85: 'Approaching limit: Complete current task then wrap up',
    95: 'CRITICAL: Stop tool use after current operation and summarize immediately',
  },
} as const;
