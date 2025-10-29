/**
 * CompletionProvider - Provides context-aware completions
 *
 * Features:
 * - Command completions for slash commands
 * - File path completions
 * - Agent name completions
 * - Context-aware suggestions based on cursor position
 */

import { promises as fs } from 'fs';
import { dirname, basename } from 'path';
import * as os from 'os';
import { AgentManager } from './AgentManager.js';
import { logger } from './Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { CACHE_TIMEOUTS, BUFFER_SIZES } from '../config/constants.js';

export type CompletionType = 'command' | 'file' | 'agent' | 'option';

export interface Completion {
  value: string;
  description?: string;
  type: CompletionType;
  insertText?: string; // Text to insert (if different from value)
}

export interface CompletionContext {
  input: string;
  cursorPosition: number;
  wordStart: number;
  wordEnd: number;
  currentWord: string;
  lineStart: string;
}

/**
 * Available slash commands
 */
const SLASH_COMMANDS = [
  { name: '/help', description: 'Show help information' },
  { name: '/init', description: 'Run setup wizard' },
  { name: '/config', description: 'View or modify configuration' },
  { name: '/model', description: 'Switch LLM model' },
  { name: '/debug', description: 'Show debug information' },
  { name: '/context', description: 'Show context usage' },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Compact conversation context' },
  { name: '/rewind', description: 'Rewind conversation' },
  { name: '/undo', description: 'Undo file operations' },
  { name: '/agent', description: 'Manage specialized agents' },
  { name: '/focus', description: 'Set focus to a specific path' },
  { name: '/defocus', description: 'Clear current focus' },
  { name: '/focus-show', description: 'Show current focus' },
  { name: '/project', description: 'Manage project configuration' },
  { name: '/todo', description: 'Manage todo list' },
  { name: '/exit', description: 'Exit the application' },
];

/**
 * Agent subcommands
 */
const AGENT_SUBCOMMANDS = [
  { name: 'create', description: 'Create a new agent' },
  { name: 'list', description: 'List available agents' },
  { name: 'ls', description: 'List available agents (short)' },
  { name: 'show', description: 'Show agent details' },
  { name: 'delete', description: 'Delete an agent' },
  { name: 'use', description: 'Use a specialized agent' },
];

/**
 * Todo subcommands
 */
const TODO_SUBCOMMANDS = [
  { name: 'add', description: 'Add a new todo' },
  { name: 'complete', description: 'Complete a todo by index' },
  { name: 'done', description: 'Complete a todo (alias)' },
  { name: 'clear', description: 'Clear completed todos' },
  { name: 'clear-all', description: 'Clear all todos' },
];

/**
 * CompletionProvider service
 */
export class CompletionProvider {
  private agentManager: AgentManager | null = null;
  private agentNamesCache: string[] = [];
  private agentsCacheTime: number = 0;
  private commandNamesCache: string[] = [];
  private commandsCacheTime: number = 0;
  private readonly cacheTTL = CACHE_TIMEOUTS.COMPLETION_CACHE_TTL;

  constructor(agentManager?: AgentManager) {
    this.agentManager = agentManager || null;
  }

  /**
   * Set the agent manager (for late binding)
   */
  setAgentManager(agentManager: AgentManager): void {
    this.agentManager = agentManager;
  }

  /**
   * Get completions for the current input
   *
   * @param input - Full input string
   * @param cursorPosition - Cursor position in the input
   * @returns Array of completions
   */
  async getCompletions(input: string, cursorPosition: number): Promise<Completion[]> {
    const context = this.parseContext(input, cursorPosition);

    // Determine what kind of completion to provide
    if (context.lineStart.startsWith('/')) {
      return await this.getCommandCompletions(context);
    } else if (context.lineStart.startsWith('!')) {
      return await this.getBashCompletions(context);
    } else if (context.currentWord.startsWith('@')) {
      return await this.getAgentCompletions(context);
    } else if (this.looksLikeFilePath(context.currentWord)) {
      return await this.getFileCompletions(context);
    }

    // No completions
    return [];
  }

