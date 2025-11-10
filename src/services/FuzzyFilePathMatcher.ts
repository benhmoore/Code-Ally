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
  /** Whether this is a directory (vs a file) */
  isDirectory: boolean;
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
 * File metadata cached in the index
 */
interface FileIndexEntry {
  path: string;
  relativePath: string;
  filename: string;
  mtime: number;
  isDirectory: boolean;
}

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
  private fileIndex: Map<string, FileIndexEntry> = new Map();
  private indexValid = false;
  private lastIndexedCwd: string | null = null;

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
      // Build or rebuild index if needed
      if (!this.indexValid || this.lastIndexedCwd !== this.rootDir) {
        await this.buildIndex();
      }

      // Search the in-memory index instead of filesystem
      const matches: FuzzyMatchResult[] = [];
      for (const entry of this.fileIndex.values()) {
        const match = this.matchFileFromIndex(entry, normalizedQuery);
        if (match) {
          matches.push(match);
        }
      }

      // Sort by score (descending) and limit results
      matches.sort((a, b) => b.score - a.score);
      return matches.slice(0, this.maxResults);
    } catch (error) {
      logger.warn(`Fuzzy search failed: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Build the file index by traversing the directory tree
   * Caches file paths and metadata for O(1) lookup during search
   */
  private async buildIndex(): Promise<void> {
    const startTime = Date.now();
    this.fileIndex.clear();

    try {
      // Load .gitignore patterns if enabled
      if (this.respectGitignore) {
        await this.loadGitignorePatterns();
      }

      // Traverse directory and build index
      await this.indexDirectory(this.rootDir, 0);

      this.indexValid = true;
      this.lastIndexedCwd = this.rootDir;

      const elapsed = Date.now() - startTime;
      logger.debug(
        `Built file index: ${this.fileIndex.size} files in ${elapsed}ms (${this.rootDir})`
      );
    } catch (error) {
      logger.warn(`Failed to build file index: ${formatError(error)}`);
      this.indexValid = false;
    }
  }

  /**
   * Recursively index a directory
   *
   * @param dirPath - Directory to index
   * @param depth - Current recursion depth
   */
  private async indexDirectory(dirPath: string, depth: number): Promise<void> {
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

        try {
          const stats = await fs.stat(entryPath);
          const relativePath = relative(this.rootDir, entryPath);

          // Add to index
          this.fileIndex.set(entryPath, {
            path: entryPath,
            relativePath,
            filename: entryName,
            mtime: stats.mtimeMs,
            isDirectory: entry.isDirectory(),
          });

          // Recursively index subdirectories
          if (entry.isDirectory()) {
            await this.indexDirectory(entryPath, depth + 1);
          }
        } catch (error) {
          // Skip files that can't be stat'd
          logger.debug(`Unable to stat ${entryPath}: ${formatError(error)}`);
        }
      }
    } catch (error) {
      // Skip directories we can't read
      logger.debug(`Unable to read directory ${dirPath}: ${formatError(error)}`);
    }
  }

  /**
   * Match a file from the index against the query
   *
   * @param entry - File index entry
   * @param query - Normalized search query
   * @returns Match result or null if no match
   */
  private matchFileFromIndex(
    entry: FileIndexEntry,
    query: string
  ): FuzzyMatchResult | null {
    const normalizedFilename = entry.filename.toLowerCase();

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
    // 4. Acronym match
    else if (this.matchesAcronym(normalizedFilename, query)) {
      score = MATCH_SCORES.ACRONYM;
      matchType = 'acronym';
    }
    // 5. Path component match
    else if (this.matchesPathComponent(entry.relativePath, query)) {
      score = MATCH_SCORES.PATH_COMPONENT;
      matchType = 'path';
    }

    // No match found
    if (matchType === null) {
      return null;
    }

    // Apply bonuses using cached metadata
    score += this.calculateBonusesFromIndex(entry);

    return {
      path: entry.path,
      relativePath: entry.relativePath,
      filename: entry.filename,
      score,
      matchType,
      isDirectory: entry.isDirectory,
    };
  }

  /**
   * Calculate bonus scores using cached file metadata
   *
   * @param entry - File index entry
   * @returns Total bonus score
   */
  private calculateBonusesFromIndex(entry: FileIndexEntry): number {
    let bonus = 0;

    // Bonus for files in current directory (shallow paths)
    const depth = entry.relativePath.split(sep).length;
    if (depth === 1) {
      bonus += BONUS_SCORES.CURRENT_DIR;
    }

    // Bonus for recently modified files (using cached mtime)
    const now = Date.now();
    const daysSinceModified = (now - entry.mtime) / TIME_CONSTANTS.MS_PER_DAY;

    if (daysSinceModified <= TIME_CONSTANTS.DAYS_FOR_RECENT) {
      bonus += BONUS_SCORES.RECENT_FILE;
    }

    return bonus;
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
    const normalizedPath = relativePath.toLowerCase();

    // First check if the query (which may contain slashes) matches the path
    if (normalizedPath.includes(query)) {
      return true;
    }

    // Also check individual path components
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
    // Invalidate file index since directory changed
    this.indexValid = false;
  }

  /**
   * Clear all caches (gitignore patterns and file index)
   *
   * Useful if .gitignore file has been modified or files have changed
   */
  clearCache(): void {
    this.gitignorePatterns.clear();
    this.fileIndex.clear();
    this.indexValid = false;
  }
}
