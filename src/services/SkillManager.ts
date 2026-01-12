/**
 * SkillManager - Skill discovery and loading
 *
 * Manages skill definitions stored as SKILL.md files in standard directories.
 * Skills provide contextual instructions that can be loaded on-demand.
 *
 * Standard locations (in priority order - project > user > plugin):
 * - Project: .github/skills/, .claude/skills/, .ally/skills/
 * - User: ~/.ally/skills/
 * - Plugin: (future - via plugin registration)
 *
 * SKILL.md format:
 * ```markdown
 * ---
 * name: skill-name
 * description: When to use this skill
 * ---
 *
 * # Skill Instructions
 * Detailed instructions here...
 * ```
 */

import { readdir, readFile, access, stat } from 'fs/promises';
import { join } from 'path';
import { constants } from 'fs';
import { logger } from './Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { ALLY_HOME } from '../config/paths.js';
import { parseFrontmatterYAML, extractFrontmatter } from '../utils/yamlUtils.js';
import {
  validateSkillName,
  SKILL_DESCRIPTION_MAX_LENGTH,
} from '../utils/namingValidation.js';
import type { IService } from '../types/index.js';

// ===========================
// Type Definitions
// ===========================

/**
 * Source type for skill definitions
 */
export type SkillSource = 'project' | 'user' | 'plugin';

/**
 * Full skill definition including instructions
 */
export interface SkillDefinition {
  /** Skill name (kebab-case, max 64 chars) */
  name: string;
  /** Description of when to use this skill (max 1024 chars) */
  description: string;
  /** Full SKILL.md body (markdown instructions) */
  instructions: string;
  /** Absolute path to the skill directory */
  directory: string;
  /** Source location type */
  source: SkillSource;
}

/**
 * Lightweight skill info for listing/discovery
 */
export interface SkillInfo {
  /** Skill name */
  name: string;
  /** Description of when to use this skill */
  description: string;
  /** Source location type */
  source: SkillSource;
}

// ===========================
// Constants
// ===========================

/** Name of the skill definition file */
const SKILL_FILE_NAME = 'SKILL.md';

/** Project-level skill directories (relative to working directory) */
const PROJECT_SKILL_DIRS = ['.github/skills', '.claude/skills', '.ally/skills'];

/** User-level skill directory */
const USER_SKILLS_DIR = join(ALLY_HOME, 'skills');

// ===========================
// SkillManager Implementation
// ===========================

export class SkillManager implements IService {
  /** Cached skills keyed by name (priority-resolved) */
  private skills: Map<string, SkillDefinition> = new Map();

  /** Working directory for project skill discovery */
  private workingDir: string;

  /** Plugin-registered skills */
  private pluginSkills: Map<string, SkillDefinition> = new Map();

  /** Whether skills have been loaded */
  private initialized: boolean = false;

  constructor(workingDir?: string) {
    this.workingDir = workingDir || process.cwd();
  }

  /**
   * Initialize the skill manager - load all skills
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.loadAllSkills();
    this.initialized = true;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.skills.clear();
    this.pluginSkills.clear();
    this.initialized = false;
  }

  /**
   * Update the working directory and reload skills
   *
   * @param workingDir - New working directory
   */
  async setWorkingDirectory(workingDir: string): Promise<void> {
    this.workingDir = workingDir;
    await this.loadAllSkills();
  }

  /**
   * Load all skills from all sources
   * Priority: project > user > plugin (same name = project wins)
   */
  private async loadAllSkills(): Promise<void> {
    this.skills.clear();

    // Load in reverse priority order so higher priority overwrites
    // 1. Plugin skills (lowest priority)
    for (const [name, skill] of this.pluginSkills) {
      this.skills.set(name, skill);
    }
    logger.debug(`[SkillManager] Loaded ${this.pluginSkills.size} plugin skill(s)`);

    // 2. User skills (medium priority)
    const userSkills = await this.loadSkillsFromDirectory(USER_SKILLS_DIR, 'user');
    for (const skill of userSkills) {
      this.skills.set(skill.name, skill);
    }
    logger.debug(`[SkillManager] Loaded ${userSkills.length} user skill(s)`);

    // 3. Project skills (highest priority)
    let projectSkillCount = 0;
    for (const relDir of PROJECT_SKILL_DIRS) {
      const absDir = join(this.workingDir, relDir);
      const projectSkills = await this.loadSkillsFromDirectory(absDir, 'project');
      for (const skill of projectSkills) {
        this.skills.set(skill.name, skill);
        projectSkillCount++;
      }
    }
    logger.debug(`[SkillManager] Loaded ${projectSkillCount} project skill(s)`);

    logger.debug(`[SkillManager] Total skills available: ${this.skills.size}`);
  }

