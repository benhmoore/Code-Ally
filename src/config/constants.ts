/**
 * Application-wide constants for timeouts, delays, sizes, and limits
 *
 * This file contains constants for:
 * - Application behavior (timeouts, polling intervals, caching)
 * - UI/UX parameters (animations, debouncing, display limits)
 * - System operations (project detection, token management, formatting)
 *
 * For tool-specific defaults and limits, see toolDefaults.ts
 *
 * These values are for internal use and maintenance - they are not exposed
 * to users through the configuration system.
 */

// ===========================================
// NETWORK & API TIMEOUTS
// ===========================================

/**
 * Timeouts for network and API operations
 */
export const API_TIMEOUTS = {
  /** Version check timeout for all tools (2 seconds) */
  VERSION_CHECK: 2000,

  /** Ollama endpoint validation timeout (5 seconds) */
  OLLAMA_ENDPOINT_VALIDATION: 5000,

  /** Ollama model validation timeout (10 seconds) */
  OLLAMA_MODEL_VALIDATION: 10000,

  /** Base timeout for LLM requests (6 minutes) */
  LLM_REQUEST_BASE: 360000,

  /** Additional timeout per retry attempt (1 minute) */
  LLM_REQUEST_RETRY_INCREMENT: 60000,

  /** Maximum wait time for cleanup operations (5 seconds) */
  CLEANUP_MAX_WAIT: 5000,

  /** TypeScript project check timeout (30 seconds) */
  TSC_PROJECT_CHECK_TIMEOUT: 30000,

  /** TypeScript standalone file check timeout (10 seconds) */
  TSC_STANDALONE_CHECK_TIMEOUT: 10000,

  /** Node.js syntax check timeout (5 seconds) */
  NODE_SYNTAX_CHECK_TIMEOUT: 5000,

  /** Prettier format timeout (10 seconds) */
  PRETTIER_FORMAT_TIMEOUT: 10000,

  /** ESLint fix timeout (10 seconds) */
  ESLINT_FIX_TIMEOUT: 10000,

  /** Ollama model list fetch timeout (3 seconds) */
  OLLAMA_MODEL_LIST_TIMEOUT: 3000,

  /** Ollama model validation chat timeout (10 seconds) */
  OLLAMA_VALIDATION_CHAT_TIMEOUT: 10000,

  /** Process SIGTERM grace period before SIGKILL (2 seconds) */
  PROCESS_KILL_GRACE_PERIOD: 2000,
} as const;

// ===========================================
// POLLING & CLEANUP INTERVALS
// ===========================================

/**
 * Intervals for polling and cleanup operations
 */
export const POLLING_INTERVALS = {
  /** Cleanup polling interval for background tasks (100ms) */
  CLEANUP: 100,

  /** Todo display polling interval (500ms) */
  TODO_DISPLAY: 500,

  /** Fast status polling (1 second) */
  STATUS_FAST: 1000,

  /** Standard status/idle polling interval (64 seconds) */
  STATUS_POLLING: 64000,

  /** Idle message minimum interval (32 seconds) */
  IDLE_MESSAGE_MIN: 32000,

  /** Agent activity watchdog check interval (10 seconds) */
  AGENT_WATCHDOG: 10000,
} as const;

// ===========================================
// CACHE TIMEOUTS
// ===========================================

/**
 * Cache TTL and staleness thresholds
 */
export const CACHE_TIMEOUTS = {
  /** Completion provider cache TTL (5 seconds) */
  COMPLETION_CACHE_TTL: 5000,

  /** Project context staleness threshold (30 minutes) */
  PROJECT_CONTEXT_STALE: 30 * 60 * 1000,
} as const;

// ===========================================
// TIME UNIT CONVERSIONS
// ===========================================

/**
 * Time unit conversion constants
 */
export const TIME_UNITS = {
  /** Seconds per minute */
  SECONDS_PER_MINUTE: 60,

  /** Minutes per hour */
  MINUTES_PER_HOUR: 60,

  /** Hours per day */
  HOURS_PER_DAY: 24,

  /** Days per month (approximate) */
  DAYS_PER_MONTH: 30,

  /** Months per year */
  MONTHS_PER_YEAR: 12,

  /** Milliseconds per second */
  MS_PER_SECOND: 1000,
} as const;

