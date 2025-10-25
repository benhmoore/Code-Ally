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
  /** Fallback default timeout if config is not available (5 seconds) - BashTool uses config.bash_timeout as primary default */
  DEFAULT: 5000,

  /** Maximum timeout for bash commands (60 seconds) */
  MAX: 60000,

  /** Graceful shutdown delay between SIGTERM and SIGKILL (1 second) */
  GRACEFUL_SHUTDOWN_DELAY: 1000,
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
