/**
 * ProfileManager - Profile management service
 *
 * Manages user profiles with isolated configurations, plugins, agents, and prompts.
 * Each profile maintains its own directory structure and settings.
 *
 * Features:
 * - Profile CRUD operations
 * - Profile cloning and deletion with quarantine
 * - Active profile tracking
 * - Profile statistics and validation
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { IService } from '../types/index.js';
import type { Profile, ProfileInfo, CreateProfileOptions, ProfileStats } from '../types/profile.js';
import { logger } from './Logger.js';
import { FORMATTING } from '../config/constants.js';

/**
 * ProfileManager handles all profile operations
 */
export class ProfileManager implements IService {
  private profilesDir: string;
  private activeProfileFile: string;
  private activeProfile: string | null = null;

  // Profile name validation constants
  private static readonly PROFILE_NAME_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;
  private static readonly RESERVED_NAMES = ['global', '.', '..'];
  private static readonly SPECIAL_PROFILES = ['default'];

  // Profile subdirectories
  private static readonly SUBDIRECTORIES = [
    'agents',
    'plugins',
    'plugin-envs',
    'prompts',
    'cache',
  ] as const;

  constructor() {
    const allyHome = join(homedir(), '.ally');
    this.profilesDir = join(allyHome, 'profiles');
    this.activeProfileFile = join(allyHome, 'active_profile');
  }

  /**
   * Initialize the service
   * Creates profiles directory and ensures default profile exists
   */
  async initialize(): Promise<void> {
    // Ensure profiles directory exists
    await fs.mkdir(this.profilesDir, { recursive: true });

    // Ensure .deleted quarantine directory exists
    await fs.mkdir(join(this.profilesDir, '.deleted'), { recursive: true });

    // Create default profile if it doesn't exist
    if (!(await this.profileExists('default'))) {
      await this.createProfile('default', {
        description: 'Default profile',
      });
      logger.info('[PROFILE] Created default profile');
    }

    // Verify active profile exists (will fall back to 'default' if needed)
    await this.getActiveProfile();
  }

  /**
   * Cleanup the service
   * No cleanup needed for ProfileManager
   */
  async cleanup(): Promise<void> {
    // No-op: Profiles are persisted on disk
  }

  /**
   * Validate a profile name
   *
   * @param name - Profile name to validate
   * @returns Validation result with error message if invalid
   */
  validateProfileName(name: string): { valid: boolean; error?: string } {
    // Check for empty or whitespace-only names
    if (!name || !name.trim()) {
      return { valid: false, error: 'Profile name cannot be empty' };
    }

    // Check length and allowed characters
    if (!ProfileManager.PROFILE_NAME_REGEX.test(name)) {
      return {
        valid: false,
        error: 'Profile name must be 1-50 characters and contain only alphanumeric, hyphens, or underscores',
      };
    }

    // Check reserved names
    if (ProfileManager.RESERVED_NAMES.includes(name.toLowerCase())) {
      return { valid: false, error: `Profile name '${name}' is reserved` };
    }

    // Check for names starting with dot
    if (name.startsWith('.')) {
      return { valid: false, error: 'Profile name cannot start with a dot' };
    }

    return { valid: true };
  }

  /**
   * Get the directory path for a profile
   *
   * @param name - Profile name
   * @returns Absolute path to profile directory
   */
  private getProfilePath(name: string): string {
    return join(this.profilesDir, name);
  }

  /**
   * Get the metadata file path for a profile
   *
   * @param name - Profile name
   * @returns Absolute path to profile.json
   */
  private getProfileMetadataPath(name: string): string {
    return join(this.getProfilePath(name), 'profile.json');
  }

  /**
   * Ensure all required subdirectories exist for a profile
   *
   * @param name - Profile name
   */
  private async ensureProfileDirectories(name: string): Promise<void> {
    const profilePath = this.getProfilePath(name);

    // Create main profile directory
    await fs.mkdir(profilePath, { recursive: true });

    // Create all subdirectories
    for (const subdir of ProfileManager.SUBDIRECTORIES) {
      await fs.mkdir(join(profilePath, subdir), { recursive: true });
    }
  }