// ===========================================
// BYTE CONVERSIONS
// ===========================================

/**
 * Byte conversion constants for file size formatting
 */
export const BYTE_CONVERSIONS = {
  /** Bytes per kilobyte */
  BYTES_PER_KB: 1024,

  /** Bytes per megabyte */
  BYTES_PER_MB: 1024 * 1024,

  /** Bytes per gigabyte */
  BYTES_PER_GB: 1024 * 1024 * 1024,
} as const;

// ===========================================
// PROJECT DETECTION
// ===========================================

/**
 * Project detection and scanning constants
 *
 * Different scan limits are used for different purposes:
 * - QUICK_SCAN: Fast existence checks (e.g., "are there any .py files?")
 * - LANGUAGE_DETECTION: Broader scan to identify primary languages
 * - SCALE_DETECTION: Comprehensive scan to determine project size
 */
export const PROJECT_DETECTION = {
  /** Quick scan limit for fast existence checks (50 files) */
  QUICK_SCAN_LIMIT: 50,

  /** Language detection scan limit (500 files) */
  LANGUAGE_DETECTION_LIMIT: 500,

  /** Scale detection scan limit for project size classification (1000 files) */
  SCALE_DETECTION_LIMIT: 1000,

  /** Small project threshold - fewer than this many files (50 files) */
  SMALL_PROJECT_THRESHOLD: 50,

  /** Medium project threshold - fewer than this many files (200 files) */
  MEDIUM_PROJECT_THRESHOLD: 200,

  /** Maximum directory scan depth for project detection */
  MAX_SCAN_DEPTH: 3,
} as const;

// ===========================================
// CODE FORMATTING
// ===========================================

/**
 * Code formatting standards and indentation
 */
export const FORMATTING = {
  /** JSON indentation spaces */
  JSON_INDENT_SPACES: 2,

  /** YAML indentation spaces */
  YAML_INDENT_SPACES: 2,

  /** YAML line width (0 = unlimited) */
  YAML_LINE_WIDTH: 0,

  /** Line number padding width in displays (6 digits for files up to 999,999 lines) */
  LINE_NUMBER_WIDTH: 6,

  /**
   * Decimal places for different display types
   * Note: These are kept separate for semantic clarity and future flexibility,
   * even though they currently share the same value
   */

  /** Duration display decimal places (1 = tenths of a second) */
  DURATION_DECIMAL_PLACES: 1,

  /** File size display decimal places (e.g., 2.5 MB) */
  FILE_SIZE_DECIMAL_PLACES: 1,

  /** Percentage display decimal places (e.g., 85.5%) */
  PERCENTAGE_DECIMAL_PLACES: 1,

  /** Table column minimum width */
  TABLE_COLUMN_MIN_WIDTH: 10,

  /** ls tool column width for size and permissions */
  LS_COLUMN_WIDTH: 10,

  /** Octal permission string width (3 digits like '755') */
  OCTAL_PERMISSION_WIDTH: 3,
} as const;

// ===========================================
// ID GENERATION
// ===========================================

/**
 * Random ID and identifier generation parameters
 */
export const ID_GENERATION = {
  /** Todo item UUID truncation length (8 chars) */
  TODO_ID_LENGTH: 8,

  /** Random string radix for base-36 encoding (0-9, a-z) */
  RANDOM_STRING_RADIX: 36,

  /** Random string substring start index (skip '0.' prefix from Math.random()) */
  RANDOM_STRING_SUBSTRING_START: 2,

  /** Random string length for agent/event IDs (7 characters) */
  RANDOM_STRING_LENGTH_SHORT: 7,

  /** Random string length for tool call IDs (9 characters) */
  RANDOM_STRING_LENGTH_LONG: 9,
} as const;

// ===========================================
// UI DEBOUNCE & THROTTLE DELAYS
// ===========================================

/**
 * Debounce and throttle delays for UI operations
 */
export const UI_DELAYS = {
  /** Command completion debounce (150ms) */
  COMPLETION_DEBOUNCE: 150,

  /** Ctrl+C double-tap reset timer (2 seconds) */
  CTRL_C_RESET: 2000,

  /** Escape key reset timer (500ms) */
  ESC_RESET: 500,

  /** Tool update throttle window (2 seconds) */
  TOOL_UPDATE_THROTTLE: 2000,

  /** Tool call batch flush delay - one frame at 60fps (16ms) */
  TOOL_CALL_BATCH_FLUSH: 16,

  /** Save operation debounce delay (100ms) */
  SAVE_DEBOUNCE: 100,
} as const;

