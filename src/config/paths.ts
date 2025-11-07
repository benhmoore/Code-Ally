/**
 * Path constants for Code Ally
 *
 * Defines all standard paths used by the application for configuration,
 * sessions, agents, patches, and caching.
 */

import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Base directory for all Code Ally data
 */
export const ALLY_HOME = join(homedir(), '.ally');

/**
 * Directory for custom agent definitions (user-created)
 */
export const AGENTS_DIR = join(ALLY_HOME, 'agents');

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

/**
 * Plugins directory for custom tools
 */
export const PLUGINS_DIR = join(ALLY_HOME, 'plugins');

/**
 * Plugin virtual environments directory
 * Stores isolated Python/Node environments for each plugin
 */
export const PLUGIN_ENVS_DIR = join(ALLY_HOME, 'plugin-envs');

/**
 * Base cache directory
 */
export const CACHE_DIR = join(ALLY_HOME, 'cache');

/**
 * Path completion cache directory
 */
export const COMPLETION_CACHE_DIR = join(CACHE_DIR, 'completion');

/**
 * Main configuration file path
 */
export const CONFIG_FILE = join(ALLY_HOME, 'config.json');

/**
 * Command history file path
 */
export const COMMAND_HISTORY_FILE = join(ALLY_HOME, 'command_history');

/**
 * All standard directories that should be created during initialization
 */
export const STANDARD_DIRECTORIES = [
  ALLY_HOME,
  AGENTS_DIR,
  PLUGINS_DIR,
  PLUGIN_ENVS_DIR,
  CACHE_DIR,
  COMPLETION_CACHE_DIR,
];

/**
 * Ensure all standard directories exist
 */
export async function ensureDirectories(): Promise<void> {
  const fs = await import('fs/promises');

  for (const dir of STANDARD_DIRECTORIES) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      // Ignore errors if directory already exists
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        console.error(`Failed to create directory ${dir}:`, error);
      }
    }
  }
}
