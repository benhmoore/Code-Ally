/**
 * Path constants for Code Ally
 *
 * Defines all standard paths used by the application for configuration,
 * sessions, agents, patches, and caching.
 */

import { homedir } from 'os';
import { join } from 'path';

/**
 * Base directory for all Code Ally data
 */
export const ALLY_HOME = join(homedir(), '.code-ally');

/**
 * Directory for conversation session storage
 */
export const SESSIONS_DIR = join(ALLY_HOME, 'sessions');

/**
 * Directory for custom agent definitions
 */
export const AGENTS_DIR = join(ALLY_HOME, 'agents');

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
  SESSIONS_DIR,
  AGENTS_DIR,
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
