/**
 * Application-wide constants for timeouts, delays, sizes, and limits
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
  /** Ollama endpoint validation timeout (5 seconds) */
  OLLAMA_ENDPOINT_VALIDATION: 5000,

  /** Ollama model validation timeout (10 seconds) */
  OLLAMA_MODEL_VALIDATION: 10000,

  /** Base timeout for LLM requests (4 minutes) */
  LLM_REQUEST_BASE: 240000,

  /** Additional timeout per retry attempt (1 minute) */
  LLM_REQUEST_RETRY_INCREMENT: 60000,

  /** Permission request timeout (30 seconds) */
  PERMISSION_REQUEST: 30000,
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

  /** Normal status polling (1 minute) */
  STATUS_NORMAL: 60000,

  /** Continuous status polling (1 minute) */
  STATUS_CONTINUOUS: 60000,

  /** Idle message minimum interval (10 seconds) */
  IDLE_MESSAGE_MIN: 10000,

  /** Agent activity watchdog check interval (10 seconds) */
  AGENT_WATCHDOG: 10000,
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

  /** Chick mascot default animation speed (4 seconds) */
  CHICK_ANIMATION_SPEED: 4000,

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
  /** Idle message queue batch size */
  IDLE_MESSAGE_BATCH_SIZE: 10,

  /** Idle message queue refill threshold */
  IDLE_MESSAGE_REFILL_THRESHOLD: 5,

  /** Maximum todo items to display */
  MAX_TODO_DISPLAY_ITEMS: 3,
} as const;

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

  /** Session title truncation point (57 chars) */
  SESSION_TITLE_TRUNCATE: 57,

  /** Maximum lines in reasoning display */
  REASONING_MAX_LINES: 2,

  /** Characters per line in reasoning display */
  REASONING_CHARS_PER_LINE: 80,
} as const;

// ===========================================
// ANIMATION PROBABILITIES
// ===========================================

/**
 * Probability weights for animations
 */
export const ANIMATION_PROBABILITIES = {
  /** Chick animation state probability weight (low) */
  CHICK_STATE_LOW: 0.6,

  /** Chick animation state probability weight (high) */
  CHICK_STATE_HIGH: 0.8,
} as const;
