/**
 * Configuration module exports
 *
 * Centralized export point for all configuration-related components
 */

export { DEFAULT_CONFIG, CONFIG_TYPES, getConfigType, validateConfigValue } from './defaults.js';
export {
  // Global paths (constants)
  ALLY_HOME,
  COMMAND_HISTORY_FILE,
  PROFILES_DIR,
  BUILTIN_AGENTS_DIR,

  // Profile-aware path functions
  getAgentsDir,
  getPluginsDir,
  getPluginEnvsDir,
  getCacheDir,
  getCompletionCacheDir,
  getConfigFile,
  getPromptsDir,
  getBaseConfigFile,

  // Profile context management
  setActiveProfile,
  getActiveProfile,

  // Directory utilities
  getStandardDirectories,
  ensureDirectories,
} from './paths.js';
