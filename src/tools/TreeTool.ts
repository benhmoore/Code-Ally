/**
 * TreeTool - Display directory tree structure
 *
 * Shows hierarchical directory structure with intelligent filtering of
 * build artifacts, dependencies, and other noise. Supports multiple paths
 * for parallel exploration.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { resolvePath } from '../utils/pathUtils.js';
import { validateIsDirectory } from '../utils/pathValidator.js';
import { formatError } from '../utils/errorUtils.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

// Common directories and patterns to ignore (inspired by .gitignore best practices)
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '*.pyc',
  '.cache',
  'coverage',
  '.next',
  '.nuxt',
  '.vite',
  '.turbo',
  'vendor',
  'venv',
  '.venv',
  '.env',
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '.npm',
  '.yarn',
  '.pnp',
  'logs',
  'tmp',
  'temp',
  '.idea',
  '.vscode',
];

interface TreeOptions {
  depth: number;
  dirsOnly: boolean;
  includeHidden: boolean;
  ignoreGitignore: boolean;
}

export class TreeTool extends BaseTool {
  readonly name = 'tree';
  readonly description =
    'Display directory tree structure for one or more paths. Automatically filters out build artifacts, dependencies, and temporary files. More efficient than multiple ls calls.';
  readonly requiresConfirmation = false; // Read-only operation

  readonly usageGuidance = `**When to use tree:**
- Getting an overview of project structure
- Understanding directory hierarchy at a glance
- Exploring multiple directory branches simultaneously

**Example usage:**
- tree(paths=["."])  // Show entire project structure
- tree(paths=["src", "tests"])  // Explore multiple directories
- tree(paths=["backend"], depth=2)  // Limit depth to prevent explosion

Prefer tree over multiple sequential ls calls for directory exploration.`;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Provide custom function definition
   */
  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              description: 'Array of directory paths to show as trees (default: ["."])',
              items: {
                type: 'string',
              },
            },
            depth: {
              type: 'integer',
              description: 'Maximum depth to traverse (default: 3, prevents large output)',
            },
            dirs_only: {
              type: 'boolean',
              description: 'Show only directories, not files (default: false)',
            },
            include_hidden: {
              type: 'boolean',
              description: 'Include hidden files and directories (default: false)',
            },
            ignore_gitignore: {
              type: 'boolean',
              description: 'Do not apply .gitignore patterns (default: false)',
            },
          },
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    // Extract parameters
    const paths = (args.paths as string[]) || ['.'];
    const depth = args.depth !== undefined ? Number(args.depth) : 3;
    const dirsOnly = Boolean(args.dirs_only);
    const includeHidden = Boolean(args.include_hidden);
    const ignoreGitignore = Boolean(args.ignore_gitignore);

    // Validate paths array
    if (!Array.isArray(paths) || paths.length === 0) {
      return this.formatErrorResponse(
        'paths must be a non-empty array',
        'validation_error',
        'Example: tree(paths=["src", "tests"])'
      );
    }

    // Validate depth
    if (depth < 1 || depth > 10) {
      return this.formatErrorResponse(
        'depth must be between 1 and 10',
        'validation_error',
        'Example: tree(paths=["."], depth=3)'
      );
    }

    const options: TreeOptions = {
      depth,
      dirsOnly,
      includeHidden,
      ignoreGitignore,
    };

    // Process each path
    const results: string[] = [];
    const errors: string[] = [];
    let pathsProcessed = 0;

    for (const dirPath of paths) {
      try {
        const treeOutput = await this.generateTree(dirPath, options);
        results.push(treeOutput);
        pathsProcessed++;
      } catch (error) {
        const errorMsg = formatError(error);
        errors.push(`${dirPath}: ${errorMsg}`);
        results.push(`=== ${dirPath} ===\nError: ${errorMsg}`);
      }
    }

    // If ALL paths failed, return error
    if (pathsProcessed === 0) {
      return this.formatErrorResponse(
        `Failed to process ${errors.length} path${errors.length !== 1 ? 's' : ''}: ${errors.join(', ')}`,
        'file_error'
      );
    }

    const combinedOutput = results.join('\n\n');

    // Return success with partial failure warning if needed
    return this.formatSuccessResponse({
      content: combinedOutput,
      paths_processed: pathsProcessed,
      paths_failed: errors.length,
      partial_failure: errors.length > 0,
    });
  }

  /**
   * Generate tree output for a directory
   */
  private async generateTree(dirPath: string, options: TreeOptions): Promise<string> {
    // Resolve absolute path
    const absolutePath = resolvePath(dirPath);

    // Validate directory exists
    const validation = await validateIsDirectory(absolutePath);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Try native tree command first (faster, better formatting)
    const nativeTree = await this.tryNativeTree(absolutePath, options);
    if (nativeTree) {
      return `=== ${dirPath} ===\n${nativeTree}`;
    }

    // Fallback to TypeScript implementation
    const jsTree = await this.buildTreeJS(absolutePath, options);
    return `=== ${dirPath} ===\n${jsTree}`;
  }

  /**
   * Try using native tree command (if available)
   */
  private async tryNativeTree(absolutePath: string, options: TreeOptions): Promise<string | null> {
    try {
      // Build tree command with options
      const ignorePatterns = DEFAULT_IGNORE_PATTERNS.join('|');
      const args: string[] = [];

      // Depth
      args.push(`-L ${options.depth}`);

      // Dirs only
      if (options.dirsOnly) {
        args.push('-d');
      }

      // Hidden files
      if (options.includeHidden) {
        args.push('-a');
      } else {
        args.push('-I ".*"'); // Ignore hidden files
      }

      // Ignore patterns (always apply default patterns)
      args.push(`-I "${ignorePatterns}"`);

      // ASCII charset for compatibility
      args.push('--charset ascii');

      // No colors in output
      args.push('-n');

      const command = `tree ${args.join(' ')} "${absolutePath}"`;
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 1024 * 1024, // 1MB max output
        timeout: 5000 // 5 second timeout
      });

      if (stderr && !stderr.includes('cannot open directory')) {
        // Minor warnings are ok, just log them
        // Major errors will throw and we'll fallback
      }

      return stdout.trim();
    } catch (error: any) {
      // Tree command not available or failed - fallback to JS implementation
      // This is expected on systems without tree installed
      return null;
    }
  }

  /**
   * Build tree using TypeScript implementation (fallback)
   */
  private async buildTreeJS(absolutePath: string, options: TreeOptions): Promise<string> {
    const lines: string[] = [];
    const stats = { dirs: 0, files: 0 };

    // Load .gitignore patterns if requested
    const gitignorePatterns = options.ignoreGitignore
      ? []
      : await this.loadGitignorePatterns(absolutePath);

    // Build tree recursively
    await this.buildTreeRecursive(
      absolutePath,
      '',
      0,
      options,
      gitignorePatterns,
      lines,
      stats
    );

    // Add summary
    const summary = options.dirsOnly
      ? `${stats.dirs} directories`
      : `${stats.dirs} directories, ${stats.files} files`;

    lines.push('');
    lines.push(summary);

    return lines.join('\n');
  }

  /**
   * Recursively build tree structure
   */
  private async buildTreeRecursive(
    dirPath: string,
    prefix: string,
    currentDepth: number,
    options: TreeOptions,
    gitignorePatterns: string[],
    lines: string[],
    stats: { dirs: number; files: number }
  ): Promise<void> {
    // Get directory name
    const dirName = path.basename(dirPath) || dirPath;

    // Add this directory to output
    if (currentDepth === 0) {
      lines.push(`${dirName}/`);
    }

    // Stop if we've reached max depth
    if (currentDepth >= options.depth) {
      return;
    }

    // Read directory contents
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      // Permission denied or other error - skip this directory
      return;
    }

    // Filter entries
    entries = entries.filter(entry => {
      // Filter hidden files if not requested
      if (!options.includeHidden && entry.name.startsWith('.')) {
        return false;
      }

      // Filter by default ignore patterns
      if (this.shouldIgnore(entry.name, DEFAULT_IGNORE_PATTERNS)) {
        return false;
      }

      // Filter by gitignore patterns
      if (!options.ignoreGitignore && this.shouldIgnore(entry.name, gitignorePatterns)) {
        return false;
      }

      // Filter files if dirs only
      if (options.dirsOnly && !entry.isDirectory()) {
        return false;
      }

      return true;
    });

    // Sort entries (directories first, then alphabetically)
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    // Process entries
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!; // Safe because we're within array bounds
      const isLastEntry = i === entries.length - 1;
      const entryPath = path.join(dirPath, entry.name);

      // Build prefix for this entry
      const connector = isLastEntry ? '└── ' : '├── ';
      const entryPrefix = prefix + connector;

      if (entry.isDirectory()) {
        stats.dirs++;
        lines.push(`${entryPrefix}${entry.name}/`);

        // Recurse into subdirectory
        const newPrefix = prefix + (isLastEntry ? '    ' : '│   ');
        await this.buildTreeRecursive(
          entryPath,
          newPrefix,
          currentDepth + 1,
          options,
          gitignorePatterns,
          lines,
          stats
        );
      } else {
        stats.files++;
        lines.push(`${entryPrefix}${entry.name}`);
      }
    }
  }

  /**
   * Check if a name should be ignored based on patterns
   */
  private shouldIgnore(name: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
      // Simple glob matching (support * wildcards)
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(name);
      }
      return name === pattern;
    });
  }

  /**
   * Load .gitignore patterns from directory
   */
  private async loadGitignorePatterns(dirPath: string): Promise<string[]> {
    const patterns: string[] = [];

    try {
      // Look for .gitignore in current directory and parent directories
      let currentDir = dirPath;
      for (let i = 0; i < 3; i++) { // Check up to 3 levels up
        const gitignorePath = path.join(currentDir, '.gitignore');
        try {
          const content = await fs.readFile(gitignorePath, 'utf-8');
          const lines = content.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#')); // Ignore empty and comments
          patterns.push(...lines);
        } catch {
          // .gitignore doesn't exist at this level
        }

        // Move up one directory
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break; // Reached root
        currentDir = parentDir;
      }
    } catch {
      // Error reading gitignore - just use default patterns
    }

    return patterns;
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];

    // Show paths processed
    if (result.partial_failure) {
      const failed = result.paths_failed ?? 0;
      lines.push(`⚠️  Processed ${result.paths_processed} path(s), ${failed} failed`);
    } else {
      lines.push(`Processed ${result.paths_processed} path(s)`);
    }

    // Show preview of content
    if (result.content) {
      const contentLines = result.content.split('\n').slice(0, maxLines - lines.length);
      lines.push(...contentLines);

      if (result.content.split('\n').length > contentLines.length) {
        lines.push('...');
      }
    }

    return lines;
  }
}
