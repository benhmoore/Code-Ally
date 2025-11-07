/**
 * Plugin system constants
 *
 * Centralized configuration for plugin loading, execution, and management.
 */

/**
 * Plugin file and directory names
 */
export const PLUGIN_FILES = {
  /** Plugin manifest filename */
  MANIFEST: 'plugin.json',
  /** Configuration storage filename */
  CONFIG: 'config.json',
  /** Environment installation marker */
  STATE_MARKER: '.installed',
} as const;

/**
 * Plugin execution timeouts
 */
export const PLUGIN_TIMEOUTS = {
  /** Virtual environment creation timeout (60 seconds) */
  VENV_CREATION: 60000,
  /** Dependency installation timeout (5 minutes) */
  DEPENDENCY_INSTALL: 300000,
  /** Background process startup timeout (30 seconds) */
  BACKGROUND_PROCESS_STARTUP: 30000,
  /** Graceful shutdown delay between SIGTERM and SIGKILL (5 seconds) */
  BACKGROUND_PROCESS_SHUTDOWN_GRACE_PERIOD: 5000,
  /** Health check interval (30 seconds) */
  BACKGROUND_PROCESS_HEALTH_CHECK_INTERVAL: 30000,
  /** Health check timeout (5 seconds) */
  BACKGROUND_PROCESS_HEALTH_CHECK_TIMEOUT: 5000,
  /** Maximum failed health checks before marking unhealthy (3 failures) */
  BACKGROUND_PROCESS_MAX_HEALTH_CHECK_FAILURES: 3,
  /** Maximum restart attempts for crashed processes (3 attempts) */
  BACKGROUND_PROCESS_MAX_RESTART_ATTEMPTS: 3,
  /** Delay between restart attempts (5 seconds) */
  BACKGROUND_PROCESS_RESTART_DELAY: 5000,
  /** JSON-RPC request timeout (30 seconds) */
  RPC_REQUEST_TIMEOUT: 30000,
} as const;

/**
 * Plugin constraints
 */
export const PLUGIN_CONSTRAINTS = {
  /** Maximum Unix socket path length (104 chars on most systems) */
  MAX_SOCKET_PATH_LENGTH: 104,
  /** Maximum RPC response size in bytes (10 MB) */
  MAX_RPC_RESPONSE_SIZE: 10 * 1024 * 1024,
} as const;

/**
 * Encryption configuration for plugin secrets
 */
export const PLUGIN_ENCRYPTION = {
  /** Encryption algorithm */
  ALGORITHM: 'aes-256-gcm' as const,
  /** Encryption key length in bytes (256 bits) */
  KEY_LENGTH: 32,
  /** Initialization vector length in bytes (128 bits) */
  IV_LENGTH: 16,
  /** Prefix for encrypted values */
  PREFIX: '__ENCRYPTED__',
  /** Separator for encrypted value components */
  SEPARATOR: ':',
} as const;

/**
 * Configuration UI dimensions
 */
export const PLUGIN_UI = {
  /** Minimum height for config view */
  CONFIG_VIEW_MIN_HEIGHT: 15,
  /** Width for config view */
  CONFIG_VIEW_WIDTH: 80,
  /** Boolean input values */
  BOOLEAN_YES: ['y', 'Y'] as const,
  BOOLEAN_NO: ['n', 'N'] as const,
} as const;

/**
 * Plugin environment status values
 */
export enum PluginEnvironmentStatus {
  UNINSTALLED = 'uninstalled',
  INSTALLING = 'installing',
  READY = 'ready',
  ERROR = 'error',
}
