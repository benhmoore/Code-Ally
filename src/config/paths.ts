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
import { existsSync } from 'fs';
import { join, dirname, basename, resolve as pathResolve } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
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
 * Base directory for all profiles
 */
export const PROFILES_DIR = join(ALLY_HOME, 'profiles');

/**
 * Base directory for project-scoped data, stored globally under ~/.ally and
 * keyed by absolute project path. Living outside the project tree keeps this
 * data private and out of version control.
 */
export const PROJECTS_DIR = join(ALLY_HOME, 'projects');

/**
 * Derive a stable, filesystem-safe key for a project directory.
 *
 * Combines a human-readable basename with a short hash of the absolute path,
 * so two projects that share a basename never collide and the directory name
 * remains recognizable (e.g. "code-ally-1a2b3c4d").
 *
 * @param projectDir - Absolute path to the project root (defaults to cwd)
 * @returns A safe directory name unique to this project path
 */
export function getProjectKey(projectDir: string = process.cwd()): string {
  const hash = createHash('sha256').update(projectDir).digest('hex').slice(0, 8);
  const slug = basename(projectDir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `${slug}-${hash}` : hash;
}

/**
 * Get the root data directory for a project, stored globally under ~/.ally and
 * keyed by the project's absolute path. Houses sessions, memory, and other
 * project-scoped state that should not live inside the working tree.
 *
 * @param projectDir - Absolute path to the project root (defaults to cwd)
 * @returns Path to the project's data directory
 */
export function getProjectDataDir(projectDir: string = process.cwd()): string {
  return join(PROJECTS_DIR, getProjectKey(projectDir));
}

/**
 * Get the sessions directory for a project (conversations, patches, and
 * persisted tool results). Lives under ~/.ally, outside the project tree, so
 * session history is kept out of the user's repository.
 *
 * @param projectDir - Absolute path to the project root (defaults to cwd)
 * @returns Path to the project's sessions directory
 */
export function getProjectSessionsDir(projectDir: string = process.cwd()): string {
  return join(getProjectDataDir(projectDir), 'sessions');
}

/**
 * Get the autonomous memory directory for a project.
 *
 * Memory is the agent-managed counterpart to ALLY.md: stored globally and keyed
 * by project path, so the agent can persist and recall facts without touching
 * the working tree. Each fact is one Markdown file; MEMORY.md is the index.
 *
 * @param projectDir - Absolute path to the project root (defaults to cwd)
 * @returns Path to the project's memory directory
 */
export function getProjectMemoryDir(projectDir: string = process.cwd()): string {
  return join(getProjectDataDir(projectDir), 'memory');
}

/**
 * Get the plans directory for a project (implementation plans written during
 * plan mode). Stored globally and keyed by project path, so plan files never
 * pollute the working tree or leak into version control.
 *
 * @param projectDir - Absolute path to the project root (defaults to cwd)
 * @returns Path to the project's plans directory
 */
export function getProjectPlansDir(projectDir: string = process.cwd()): string {
  return join(getProjectDataDir(projectDir), 'plans');
}

/**
 * Get the scheduled task store for a project. The file is project-scoped while
 * each task records its profile so the scheduler can run it with the same
 * runtime configuration that created it.
 *
 * @param projectDir - Absolute path to the project root (defaults to cwd)
 * @returns Path to the project's scheduled task JSON file
 */
export function getProjectScheduledTasksFile(projectDir: string = process.cwd()): string {
  return join(getProjectDataDir(projectDir), 'scheduled_tasks.json');
}

/**
 * Global index of all scheduled tasks. This lets `ally scheduler tick` find
 * due tasks without scanning every project data directory.
 */
export function getScheduledTasksIndexFile(): string {
  return join(ALLY_HOME, 'scheduled_tasks_index.json');
}

/**
 * Global scheduler lock file used to prevent overlapping ticks/runs.
 */
export function getSchedulerLockFile(): string {
  return join(ALLY_HOME, 'scheduler.lock');
}

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
 * Get the marketplace/plugins directory (global, not profile-specific)
 *
 * @returns Path to marketplace plugins directory
 */
export function getMarketplaceDir(): string {
  return join(ALLY_HOME, 'plugins');
}

/**
 * Get the plugin cache directory (where installed plugins are stored)
 *
 * @returns Path to plugin cache directory
 */
export function getPluginCacheDir(): string {
  return join(ALLY_HOME, 'plugins', 'cache');
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
 * Get the profile instructions file path for the active profile
 *
 * @returns Path to profile-specific instructions.md
 */
export function getProfileInstructionsFile(): string {
  return join(PROFILES_DIR, ACTIVE_PROFILE, 'instructions.md');
}

/**
 * Project instruction filenames, in order of precedence (highest first).
 *
 * Code-Ally ingests the first one that exists in a directory and ignores the
 * rest. ALLY.md is the native, preferred name; CLAUDE.md and AGENTS.md are
 * supported as fallbacks for cross-tool compatibility.
 */
export const PROJECT_INSTRUCTION_FILES = ['ALLY.md', 'CLAUDE.md', 'AGENTS.md'] as const;

/**
 * Get the native project instructions file path (ALLY.md) for a directory.
 *
 * This is the single canonical location for a project's committed context: the
 * file `/project init` writes, `/project view` reads, and the system prompt
 * ingests. Use this instead of re-deriving `join(cwd, 'ALLY.md')`.
 *
 * @param dir Directory to place the file in (defaults to the current working directory)
 * @returns Absolute path to ALLY.md
 */
export function getProjectInstructionsFile(dir: string = process.cwd()): string {
  return join(pathResolve(dir), PROJECT_INSTRUCTION_FILES[0]);
}

/**
 * Resolve the active project instructions file for a directory by precedence.
 *
 * @param dir Directory to search (defaults to the current working directory)
 * @returns Absolute path to the highest-precedence existing file, or null if none exist
 */
export function resolveProjectInstructionFiles(dir: string = process.cwd()): string[] {
  const start = pathResolve(dir);
  let projectRoot = start;
  let cursor = start;
  while (true) {
    if (existsSync(join(cursor, '.git'))) {
      projectRoot = cursor;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const directories: string[] = [];
  cursor = start;
  while (true) {
    directories.unshift(cursor);
    if (cursor === projectRoot) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return directories.flatMap((directory) => {
    const name = PROJECT_INSTRUCTION_FILES.find((candidate) => existsSync(join(directory, candidate)));
    return name ? [join(directory, name)] : [];
  });
}

/**
 * Get the base configuration file path (global defaults)
 *
 * @returns Path to base config.json
 */
export function getBaseConfigFile(): string {
  return join(ALLY_HOME, 'config.json');
}

/**
 * Get the MCP configuration file path for the active profile
 *
 * @returns Path to profile-specific mcp-config.json
 */
export function getMCPConfigFile(): string {
  return join(PROFILES_DIR, ACTIVE_PROFILE, 'mcp-config.json');
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
