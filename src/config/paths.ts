/**
 * Path configuration for Code Ally
 *
 * Defines all standard paths used by the application for configuration,
 * sessions, agents, patches, and caching.
 *
 * Path resolution is profile-aware:
 * - Global paths (ALLY_HOME, COMMAND_HISTORY_FILE, etc.) are shared across profiles
 * - Profile-specific paths (agents, plugins, config, etc.) resolve to the active profile
 */

import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../services/Logger.js';

// ============================================================================
// Profile Context
// ============================================================================

/**
 * Active profile name - internal state
 * Default is 'default' profile
 */
let ACTIVE_PROFILE: string = 'default';

/**
 * Set the active profile for path resolution
 * Should be called during CLI initialization before any services are created
 *
 * @param profileName - Profile name to activate
 */
export function setActiveProfile(profileName: string): void {
  ACTIVE_PROFILE = profileName;
  logger.debug(`[PATHS] Active profile set to: ${profileName}`);
}

/**
 * Get the currently active profile name
 *
 * @returns Active profile name
 */
export function getActiveProfile(): string {
  return ACTIVE_PROFILE;
}

// ============================================================================
// Global Paths (NOT profile-specific)
// ============================================================================

/**
 * Base directory for all Code Ally data
 */
export const ALLY_HOME = join(homedir(), '.ally');

/**
 * Command history file path (shared across profiles)
 */
export const COMMAND_HISTORY_FILE = join(ALLY_HOME, 'command_history');

/**
 * Active profile tracking file
 */
export const ACTIVE_PROFILE_FILE = join(ALLY_HOME, 'active_profile');

/**
 * Base directory for all profiles
 */
export const PROFILES_DIR = join(ALLY_HOME, 'profiles');

/**
 * Built-in agent definitions shipped with the application
 * Located in dist/agents/ after build
 */
export const BUILTIN_AGENTS_DIR = (() => {
  const currentFileUrl = import.meta.url;
  const currentFilePath = fileURLToPath(currentFileUrl);
  const currentDir = dirname(currentFilePath);
  // Navigate from dist/config/paths.js to dist/agents/
  return join(currentDir, '..', 'agents');
})();

// ============================================================================
// Profile-Specific Paths (Functions)
// ============================================================================

/**
 * Get the agents directory for the active profile
 *
 * @returns Path to profile-specific agents directory
 */
export function getAgentsDir(): string {
  return join(PROFILES_DIR, ACTIVE_PROFILE, 'agents');
}

/**
 * Get the plugins directory for the active profile
 *
 * @returns Path to profile-specific plugins directory
 */
export function getPluginsDir(): string {
  return join(PROFILES_DIR, ACTIVE_PROFILE, 'plugins');
}

/**
 * Get the plugin environments directory for the active profile
 *
 * @returns Path to profile-specific plugin-envs directory
 */
export function getPluginEnvsDir(): string {
  return join(PROFILES_DIR, ACTIVE_PROFILE, 'plugin-envs');
}

/**
 * Get the cache directory for the active profile
 *
 * @returns Path to profile-specific cache directory
 */
export function getCacheDir(): string {
  return join(PROFILES_DIR, ACTIVE_PROFILE, 'cache');
}

/**
 * Get the completion cache directory for the active profile
 *
 * @returns Path to profile-specific completion cache directory
 */
export function getCompletionCacheDir(): string {
  return join(getCacheDir(), 'completion');
}

/**
 * Get the configuration file path for the active profile
 *
 * @returns Path to profile-specific config.json
 */
export function getConfigFile(): string {
  return join(PROFILES_DIR, ACTIVE_PROFILE, 'config.json');
}

/**
 * Get the prompts directory for the active profile
 *
 * @returns Path to profile-specific prompts directory
 */
export function getPromptsDir(): string {
  return join(PROFILES_DIR, ACTIVE_PROFILE, 'prompts');
}

/**
 * Get the base configuration file path (global defaults)
 *
 * @returns Path to base config.json
 */
export function getBaseConfigFile(): string {
  return join(ALLY_HOME, 'config.json');
}

// ============================================================================
// Directory Initialization
// ============================================================================

/**
 * Get all standard directories that should be created during initialization
 *
 * @returns Array of directory paths
 */
export function getStandardDirectories(): string[] {
  return [
    ALLY_HOME,
    PROFILES_DIR,
    // Profile-specific directories are created by ProfileManager
  ];
}

/**
 * Ensure all standard directories exist
 */
export async function ensureDirectories(): Promise<void> {
  const fs = await import('fs/promises');

  const directories = getStandardDirectories();

  for (const dir of directories) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      // Ignore errors if directory already exists
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        logger.error(`Failed to create directory ${dir}:`, error);
      }
    }
  }
}