// ===========================================
// ANIMATION TIMING
// ===========================================

/**
 * Animation frame rates and durations
 */
export const ANIMATION_TIMING = {
  /** Standard animation frame rate ~12fps (83ms) - matches Ink render FPS */
  FRAME_RATE: 83,

  /** Thinking indicator animation speed (500ms) */
  THINKING_SPEED: 500,

  /** Todo update animation interval (1 second) */
  TODO_UPDATE: 1000,

  /** Chick mascot default animation speed (13 seconds) */
  CHICK_ANIMATION_SPEED: 13000,

  /** Reasoning thought lifetime (5 seconds) */
  REASONING_THOUGHT_LIFETIME: 5000,

  /** Reasoning thought throttle delay (200ms) */
  REASONING_THROTTLE: 200,

  /** Reasoning stream cleanup interval (500ms) */
  REASONING_CLEANUP_INTERVAL: 500,
} as const;

// ===========================================
// BUFFER & QUEUE SIZES
// ===========================================

/**
 * Buffer sizes and queue limits
 */
export const BUFFER_SIZES = {
  /** Maximum number of tools allowed in a single batch call */
  MAX_BATCH_SIZE: 5,

  /** Idle message queue batch size */
  IDLE_MESSAGE_BATCH_SIZE: 10,

  /** Idle message queue refill threshold */
  IDLE_MESSAGE_REFILL_THRESHOLD: 5,

  /** Maximum todo items to display */
  MAX_TODO_DISPLAY_ITEMS: 3,

  /** Default list/preview size for displaying items (10 items) */
  DEFAULT_LIST_PREVIEW: 10,

  /** Top items preview size (3 items) */
  TOP_ITEMS_PREVIEW: 3,

  /** Maximum completion results (20 items) */
  MAX_COMPLETION_RESULTS: 20,

  /** Maximum errors to display (10 items) */
  MAX_ERROR_DISPLAY: 10,

  /** Binary content detection sample size (1KB) */
  BINARY_DETECTION_SAMPLE_SIZE: 1024,

  /** Minimum token budget for truncation fallback */
  MIN_CONTENT_TOKENS: 50,

  /** Number of recent agent messages to include in summary */
  AGENT_RECENT_MESSAGES: 3,

  /** Maximum warnings before required tool call failure */
  AGENT_REQUIRED_TOOL_MAX_WARNINGS: 2,

  /** Maximum continuation attempts after activity timeout before failing */
  AGENT_TIMEOUT_MAX_CONTINUATIONS: 3,

  /** Maximum file paths to display in todo items */
  TODO_FILE_PATHS_DISPLAY: 2,

  /**
   * Message count thresholds for history compaction (two-level validation)
   *
   * Level 1 - Attempt threshold: Check if we have enough total messages to justify compaction
   * Level 2 - Summarization threshold: Check if we have enough non-system messages to summarize
   *
   * Example: With 5 messages (1 system + 4 others), we pass attempt threshold (5 >= 5)
   * and summarization threshold (4 >= 2), so compaction proceeds.
   *
   * Example: With 3 messages (1 system + 2 others), we fail attempt threshold (3 < 5),
   * so compaction is skipped even though we'd have enough to summarize.
   */

  /** Minimum total messages required before attempting compaction (UI validation) */
  MIN_MESSAGES_TO_ATTEMPT_COMPACTION: 5,

  /** Minimum non-system messages required to generate a meaningful summary (internal check) */
  MIN_MESSAGES_TO_SUMMARIZE: 2,

  /** Statistics call count reset threshold */
  STATS_RESET_THRESHOLD: 100,

  /** Maximum estimated tool calls for display */
  MAX_ESTIMATED_TOOL_CALLS: 50,

  /** Command history maximum size */
  COMMAND_HISTORY_MAX: 1000,

  /** Maximum sessions to keep in SessionManager */
  MAX_SESSIONS_DEFAULT: 100,

  /** Maximum records in DuplicateDetector */
  DUPLICATE_DETECTOR_MAX_RECORDS: 200,

  /** Maximum patches per session before cleanup */
  MAX_PATCHES_PER_SESSION: 100,

  /** Maximum total size of patches in bytes (10 MB) */
  MAX_PATCHES_SIZE_BYTES: 10 * 1024 * 1024,

  /** Patch number padding width (3 digits for up to 999 patches) */
  PATCH_NUMBER_PADDING: 3,
} as const;

