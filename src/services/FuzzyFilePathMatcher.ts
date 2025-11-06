/**
 * FuzzyFilePathMatcher - Fuzzy filepath matching for @ completion
 *
 * Features:
 * - Multiple fuzzy matching strategies (exact, substring, acronym, path component)
 * - Relevance scoring with bonuses for recency and proximity
 * - Efficient file system traversal with depth limiting
 * - Respects .gitignore patterns and skips common build directories
 * - Configurable limits for performance
 *
 * Usage Example:
 * ```typescript
 * const matcher = new FuzzyFilePathMatcher('/path/to/project', {
 *   maxDepth: 5,
 *   maxResults: 20,
 *   respectGitignore: true
 * });
 *
 * const results = await matcher.search('config');
 * // Returns files matching 'config' sorted by relevance:
 * // - ConfigManager.ts (exact match)
 * // - config.json (exact match)
 * // - src/config/defaults.ts (path component match)
 * ```
 */

import { promises as fs } from 'fs';
import { join, relative, sep } from 'path';
import { logger } from './Logger.js';
import { formatError } from '../utils/errorUtils.js';

/**
 * Match type for different fuzzy matching strategies
 */
export type MatchType = 'exact' | 'starts-with' | 'substring' | 'acronym' | 'path';

/**
 * Result of a fuzzy file path match
 */
export interface FuzzyMatchResult {
  /** Absolute path to the matched file */
  path: string;
  /** Path relative to search root */
  relativePath: string;
  /** Just the filename (basename) */
  filename: string;
  /** Relevance score (higher = more relevant) */
  score: number;
  /** Type of match that was found */
  matchType: MatchType;
}

/**
 * Configuration options for FuzzyFilePathMatcher
 */
export interface FuzzyMatchOptions {
  /** Maximum directory depth to traverse (default: 5) */
  maxDepth?: number;
  /** Maximum number of results to return (default: 20) */
  maxResults?: number;
  /** Additional glob patterns to exclude (beyond defaults) */
  excludePatterns?: string[];
  /** Whether to respect .gitignore files (default: true) */
  respectGitignore?: boolean;
}

/**
 * Default directories to exclude from search
 */
const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'out',
  'target',
  'vendor',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.tox',
  '.cache',
  '.idea',
  '.vscode',
  '.DS_Store',
]);

/**
 * Default file patterns to exclude
 */
const DEFAULT_EXCLUDE_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.gitkeep',
]);

/**
 * Scoring weights for different match types
 */
const MATCH_SCORES = {
  EXACT: 1000,
  STARTS_WITH: 500,
  SUBSTRING: 300,
  ACRONYM: 200,
  PATH_COMPONENT: 100,
} as const;

/**
 * Bonus scores
 */
const BONUS_SCORES = {
  CURRENT_DIR: 50,
  RECENT_FILE: 25, // Modified within 7 days
} as const;

/**
 * Time constants
 */
const TIME_CONSTANTS = {
  DAYS_FOR_RECENT: 7,
  MS_PER_DAY: 24 * 60 * 60 * 1000,
} as const;

/**
 * FuzzyFilePathMatcher - Search files with fuzzy matching
 */
export class FuzzyFilePathMatcher {
  private rootDir: string;
  private maxDepth: number;
  private maxResults: number;
  private excludePatterns: Set<string>;
  private respectGitignore: boolean;
  private gitignorePatterns: Set<string> = new Set();

  /**
   * Create a new FuzzyFilePathMatcher
   *
   * @param rootDir - Root directory to search from
   * @param options - Optional configuration
   */
  constructor(rootDir: string, options: FuzzyMatchOptions = {}) {
    this.rootDir = rootDir;
    this.maxDepth = options.maxDepth ?? 5;
    this.maxResults = options.maxResults ?? 20;
    this.respectGitignore = options.respectGitignore ?? true;

    // Combine default and custom exclude patterns
    this.excludePatterns = new Set([
      ...DEFAULT_EXCLUDE_DIRS,
      ...(options.excludePatterns || []),
    ]);
  }