  /**
   * Copy profile data from source to target
   *
   * Copies: config.json, agents/, prompts/
   * Does NOT copy: plugin-envs/ (to avoid environment conflicts)
   *
   * @param sourceName - Source profile name
   * @param targetName - Target profile name
   */
  private async copyProfileData(sourceName: string, targetName: string): Promise<void> {
    const sourcePath = this.getProfilePath(sourceName);
    const targetPath = this.getProfilePath(targetName);

    // Copy config.json if it exists
    const sourceConfig = join(sourcePath, 'config.json');
    const targetConfig = join(targetPath, 'config.json');
    try {
      await fs.access(sourceConfig);
      await fs.copyFile(sourceConfig, targetConfig);
      logger.debug(`[PROFILE] Copied config.json from ${sourceName} to ${targetName}`);
    } catch (error) {
      // Config file doesn't exist, that's okay
      logger.debug(`[PROFILE] No config.json to copy from ${sourceName}`);
    }

    // Copy agents directory
    await this.copyDirectory(
      join(sourcePath, 'agents'),
      join(targetPath, 'agents')
    );

    // Copy prompts directory
    await this.copyDirectory(
      join(sourcePath, 'prompts'),
      join(targetPath, 'prompts')
    );

    logger.info(`[PROFILE] Cloned data from ${sourceName} to ${targetName}`);
  }

  /**
   * Recursively copy a directory
   *
   * @param source - Source directory path
   * @param target - Target directory path
   */
  private async copyDirectory(source: string, target: string): Promise<void> {
    try {
      // Check if source exists
      await fs.access(source);
    } catch (error) {
      // Source doesn't exist, nothing to copy
      return;
    }

    // Ensure target directory exists
    await fs.mkdir(target, { recursive: true });

    // Read source directory
    const entries = await fs.readdir(source, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = join(source, entry.name);
      const targetPath = join(target, entry.name);

      if (entry.isDirectory()) {
        // Recursively copy subdirectory
        await this.copyDirectory(sourcePath, targetPath);
      } else {
        // Copy file
        await fs.copyFile(sourcePath, targetPath);
      }
    }
  }

  /**
   * Load a profile's metadata
   *
   * @param name - Profile name
   * @returns Profile metadata
   * @throws Error if profile doesn't exist or metadata is invalid
   */
  async loadProfile(name: string): Promise<Profile> {
    const metadataPath = this.getProfileMetadataPath(name);

    try {
      const content = await fs.readFile(metadataPath, 'utf-8');

      // Handle empty or corrupted files
      if (!content || content.trim().length === 0) {
        throw new Error('Profile metadata is empty');
      }

      const profile = JSON.parse(content) as Profile;
      return profile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Profile '${name}' does not exist`);
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Profile '${name}' has corrupted metadata: ${error.message}`);
      }