  /**
   * Load skills from a directory containing skill subdirectories
   *
   * @param baseDir - Base directory to scan
   * @param source - Source type for loaded skills
   * @returns Array of loaded skill definitions
   */
  private async loadSkillsFromDirectory(
    baseDir: string,
    source: SkillSource
  ): Promise<SkillDefinition[]> {
    const skills: SkillDefinition[] = [];

    // Check if directory exists
    try {
      await access(baseDir, constants.F_OK);
    } catch {
      // Directory doesn't exist - not an error
      logger.debug(`[SkillManager] Directory not found: ${baseDir}`);
      return skills;
    }

    // Read directory entries
    let entries: string[];
    try {
      entries = await readdir(baseDir);
    } catch (error) {
      logger.debug(`[SkillManager] Could not read directory ${baseDir}: ${formatError(error)}`);
      return skills;
    }

    // Process each entry as a potential skill directory
    for (const entry of entries) {
      const skillDir = join(baseDir, entry);

      // Check if it's a directory
      try {
        const stats = await stat(skillDir);
        if (!stats.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      // Try to load skill from this directory
      const skill = await this.loadSkillFromDirectory(skillDir, source);
      if (skill) {
        skills.push(skill);
      }
    }

    return skills;
  }

  /**
   * Load a single skill from its directory
   *
   * @param skillDir - Path to skill directory
   * @param source - Source type
   * @returns Skill definition or null if invalid
   */
  private async loadSkillFromDirectory(
    skillDir: string,
    source: SkillSource
  ): Promise<SkillDefinition | null> {
    const skillFile = join(skillDir, SKILL_FILE_NAME);

    // Check if SKILL.md exists
    try {
      await access(skillFile, constants.F_OK);
    } catch {
      // No SKILL.md in this directory - not a skill
      return null;
    }

    // Read and parse SKILL.md
    let content: string;
    try {
      content = await readFile(skillFile, 'utf-8');
    } catch (error) {
      logger.warn(`[SkillManager] Could not read ${skillFile}: ${formatError(error)}`);
      return null;
    }

    return this.parseSkillFile(content, skillDir, source);
  }

  /**
   * Parse a SKILL.md file into a skill definition
   *
   * @param content - File content
   * @param skillDir - Path to skill directory
   * @param source - Source type
   * @returns Parsed skill definition or null if invalid
   */
  private parseSkillFile(
    content: string,
    skillDir: string,
    source: SkillSource
  ): SkillDefinition | null {
    const extracted = extractFrontmatter(content);
    if (!extracted) {
      logger.warn(`[SkillManager] Invalid SKILL.md format in ${skillDir}: missing frontmatter`);
      return null;
    }

    const { frontmatter, body } = extracted;
    const metadata = parseFrontmatterYAML(frontmatter);

    // Validate required fields
    if (!metadata.name) {
      logger.warn(`[SkillManager] Missing 'name' in ${skillDir}/SKILL.md`);
      return null;
    }

    if (!metadata.description) {
      logger.warn(`[SkillManager] Missing 'description' in ${skillDir}/SKILL.md`);
      return null;
    }

    // Validate name format
    const nameValidation = validateSkillName(metadata.name);
    if (!nameValidation.valid) {
      logger.warn(`[SkillManager] ${nameValidation.error} in ${skillDir}/SKILL.md`);
      return null;
    }

    // Truncate description if too long (with warning)
    let description = String(metadata.description);
    if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
      logger.warn(
        `[SkillManager] Description exceeds ${SKILL_DESCRIPTION_MAX_LENGTH} chars in ${skillDir}/SKILL.md, truncating`
      );
      description = description.substring(0, SKILL_DESCRIPTION_MAX_LENGTH);
    }

    const instructions = body.trim();
    if (!instructions) {
      logger.warn(`[SkillManager] Empty instructions in ${skillDir}/SKILL.md`);
      return null;
    }

    return {
      name: metadata.name,
      description,
      instructions,
      directory: skillDir,
      source,
    };
  }

  /**
   * Get a skill by name
   *
   * @param name - Skill name
   * @returns Skill definition or null if not found
   */
  async getSkill(name: string): Promise<SkillDefinition | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    return this.skills.get(name) || null;
  }