  /**
   * Parse the input to understand completion context
   */
  private parseContext(input: string, cursorPosition: number): CompletionContext {
    // Find word boundaries around cursor
    let wordStart = cursorPosition;
    let wordEnd = cursorPosition;

    // Find start of word
    while (wordStart > 0) {
      const char = input[wordStart - 1];
      if (!char || this.isWordBoundary(char)) break;
      wordStart--;
    }

    // Find end of word
    while (wordEnd < input.length) {
      const char = input[wordEnd];
      if (!char || this.isWordBoundary(char)) break;
      wordEnd++;
    }

    const currentWord = input.slice(wordStart, wordEnd);

    // Get everything from start of line to cursor
    const lineStartIndex = input.lastIndexOf('\n', cursorPosition - 1) + 1;
    const lineStart = input.slice(lineStartIndex, cursorPosition);

    return {
      input,
      cursorPosition,
      wordStart,
      wordEnd,
      currentWord,
      lineStart,
    };
  }

  /**
   * Check if character is a word boundary
   */
  private isWordBoundary(char: string): boolean {
    return /\s/.test(char);
  }

  /**
   * Get command completions
   */
  private async getCommandCompletions(context: CompletionContext): Promise<Completion[]> {
    // Split and filter out empty strings
    const parts = context.lineStart.trim().split(/\s+/).filter(p => p.length > 0);
    const command = parts[0];
    const subcommand = parts[1];

    // Count words in lineStart (including partial word at end)
    const hasTrailingSpace = context.lineStart.endsWith(' ');
    const wordCount = hasTrailingSpace ? parts.length + 1 : parts.length;

    // Complete main command (only word is command itself, possibly partial)
    if (wordCount === 1) {
      return SLASH_COMMANDS.filter(cmd => cmd.name.startsWith(context.currentWord))
        .map(cmd => ({
          value: cmd.name.slice(1), // Remove leading / for display (icon already shows it)
          description: cmd.description,
          type: 'command' as const,
          insertText: cmd.name, // But insert the full command with /
        }));
    }

    // Complete subcommands for /agent (user typed "/agent ")
    if (command === '/agent' && wordCount === 2) {
      const prefix = subcommand || '';
      return AGENT_SUBCOMMANDS.filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));
    }

    // Complete agent names for /agent use (user typed "/agent use ")
    if (command === '/agent' && subcommand === 'use' && wordCount === 3) {
      return await this.getAgentNameCompletions(context.currentWord);
    }

    // Complete agent names for /agent show
    if (command === '/agent' && subcommand === 'show' && wordCount === 3) {
      return await this.getAgentNameCompletions(context.currentWord);
    }

    // Complete agent names for /agent delete
    if (command === '/agent' && subcommand === 'delete' && wordCount === 3) {
      return await this.getAgentNameCompletions(context.currentWord);
    }

    // Complete subcommands for /todo (user typed "/todo ")
    if (command === '/todo' && wordCount === 2) {
      const prefix = subcommand || '';
      return TODO_SUBCOMMANDS.filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));
    }

    // Complete subcommands for /config (user typed "/config ")
    if (command === '/config' && wordCount === 2) {
      const configSubcommands = [
        { name: 'set', description: 'Set a config value' },
        { name: 'reset', description: 'Reset to defaults' },
      ];
      const prefix = subcommand || '';
      return configSubcommands.filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));
    }

    // Complete config keys for /config set (user typed "/config set ")
    if (command === '/config' && subcommand === 'set' && wordCount === 3) {
      return await this.getConfigKeyCompletions(context.currentWord);
    }

    // Complete subcommands for /debug (user typed "/debug ")
    if (command === '/debug' && wordCount === 2) {
      const debugSubcommands = [
        { name: 'system', description: 'Show system prompt and tools' },
        { name: 'tokens', description: 'Show token usage stats' },
        { name: 'context', description: 'Show conversation context' },
      ];
      const prefix = subcommand || '';
      return debugSubcommands.filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));
    }

    // Complete subcommands for /memory (user typed "/memory ")
    if (command === '/memory' && wordCount === 2) {
      const memorySubcommands = [
        { name: 'add', description: 'Add a memory fact' },
        { name: 'ls', description: 'List all memories' },
        { name: 'rm', description: 'Remove a memory' },
        { name: 'clear', description: 'Clear all memories' },
        { name: 'show', description: 'Show memory details' },
      ];
      const prefix = subcommand || '';
      return memorySubcommands.filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));
    }

    // Complete subcommands for /project (user typed "/project ")
    if (command === '/project' && wordCount === 2) {
      const projectSubcommands = [
        { name: 'init', description: 'Initialize project context' },
        { name: 'edit', description: 'Edit project file' },
        { name: 'view', description: 'View project file' },
        { name: 'clear', description: 'Clear project context' },
      ];
      const prefix = subcommand || '';
      return projectSubcommands.filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));
    }

    // Complete file paths for /focus (user typed "/focus ")
    if (command === '/focus' && wordCount >= 2) {
      return await this.getFileCompletions(context);
    }

    return [];
  }

  /**
   * Get agent name completions
   */
  private async getAgentNameCompletions(prefix: string): Promise<Completion[]> {
    const agentNames = await this.getAgentNames();
    return agentNames
      .filter(name => name.startsWith(prefix))
      .map(name => ({
        value: name,
        description: 'Specialized agent',
        type: 'agent' as const,
      }));
  }

  /**
   * Get configuration key completions
   */
  private async getConfigKeyCompletions(prefix: string): Promise<Completion[]> {
    // Import config types dynamically
    const { DEFAULT_CONFIG, CONFIG_TYPES } = await import('../config/defaults.js');

    const configKeys = Object.keys(DEFAULT_CONFIG) as Array<keyof typeof DEFAULT_CONFIG>;

    // Group keys by category for better descriptions
    const keyDescriptions: Record<string, string> = {
      // LLM Model Settings
      'model': 'LLM model name',
      'endpoint': 'Ollama API endpoint',
      'context_size': 'Context window size (tokens)',
      'temperature': 'Generation temperature (0.0-1.0)',
      'max_tokens': 'Max tokens per response',

      // Execution Settings
      'bash_timeout': 'Bash command timeout (seconds)',
      'auto_confirm': 'Skip permission prompts',
      'parallel_tools': 'Enable parallel tool execution',

      // UI Preferences
      'theme': 'UI theme name',
      'compact_threshold': 'Auto-compact threshold (%)',
      'show_context_in_prompt': 'Show context % in prompt',

      // Tool Result Preview
      'tool_result_preview_lines': 'Preview lines count',
      'tool_result_preview_enabled': 'Enable tool previews',

      // Diff Display
      'diff_display_enabled': 'Show file diffs',
      'diff_display_max_file_size': 'Max diff file size (bytes)',
      'diff_display_context_lines': 'Diff context lines',
      'diff_display_theme': 'Diff theme',
      'diff_display_color_removed': 'Removed line color',
      'diff_display_color_added': 'Added line color',
      'diff_display_color_modified': 'Modified line color',

      // Tool Result Truncation
      'tool_result_max_tokens_normal': 'Max tokens (0-70% usage)',
      'tool_result_max_tokens_moderate': 'Max tokens (70-85% usage)',
      'tool_result_max_tokens_aggressive': 'Max tokens (85-95% usage)',
      'tool_result_max_tokens_critical': 'Max tokens (95%+ usage)',
    };

    return configKeys
      .filter(key => key.startsWith(prefix) && key !== 'setup_completed') // Hide internal keys
      .map(key => ({
        value: key,
        description: keyDescriptions[key] || `${CONFIG_TYPES[key]} setting`,
        type: 'option' as const,
      }));
  }

  /**
   * Get bash completions (for !bash syntax)
   */
  private async getBashCompletions(context: CompletionContext): Promise<Completion[]> {
    // Remove the ! prefix
    const bashCommand = context.lineStart.slice(1).trim();
    const parts = bashCommand.split(/\s+/).filter(p => p.length > 0);

    // Count words (including partial word at cursor)
    const hasTrailingSpace = context.lineStart.endsWith(' ');
    const wordCount = hasTrailingSpace ? parts.length + 1 : parts.length;

    // First word - complete command name from PATH
    if (wordCount === 1) {
      const prefix = parts[0] || '';
      return await this.getCommandNameCompletions(prefix);
    }

    // Subsequent words - complete file paths
    // Check if current word looks like a file path or is empty
    if (this.looksLikeFilePath(context.currentWord) || context.currentWord === '') {
      return await this.getFileCompletions(context);
    }

    return [];
  }

  /**
   * Get command name completions from PATH
   */
  private async getCommandNameCompletions(prefix: string): Promise<Completion[]> {
    const commandNames = await this.getCommandNames();
    return commandNames
      .filter(name => name.startsWith(prefix))
      .map(name => ({
        value: name,
        description: 'Command',
        type: 'command' as const,
      }));
  }

  /**
   * Get agent completions (for @agent syntax)
   */
  private async getAgentCompletions(context: CompletionContext): Promise<Completion[]> {
    const prefix = context.currentWord.slice(1); // Remove @
    const agentNames = await this.getAgentNames();

    return agentNames
      .filter(name => name.startsWith(prefix))
      .map(name => ({
        value: `@${name}`,
        description: 'Specialized agent',
        type: 'agent' as const,
      }));
  }

  /**
   * Get file path completions
   */
  private async getFileCompletions(context: CompletionContext): Promise<Completion[]> {
    try {
      let path = context.currentWord;

      // If path ends with /, user has completed a directory name
      // Show contents of that directory instead of filtering by name
      const endsWithSlash = path.endsWith('/');
      if (endsWithSlash && path.length > 1) {
        path = path.slice(0, -1); // Remove trailing slash for processing
      }

      // Resolve relative paths
      let baseDir: string;
      let searchPattern: string;

      if (endsWithSlash) {
        // User typed trailing slash - show contents of this directory
        if (path.startsWith('/')) {
          // Absolute path: /foo/bar/ -> show contents of /foo/bar
          baseDir = path || '/';
        } else if (path.startsWith('~')) {
          // Home directory: ~/foo/ -> show contents of ~/foo
          const homedir = os.homedir();
          baseDir = path.replace('~', homedir);
        } else {
          // Relative path: src/ -> show contents of src
          baseDir = path || '.';
        }
        searchPattern = ''; // Show all entries in the directory
      } else {
        // User is typing - show completions that match partial name
        if (path.startsWith('/')) {
          // Absolute path
          baseDir = dirname(path) || '/';
          searchPattern = basename(path);
        } else if (path.startsWith('~')) {
          // Home directory
          const homedir = os.homedir();
          const expandedPath = path.replace('~', homedir);
          baseDir = dirname(expandedPath);
          searchPattern = basename(expandedPath);
        } else {
          // Relative path - check if it contains a separator
          const hasSeparator = path.includes('/') || path.includes('\\');
          baseDir = hasSeparator ? dirname(path) : '.';
          searchPattern = basename(path);
        }
      }

      // Read directory
      const entries = await fs.readdir(baseDir, { withFileTypes: true });

      // Filter and map to completions
      const completions: Completion[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(searchPattern) || searchPattern === '') {
          const isDir = entry.isDirectory();

          completions.push({
            value: isDir ? `${entry.name}/` : entry.name,
            description: isDir ? 'Directory' : 'File',
            type: 'file',
            insertText: isDir ? `${entry.name}/` : entry.name,
          });
        }
      }

      // Sort: directories first, then alphabetically
      completions.sort((a, b) => {
        const aIsDir = a.description === 'Directory';
        const bIsDir = b.description === 'Directory';

        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.value.localeCompare(b.value);
      });

      return completions.slice(0, BUFFER_SIZES.MAX_COMPLETION_RESULTS); // Limit to 20 results
    } catch (error) {
      // Directory doesn't exist or can't be read - this is expected for new installations
      logger.debug(`Unable to read command directory: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Get list of available agent names
   */
  private async getAgentNames(): Promise<string[]> {
    // Use cache if fresh
    const now = Date.now();
    if (this.agentNamesCache.length > 0 && now - this.agentsCacheTime < this.cacheTTL) {
      return this.agentNamesCache;
    }

    if (!this.agentManager) {
      return [];
    }

    try {
      const agentsDir = this.agentManager.getAgentsDir();
      const entries = await fs.readdir(agentsDir);

      this.agentNamesCache = entries
        .filter(name => name.endsWith('.md'))
        .map(name => name.slice(0, -3)); // Remove .md extension

      this.agentsCacheTime = now;

      return this.agentNamesCache;
    } catch (error) {
      // Directory doesn't exist or can't be read - this is expected for new installations
      logger.debug(`Unable to read command directory: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Get list of available command names from PATH
   */
  private async getCommandNames(): Promise<string[]> {
    // Use cache if fresh
    const now = Date.now();
    if (this.commandNamesCache.length > 0 && now - this.commandsCacheTime < this.cacheTTL) {
      return this.commandNamesCache;
    }

    try {
      const pathEnv = process.env.PATH || '';
      const pathDirs = pathEnv.split(':').filter(dir => dir.length > 0);
      const commandSet = new Set<string>();

      // Read each directory in PATH
      for (const dir of pathDirs) {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });

          for (const entry of entries) {
            // Only add executable files
            if (entry.isFile()) {
              try {
                // Check if file is executable by attempting to stat with mode check
                const filePath = `${dir}/${entry.name}`;
                const stats = await fs.stat(filePath);
                // Check for executable permission (user, group, or other)
                const isExecutable = (stats.mode & 0o111) !== 0;

                if (isExecutable) {
                  commandSet.add(entry.name);
                }
              } catch {
                // Skip files we can't stat
              }
            }
          }
        } catch {
          // Skip directories we can't read
        }
      }

      this.commandNamesCache = Array.from(commandSet).sort();
      this.commandsCacheTime = now;

      return this.commandNamesCache;
    } catch (error) {
      logger.debug(`Unable to read PATH directories: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Check if string looks like a file path
   */
  private looksLikeFilePath(str: string): boolean {
    if (!str) return false;

    // Absolute path
    if (str.startsWith('/')) return true;

    // Home directory
    if (str.startsWith('~')) return true;

    // Relative path with separator (check for both / and \)
    if (str.includes('/') || str.includes('\\')) return true;

    // Current or parent directory
    if (str.startsWith('.') || str.startsWith('..')) return true;

    return false;
  }

  /**
   * Invalidate agent cache
   */
  invalidateAgentCache(): void {
    this.agentNamesCache = [];
    this.agentsCacheTime = 0;
  }

  /**
   * Invalidate command cache
   */
  invalidateCommandCache(): void {
    this.commandNamesCache = [];
    this.commandsCacheTime = 0;
  }

  /**
   * Get available slash commands
   */
  getSlashCommands(): Array<{ name: string; description: string }> {
    return [...SLASH_COMMANDS];
  }

  /**
   * Get agent subcommands
   */
  getAgentSubcommands(): Array<{ name: string; description: string }> {
    return [...AGENT_SUBCOMMANDS];
  }

  /**
   * Get todo subcommands
   */
  getTodoSubcommands(): Array<{ name: string; description: string }> {
    return [...TODO_SUBCOMMANDS];
  }
}