// ===========================================
// IDLE MESSAGE GENERATION
// ===========================================

/**
 * Parameters for idle message generation
 */
export const IDLE_MESSAGE_GENERATION = {
  /** Number of messages to generate per prompt */
  GENERATION_COUNT: 10,

  /** Maximum words per idle message */
  MAX_WORDS: 6,

  /** Probability (0-1) of injecting a command tip instead of LLM message */
  TIP_INJECTION_PROBABILITY: 0.2,
} as const;

/**
 * Useful command tips shown occasionally in idle messages
 * These are injected randomly to help users discover features
 */
export const COMMAND_TIPS = [
  'Resume a conversation with `ally --resume`',
  '`/plugin list` to see all your plugins',
  '`/config set field=value` to customize Ally',
  '`ally --list-sessions` shows conversations',
  '`/model` to switch AI models',
  'Press `Esc` to interrupt Ally anytime',
  '`/agent list` shows specialized agents',
  '`/config` to view all settings',
  '`ally --once "question"` for quick answers',
  '`/help` shows all available commands',
  '`+plugin-name` activates a tagged plugin',
  '`/todo add <task>` to create a task',
  '`ally --debug` for troubleshooting',
  '`/project init` creates ALLY.md config',
  '`/clear` clears conversation history',
  '`/focus <file>` to track a file',
] as const;

// ===========================================
// CONTEXT & TOKEN SIZES
// ===========================================

/**
 * Valid context size options (in tokens)
 */
export const CONTEXT_SIZES = {
  /** Small context window (16K tokens) */
  SMALL: 16384,

  /** Medium context window (32K tokens) */
  MEDIUM: 32768,

  /** Large context window (64K tokens) */
  LARGE: 65536,

  /** Extra large context window (128K tokens) */
  XLARGE: 131072,
} as const;

/**
 * Array of all valid context sizes for UI selection
 */
export const VALID_CONTEXT_SIZES = [
  CONTEXT_SIZES.SMALL,
  CONTEXT_SIZES.MEDIUM,
  CONTEXT_SIZES.LARGE,
  CONTEXT_SIZES.XLARGE,
] as const;

// ===========================================
// TEXT LENGTH LIMITS
// ===========================================

/**
 * Character and line limits for text processing
 */