  /**
   * Search for files matching the query
   *
   * @param query - Search query string
   * @returns Array of matching results, sorted by relevance
   */
  async search(query: string): Promise<FuzzyMatchResult[]> {
    if (!query || query.trim().length === 0) {
      return [];
    }

    const normalizedQuery = query.toLowerCase().trim();

    try {
      // Load .gitignore patterns if enabled
      if (this.respectGitignore) {
        await this.loadGitignorePatterns();
      }

      // Collect all matches
      const matches: FuzzyMatchResult[] = [];
      await this.searchDirectory(this.rootDir, normalizedQuery, matches, 0);

      // Sort by score (descending) and limit results
      matches.sort((a, b) => b.score - a.score);
      return matches.slice(0, this.maxResults);
    } catch (error) {
      logger.warn(`Fuzzy search failed: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Recursively search a directory for matching files
   *
   * @param dirPath - Directory to search
   * @param query - Normalized search query
   * @param matches - Array to accumulate matches
   * @param depth - Current recursion depth
   */
  private async searchDirectory(
    dirPath: string,
    query: string,
    matches: FuzzyMatchResult[],
    depth: number
  ): Promise<void> {
    // Check depth limit
    if (depth > this.maxDepth) {
      return;
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        const entryName = entry.name;

        // Skip excluded files/directories
        if (this.shouldExclude(entryName, entryPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          // Recursively search subdirectory
          await this.searchDirectory(entryPath, query, matches, depth + 1);
        } else if (entry.isFile()) {
          // Check if file matches query
          const match = await this.matchFile(entryPath, entryName, query);
          if (match) {
            matches.push(match);
          }
        }
      }
    } catch (error) {
      // Skip directories we can't read (permission issues, etc.)
      logger.debug(`Unable to read directory ${dirPath}: ${formatError(error)}`);
    }
  }

  /**
   * Check if a file matches the query and calculate its score
   *
   * @param filePath - Absolute file path
   * @param filename - File basename
   * @param query - Normalized search query
   * @returns Match result or null if no match
   */
  private async matchFile(
    filePath: string,
    filename: string,
    query: string
  ): Promise<FuzzyMatchResult | null> {
    const normalizedFilename = filename.toLowerCase();
    const relativePath = relative(this.rootDir, filePath);

    // Try different matching strategies
    let score = 0;
    let matchType: MatchType | null = null;

    // 1. Exact filename match (highest priority)
    if (normalizedFilename === query) {
      score = MATCH_SCORES.EXACT;
      matchType = 'exact';
    }
    // 2. Starts with query
    else if (normalizedFilename.startsWith(query)) {
      score = MATCH_SCORES.STARTS_WITH;
      matchType = 'starts-with';
    }
    // 3. Substring match
    else if (normalizedFilename.includes(query)) {
      score = MATCH_SCORES.SUBSTRING;
      matchType = 'substring';
    }
    // 4. Acronym match (e.g., "CH" matches "CommandHandler")
    else if (this.matchesAcronym(normalizedFilename, query)) {
      score = MATCH_SCORES.ACRONYM;
      matchType = 'acronym';
    }
    // 5. Path component match (match directory names too)
    else if (this.matchesPathComponent(relativePath, query)) {
      score = MATCH_SCORES.PATH_COMPONENT;
      matchType = 'path';
    }

    // No match found
    if (matchType === null) {
      return null;
    }

    // Apply bonuses
    score += await this.calculateBonuses(filePath, relativePath);

    return {
      path: filePath,
      relativePath,
      filename,
      score,
      matchType,
    };
  }

  /**
   * Check if filename matches query as an acronym
   *
   * Examples:
   * - "CH" matches "CommandHandler" (C + H)
   * - "fpm" matches "FuzzyPathMatcher" (F + P + M)
   * - "cfm" matches "ConfigManager" (C + M, allowing skip)
   *
   * @param filename - Normalized filename
   * @param query - Normalized query
   * @returns True if matches as acronym
   */
  private matchesAcronym(filename: string, query: string): boolean {
    if (query.length === 0) {
      return false;
    }

    let queryIndex = 0;
    let prevCharWasSeparator = true; // Start of string counts as separator

    for (let i = 0; i < filename.length && queryIndex < query.length; i++) {
      const char = filename[i]!;
      const isUpperCase = char >= 'A' && char <= 'Z';
      const isSeparator = char === '_' || char === '-' || char === '.' || char === ' ';

      // Check if this character could start a word
      const isWordStart = isUpperCase || (prevCharWasSeparator && !isSeparator);

      if (isWordStart && char.toLowerCase() === query[queryIndex]) {
        queryIndex++;
      }

      prevCharWasSeparator = isSeparator;
    }

    return queryIndex === query.length;
  }

  /**
   * Check if any path component (directory name) matches the query
   *
   * @param relativePath - Relative path to check
   * @param query - Normalized query
   * @returns True if any path component contains query
   */
  private matchesPathComponent(relativePath: string, query: string): boolean {
    const components = relativePath.split(sep);

    for (const component of components) {
      const normalized = component.toLowerCase();
      if (normalized.includes(query)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Calculate bonus scores based on file metadata
   *
   * @param filePath - Absolute file path
   * @param relativePath - Relative file path
   * @returns Total bonus score
   */
  private async calculateBonuses(filePath: string, relativePath: string): Promise<number> {
    let bonus = 0;

    try {
      // Bonus for files in current directory (shallow paths)
      const depth = relativePath.split(sep).length;
      if (depth === 1) {
        bonus += BONUS_SCORES.CURRENT_DIR;
      }

      // Bonus for recently modified files
      const stats = await fs.stat(filePath);
      const now = Date.now();
      const modifiedTime = stats.mtime.getTime();
      const daysSinceModified = (now - modifiedTime) / TIME_CONSTANTS.MS_PER_DAY;

      if (daysSinceModified <= TIME_CONSTANTS.DAYS_FOR_RECENT) {
        bonus += BONUS_SCORES.RECENT_FILE;
      }
    } catch (error) {
      // Ignore stat errors - file might have been deleted
      logger.debug(`Unable to stat file ${filePath}: ${formatError(error)}`);
    }

    return bonus;
  }

  /**
   * Check if a file or directory should be excluded
   *
   * @param name - File or directory name
   * @param path - Full path
   * @returns True if should be excluded
   */
  private shouldExclude(name: string, path: string): boolean {
    // Check if name is in exclude list
    if (this.excludePatterns.has(name)) {
      return true;
    }

    // Check if filename matches exclude patterns
    if (DEFAULT_EXCLUDE_FILES.has(name)) {
      return true;
    }

    // Check gitignore patterns if enabled
    if (this.respectGitignore && this.gitignorePatterns.size > 0) {
      const relativePath = relative(this.rootDir, path);
      if (this.matchesGitignorePattern(relativePath)) {
        return true;
      }
    }

    // Hidden files/directories (starting with .)
    // Allow common config files and directories
    const allowedHidden = [
      '.github',
      '.vscode',
      '.eslintrc',
      '.prettierrc',
      '.editorconfig',
      '.env.example',
    ];
    if (name.startsWith('.') && !allowedHidden.some(allowed => name.startsWith(allowed))) {
      return true;
    }

    return false;
  }

  /**
   * Load .gitignore patterns from the root directory
   */
  private async loadGitignorePatterns(): Promise<void> {
    try {
      const gitignorePath = join(this.rootDir, '.gitignore');
      const content = await fs.readFile(gitignorePath, 'utf-8');

      // Parse .gitignore file
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (trimmed.length === 0 || trimmed.startsWith('#')) {
          continue;
        }

        // Store pattern (simplified - just do basic matching)
        this.gitignorePatterns.add(trimmed);
      }

      logger.debug(`Loaded ${this.gitignorePatterns.size} .gitignore patterns`);
    } catch (error) {
      // .gitignore doesn't exist or can't be read - that's fine
      logger.debug(`No .gitignore found or unable to read: ${formatError(error)}`);
    }
  }

  /**
   * Check if a path matches any gitignore pattern
   *
   * This is a simplified implementation. For production use, consider
   * using a library like 'ignore' or 'minimatch' for full gitignore support.
   *
   * @param relativePath - Path relative to root directory
   * @returns True if path matches any gitignore pattern
   */
  private matchesGitignorePattern(relativePath: string): boolean {
    for (const pattern of this.gitignorePatterns) {
      // Handle directory patterns (ending with /)
      if (pattern.endsWith('/')) {
        const dirPattern = pattern.slice(0, -1);
        if (relativePath.startsWith(dirPattern + sep) || relativePath === dirPattern) {
          return true;
        }
      }
      // Handle exact matches
      else if (relativePath === pattern) {
        return true;
      }
      // Handle wildcards (simple implementation)
      else if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        if (regex.test(relativePath)) {
          return true;
        }
      }
      // Handle patterns that match path components
      else if (relativePath.includes(sep + pattern + sep) ||
               relativePath.startsWith(pattern + sep) ||
               relativePath.endsWith(sep + pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the root directory being searched
   *
   * @returns Root directory path
   */
  getRootDir(): string {
    return this.rootDir;
  }

  /**
   * Update the root directory for subsequent searches
   *
   * @param rootDir - New root directory
   */
  setRootDir(rootDir: string): void {
    this.rootDir = rootDir;
    // Clear cached gitignore patterns since we changed directory
    this.gitignorePatterns.clear();
  }

  /**
   * Clear cached gitignore patterns
   *
   * Useful if .gitignore file has been modified
   */
  clearCache(): void {
    this.gitignorePatterns.clear();
  }
}
