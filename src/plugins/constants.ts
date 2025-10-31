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