export const TEXT_LIMITS = {
  /** Maximum session title length (60 chars) */
  SESSION_TITLE_MAX: 60,

  /** Maximum lines in reasoning display */
  REASONING_MAX_LINES: 2,

  /** Characters per line in reasoning display */
  REASONING_CHARS_PER_LINE: 80,

  /** Description truncation length (50 chars) */
  DESCRIPTION_MAX: 50,

  /** Command display length (40 chars) */
  COMMAND_DISPLAY_MAX: 40,

  /** Generic value display length (30 chars) */
  VALUE_DISPLAY_MAX: 30,

  /** Error message display length (60 chars) */
  ERROR_DISPLAY_MAX: 60,

  /** Message preview length (100 chars) */
  MESSAGE_PREVIEW_MAX: 100,

  /** Line display max length (120 chars) */
  LINE_DISPLAY_MAX: 120,

  /** Content preview length (200 chars) */
  CONTENT_PREVIEW_MAX: 200,

  /** Terminal width fallback (80 columns) */
  TERMINAL_WIDTH_FALLBACK: 80,

  /** Terminal width fallback for markdown (120 columns) */
  TERMINAL_WIDTH_MARKDOWN_FALLBACK: 120,

  /** Maximum content width for readability on wide screens (200 columns) */
  MAX_CONTENT_WIDTH: 200,

  /** Terminal height fallback (24 rows) */
  TERMINAL_HEIGHT_FALLBACK: 24,

  /** Static UI height in rows (4 rows) */
  STATIC_UI_HEIGHT: 4,

  /** Minimum height per tool (3 rows) */
  MIN_HEIGHT_PER_TOOL: 3,

  /** Minimum word boundary threshold ratio for smart truncation (60%) */
  WORD_BOUNDARY_THRESHOLD: 0.6,

  /** Line edit context window size (lines before/after) */
  LINE_EDIT_CONTEXT_LINES: 4,

  /** Line content display max length (80 chars) */
  LINE_CONTENT_DISPLAY_MAX: 80,

  /** Minimum viable agent response length */
  AGENT_RESPONSE_MIN: 20,

  /** Agent result preview length (100 chars) */
  AGENT_RESULT_PREVIEW_MAX: 100,

  /** Edit tool target preview length */
  EDIT_TARGET_PREVIEW_MAX: 100,

  /** Minimum target length for substring matching */
  EDIT_TARGET_MIN_LENGTH: 5,

  /** Ellipsis character length for truncation calculations */
  ELLIPSIS_LENGTH: 3,

  /** Session search match preview extra context (chars) */
  SESSION_MATCH_CONTEXT: 50,

  /** Session search snippet window size (chars before/after match) */
  SESSION_SNIPPET_CONTEXT: 100,

  /** Tool parameter value display max length (inline display) */
  TOOL_PARAM_VALUE_MAX: 40,

  /** Tool parameter array truncation display threshold */
  TOOL_PARAM_ARRAY_DISPLAY: 3,

  /** Maximum idle message length (60 chars) */
  IDLE_MESSAGE_MAX: 60,

  /** Model name display length (truncated for status line) */
  MODEL_NAME_DISPLAY_MAX: 5,

  /** ISO datetime string length (YYYY-MM-DD HH:MM:SS format) */
  ISO_DATETIME_LENGTH: 19,

  /** Minimum divider width in terminal display */
  DIVIDER_MIN_WIDTH: 60,

  /** Divider horizontal padding */
  DIVIDER_PADDING: 4,
} as const;

// ===========================================
// TOKEN MANAGEMENT
// ===========================================

/**
 * Token budget and estimation parameters
 */
export const TOKEN_MANAGEMENT = {
  /** Safety buffer as percentage of total context (10%) */
  SAFETY_BUFFER_PERCENT: 0.1,

  /** Maximum percentage of context for read operations (20%) */
  READ_CONTEXT_MAX_PERCENT: 0.2,

  /** Estimated characters per token for quick calculation */
  CHARS_PER_TOKEN_ESTIMATE: 4,

  /** Overhead characters for message role and structure */
  MESSAGE_OVERHEAD_CHARS: 20,

  /** Context near capacity warning threshold (80%) */
  NEAR_CAPACITY_THRESHOLD: 80,

  /** Ephemeral read maximum percentage of context (90%) */
  EPHEMERAL_READ_MAX_PERCENT: 0.9,

  /** User-initiated read maximum percentage of context (95%) */
  USER_INITIATED_READ_MAX_PERCENT: 0.95,

  /** Context file read maximum percentage of context (40%) */
  CONTEXT_FILE_READ_MAX_PERCENT: 0.4,
} as const;

// ===========================================
// AGENT & CYCLE DETECTION
// ===========================================

/**
 * Agent behavior and cycle detection configuration
 */
export const AGENT_CONFIG = {
  /** Maximum tool call history for cycle detection (sliding window) */
  MAX_TOOL_HISTORY: 15,

  /** Number of identical tool calls that trigger cycle detection */
  CYCLE_THRESHOLD: 3,

  /** Maximum retry attempts for message validation */
  MAX_VALIDATION_ATTEMPTS: 2,

  /** Number of consecutive different tool calls to clear cycle history */
  CYCLE_BREAK_THRESHOLD: 3,

  /** Number of accesses to the same file before warning about repeated reads */
  REPEATED_FILE_THRESHOLD: 5,

  /** Minimum search success rate (30%) before warning about low hit rate */
  HIT_RATE_THRESHOLD: 0.3,

  /** Number of consecutive empty search results before warning */
  EMPTY_STREAK_THRESHOLD: 3,

  /** Number of similar (fuzzy matched) tool calls before warning */
  SIMILAR_CALL_THRESHOLD: 3,

  /** Minimum number of searches required before checking hit rate */
  MIN_SEARCHES_FOR_HIT_RATE: 5,

  /** Default maximum retries for agent tool requirements before allowing exit */
  DEFAULT_REQUIREMENT_MAX_RETRIES: 2,

  /** Maximum agent nesting depth (0=root Ally, 1-3=delegated agents) */
  MAX_AGENT_DEPTH: 3,

  /** Maximum recursion depth for delegation context search (prevents stack overflow) */
  MAX_DELEGATION_RECURSION_DEPTH: 4,

  /** Agent pool size with nesting support (increased to handle nested agents) */
  AGENT_POOL_SIZE_WITH_NESTING: 15,
} as const;