      logger.error(`Failed to load profile ${name}:`, error);
      throw error;
    }
  }

  /**
   * Save a profile's metadata
   *
   * @param profile - Profile metadata to save
   */
  async saveProfile(profile: Profile): Promise<void> {
    const metadataPath = this.getProfileMetadataPath(profile.name);

    try {
      // Update timestamp
      profile.updated_at = new Date().toISOString();

      const content = JSON.stringify(profile, null, FORMATTING.JSON_INDENT_SPACES);
      await fs.writeFile(metadataPath, content, 'utf-8');

      logger.debug(`[PROFILE] Saved metadata for profile ${profile.name}`);
    } catch (error) {
      logger.error(`Failed to save profile ${profile.name}:`, error);
      throw error;
    }
  }

  /**
   * Check if a profile exists
   *
   * @param name - Profile name
   * @returns True if profile exists
   */
  async profileExists(name: string): Promise<boolean> {
    try {
      await fs.access(this.getProfileMetadataPath(name));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new profile
   *
   * @param name - Profile name
   * @param options - Creation options (description, tags, cloneFrom)
   * @throws Error if name is invalid or profile already exists
   */
  async createProfile(name: string, options: CreateProfileOptions = {}): Promise<void> {
    // Validate profile name
    const validation = this.validateProfileName(name);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Check for case-insensitive uniqueness (lightweight check)
    const entries = await fs.readdir(this.profilesDir, { withFileTypes: true });
    const nameLower = name.toLowerCase();
    const duplicate = entries.find(
      entry => entry.isDirectory() &&
      !entry.name.startsWith('.') &&
      entry.name.toLowerCase() === nameLower
    );
    if (duplicate) {
      throw new Error(`Profile '${duplicate.name}' already exists (case-insensitive match)`);
    }

    // If cloning, verify source exists
    if (options.cloneFrom) {
      if (!(await this.profileExists(options.cloneFrom))) {
        throw new Error(`Source profile '${options.cloneFrom}' does not exist`);
      }
    }

    // Create profile directories
    await this.ensureProfileDirectories(name);

    // Clone data if requested
    if (options.cloneFrom) {
      await this.copyProfileData(options.cloneFrom, name);
    }

    // Create profile metadata
    const profile: Profile = {
      name,
      description: options.description,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      tags: options.tags,
      metadata: {},
    };

    await this.saveProfile(profile);

    logger.info(`[PROFILE] Created profile '${name}'${options.cloneFrom ? ` (cloned from ${options.cloneFrom})` : ''}`);
  }

  /**
   * Delete a profile
   *
   * Moves profile to quarantine directory instead of permanent deletion.
   * Prevents deletion of 'default' profile and active profile.
   *
   * @param name - Profile name
   * @param force - If false, throw error if profile has data
   * @throws Error if profile is default, active, or has data (when force=false)
   */
  async deleteProfile(name: string, force: boolean = false): Promise<void> {
    // Prevent deletion of default profile
    if (ProfileManager.SPECIAL_PROFILES.includes(name)) {
      throw new Error(`Cannot delete '${name}' profile`);
    }

    // Prevent deletion of active profile
    const activeProfile = await this.getActiveProfile();
    if (name === activeProfile) {
      throw new Error(`Cannot delete active profile '${name}'. Switch to another profile first.`);
    }

    // Check if profile exists
    if (!(await this.profileExists(name))) {
      throw new Error(`Profile '${name}' does not exist`);
    }

    // If not forcing, check if profile has data
    if (!force) {
      const stats = await this.getProfileStats(name);
      const hasData = stats.plugin_count > 0 ||
                      stats.agent_count > 0 ||
                      stats.prompt_count > 0 ||
                      stats.config_overrides > 0;

      if (hasData) {
        throw new Error(
          `Profile '${name}' contains data (${stats.plugin_count} plugins, ${stats.agent_count} agents, ${stats.prompt_count} prompts). Use force=true to delete anyway.`
        );
      }
    }

    // Move to quarantine
    const profilePath = this.getProfilePath(name);
    const timestamp = Date.now();
    const quarantinePath = join(this.profilesDir, '.deleted', `${name}-${timestamp}`);

    try {
      await fs.rename(profilePath, quarantinePath);
      logger.info(`[PROFILE] Deleted profile '${name}' (moved to quarantine: ${quarantinePath})`);
    } catch (error) {
      logger.error(`Failed to delete profile ${name}:`, error);
      throw new Error(`Failed to delete profile '${name}': ${error}`);
    }
  }

  /**
   * List all profiles
   *
   * @returns Array of profile information
   */
  async listProfiles(): Promise<ProfileInfo[]> {
    try {
      const entries = await fs.readdir(this.profilesDir, { withFileTypes: true });
      const profiles: ProfileInfo[] = [];
      const activeProfile = await this.getActiveProfile();

      for (const entry of entries) {
        // Skip non-directories and hidden directories
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue;
        }

        try {
          const profile = await this.loadProfile(entry.name);
          const stats = await this.getProfileStats(entry.name);

          profiles.push({
            name: profile.name,
            description: profile.description,
            created_at: profile.created_at,
            plugin_count: stats.plugin_count,
            agent_count: stats.agent_count,
            prompt_count: stats.prompt_count,
            is_active: entry.name === activeProfile,
          });
        } catch (error) {
          logger.warn(`[PROFILE] Failed to load profile ${entry.name}:`, error);
          // Skip corrupted profiles
        }
      }

      // Sort by name
      profiles.sort((a, b) => a.name.localeCompare(b.name));

      return profiles;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get the active profile name
   *
   * Reads from ~/.ally/active_profile file.
   * Defaults to 'default' if file doesn't exist or is invalid.
   * Caches the result for performance.
   *
   * @returns Active profile name
   */
  async getActiveProfile(): Promise<string> {
    // Return cached value if available
    if (this.activeProfile !== null) {
      return this.activeProfile;
    }

    try {
      const content = await fs.readFile(this.activeProfileFile, 'utf-8');
      const profileName = content.trim();

      // Validate the profile exists
      if (profileName && await this.profileExists(profileName)) {
        this.activeProfile = profileName;
        return profileName;
      }

      // Profile doesn't exist, fall back to default
      logger.warn(`[PROFILE] Active profile '${profileName}' not found, falling back to 'default'`);
      this.activeProfile = 'default';
      return 'default';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist, return default
        this.activeProfile = 'default';
        return 'default';
      }

      logger.error('[PROFILE] Error reading active profile file:', error);
      this.activeProfile = 'default';
      return 'default';
    }
  }

  /**
   * Set the active profile
   *
   * Writes to ~/.ally/active_profile file and updates cache.
   *
   * @param name - Profile name to activate
   * @throws Error if profile doesn't exist
   */
  async setActiveProfile(name: string): Promise<void> {
    // Validate profile exists
    if (!(await this.profileExists(name))) {
      throw new Error(`Profile '${name}' does not exist`);
    }

    try {
      await fs.writeFile(this.activeProfileFile, name, 'utf-8');
      this.activeProfile = name; // Update cache
      logger.info(`[PROFILE] Set active profile to '${name}'`);
    } catch (error) {
      logger.error(`Failed to set active profile to ${name}:`, error);
      throw new Error(`Failed to set active profile: ${(error as Error).message || error}`);
    }
  }

  /**
   * Get statistics for a profile
   *
   * @param name - Profile name
   * @returns Profile statistics
   */
  async getProfileStats(name: string): Promise<ProfileStats> {
    const profilePath = this.getProfilePath(name);

    // Count plugins
    const pluginCount = await this.countDirectoryEntries(join(profilePath, 'plugins'));

    // Count agents
    const agentCount = await this.countDirectoryEntries(join(profilePath, 'agents'));

    // Count prompts
    const promptCount = await this.countDirectoryEntries(join(profilePath, 'prompts'));

    // Count config overrides (values that differ from defaults)
    let configOverrides = 0;
    const configPath = join(profilePath, 'config.json');
    try {
      await fs.access(configPath);
      const content = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(content);
      // Import defaults for comparison
      const { DEFAULT_CONFIG } = await import('../config/defaults.js');
      // Count keys where value differs from default
      configOverrides = Object.keys(config).filter(key => {
        return key in DEFAULT_CONFIG && config[key] !== DEFAULT_CONFIG[key as keyof typeof DEFAULT_CONFIG];
      }).length;
    } catch (error) {
      // Config doesn't exist or is invalid, count as 0 overrides
    }

    return {
      plugin_count: pluginCount,
      agent_count: agentCount,
      prompt_count: promptCount,
      config_overrides: configOverrides,
    };
  }

  /**
   * Count entries in a directory
   *
   * @param dirPath - Directory path
   * @returns Number of entries (files and directories, excluding hidden files)
   */
  private async countDirectoryEntries(dirPath: string): Promise<number> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      // Filter out hidden files (starting with .)
      return entries.filter(entry => !entry.name.startsWith('.')).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }

}
