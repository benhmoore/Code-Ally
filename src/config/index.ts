/**
 * Configuration module exports
 *
 * Centralized export point for all configuration-related components
 */

export { DEFAULT_CONFIG, CONFIG_TYPES, getConfigType, validateConfigValue } from './defaults.js';
export {
  ALLY_HOME,
  SESSIONS_DIR,
  AGENTS_DIR,
  PATCHES_DIR,
  CACHE_DIR,
  COMPLETION_CACHE_DIR,
  CONFIG_FILE,
  COMMAND_HISTORY_FILE,
  STANDARD_DIRECTORIES,
  ensureDirectories,
} from './paths.js';