// ===========================================
// AGENT POOL MANAGEMENT
// ===========================================

/**
 * Agent pool configuration for persistent specialized agents
 * Pool uses LRU (Least Recently Used) eviction policy when at capacity
 */
export const AGENT_POOL = {
  /** Default maximum pool size (5 agents, auto-evict least recently used when full) */
  DEFAULT_MAX_SIZE: 5,
} as const;

// ===========================================
// UI DISPLAY
// ===========================================

/**
 * Tool names that delegate to agents and should be displayed with agent-specific UI
 * Used by ToolCallDisplay and ConversationView to identify agent delegations
 */
export const AGENT_DELEGATION_TOOLS = ['agent', 'explore', 'plan'] as const;

// ===========================================
// THOROUGHNESS LEVELS
// ===========================================

/**
 * Max token limits for thoroughness levels
 * Controls output verbosity based on agent thoroughness parameter
 */
export const THOROUGHNESS_MAX_TOKENS = {
  /** Quick agents: concise responses (3000 tokens) */
  QUICK: 3000,
  /** Medium agents: normal responses (6000 tokens) */
  MEDIUM: 6000,
  // Very thorough and uncapped agents use global config default (10000 tokens)
} as const;

// ===========================================
// PERMISSION DENIAL MESSAGES
// ===========================================

/**
 * Permission denial error messages and tool result formats
 * Used when user denies permission for operations requiring confirmation
 */
export const PERMISSION_MESSAGES = {
  /** Generic permission denial message for tool results */
  GENERIC_DENIAL: 'Permission denied by user',

  /** User-facing permission denial message shown in chat */
  USER_FACING_DENIAL: 'Permission denied. Tell Ally what to do instead.',

  /** User-facing interruption message shown in chat */
  USER_FACING_INTERRUPTION: 'Interrupted. Tell Ally what to do instead.',

  /** Generate tool-specific denial message */
  toolSpecificDenial: (toolName: string) => `Permission denied for ${toolName} by user`,
} as const;

/**
 * Standard tool result object for permission denials
 * Ensures consistent error format across all denied operations
 */
export const PERMISSION_DENIED_TOOL_RESULT = {
  success: false,
  error: PERMISSION_MESSAGES.GENERIC_DENIAL,
  error_type: 'permission_denied' as const,
} as const;

// ===========================================
// REASONING EFFORT
// ===========================================

/**
 * Reasoning effort levels for models that support it (e.g., gpt-oss)
 *
 * These values map to the Ollama API's reasoning_effort parameter.
 * Higher effort levels may produce better results but take longer.
 */
export const REASONING_EFFORT = {
  /** Inherit reasoning effort from global config */
  INHERIT: 'inherit',
  /** Low reasoning effort - faster, less thorough */
  LOW: 'low',
  /** Medium reasoning effort - balanced */
  MEDIUM: 'medium',
  /** High reasoning effort - slower, more thorough */
  HIGH: 'high',
} as const;

/**
 * Type for reasoning effort values
 */
export type ReasoningEffort = typeof REASONING_EFFORT[keyof typeof REASONING_EFFORT];

/**
 * Valid reasoning effort values for API (excludes INHERIT)
 */
export const REASONING_EFFORT_API_VALUES = [
  REASONING_EFFORT.LOW,
  REASONING_EFFORT.MEDIUM,
  REASONING_EFFORT.HIGH,
] as const;

/**
 * All valid reasoning effort values including INHERIT (for agent configuration)
 */
export const REASONING_EFFORT_ALL_VALUES = [
  REASONING_EFFORT.INHERIT,
  REASONING_EFFORT.LOW,
  REASONING_EFFORT.MEDIUM,
  REASONING_EFFORT.HIGH,
] as const;
