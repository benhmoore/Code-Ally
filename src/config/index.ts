/**
 * Configuration module exports
 *
 * Centralized export point for all configuration-related components
 */

export { DEFAULT_CONFIG, CONFIG_TYPES, getConfigType, validateConfigValue } from './defaults.js';
export {
  ALLY_HOME,
  AGENTS_DIR,
  CACHE_DIR,
  COMPLETION_CACHE_DIR,
  CONFIG_FILE,
  COMMAND_HISTORY_FILE,
  STANDARD_DIRECTORIES,
  ensureDirectories,
} from './paths.js';