  /**
   * List all available skills (lightweight info only)
   *
   * @returns Array of skill info objects
   */
  async listSkills(): Promise<SkillInfo[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const infos: SkillInfo[] = [];
    for (const skill of this.skills.values()) {
      infos.push({
        name: skill.name,
        description: skill.description,
        source: skill.source,
      });
    }

    // Sort alphabetically by name
    infos.sort((a, b) => a.name.localeCompare(b.name));
    return infos;
  }

  /**
   * Get skills formatted for system prompt inclusion
   *
   * @returns Formatted string listing available skills
   */
  getSkillsForSystemPrompt(): string {
    if (this.skills.size === 0) {
      return '';
    }

    const lines: string[] = ['**Available Skills:**'];
    const sortedSkills = Array.from(this.skills.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const skill of sortedSkills) {
      lines.push(`- **${skill.name}**: ${skill.description}`);
    }

    return lines.join('\n');
  }

  /**
   * Get the directory path for a skill's resources
   *
   * @param name - Skill name
   * @returns Absolute path to skill directory or null if not found
   */
  getSkillDirectory(name: string): string | null {
    const skill = this.skills.get(name);
    return skill?.directory || null;
  }

  /**
   * Register a plugin-provided skill
   *
   * @param skill - Skill definition to register
   */
  registerPluginSkill(skill: SkillDefinition): void {
    const nameValidation = validateSkillName(skill.name);
    if (!nameValidation.valid) {
      logger.error(`[SkillManager] ${nameValidation.error}`);
      return;
    }

    // Ensure source is set to plugin
    const pluginSkill = { ...skill, source: 'plugin' as SkillSource };
    this.pluginSkills.set(skill.name, pluginSkill);

    // If already initialized, update the main skills map
    // But only if no higher-priority skill exists
    if (this.initialized && !this.hasHigherPrioritySkill(skill.name)) {
      this.skills.set(skill.name, pluginSkill);
    }

    logger.debug(`[SkillManager] Registered plugin skill '${skill.name}'`);
  }

  /**
   * Unregister a plugin-provided skill
   *
   * @param name - Skill name to unregister
   * @returns True if skill was found and removed
   */
  unregisterPluginSkill(name: string): boolean {
    const existed = this.pluginSkills.delete(name);

    // If initialized, reload to restore any overridden skills
    if (this.initialized && existed) {
      // Check if the main map has this skill and it's a plugin skill
      const current = this.skills.get(name);
      if (current?.source === 'plugin') {
        this.skills.delete(name);
      }
    }

    return existed;
  }

  /**
   * Check if a higher-priority skill (project or user) exists for a name
   *
   * @param name - Skill name
   * @returns True if a project or user skill exists with this name
   */
  private hasHigherPrioritySkill(name: string): boolean {
    const existing = this.skills.get(name);
    if (!existing) return false;
    return existing.source === 'project' || existing.source === 'user';
  }

  /**
   * Reload all skills (useful after working directory change)
   */
  async reload(): Promise<void> {
    await this.loadAllSkills();
  }

  /**
   * Check if a skill exists
   *
   * @param name - Skill name
   * @returns True if skill exists
   */
  hasSkill(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * Get the count of loaded skills
   *
   * @returns Number of skills loaded
   */
  getSkillCount(): number {
    return this.skills.size;
  }
}
