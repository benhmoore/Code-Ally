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
import { AgentManager } from './AgentManager.js';

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
  { name: '/config', description: 'View or modify configuration' },
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Compact conversation context' },
  { name: '/debug', description: 'Show debug information' },
  { name: '/agent', description: 'Manage specialized agents' },
  { name: '/focus', description: 'Manage focus mode' },
  { name: '/todo', description: 'Manage todo list' },
  { name: '/undo', description: 'Undo recent changes' },
  { name: '/context', description: 'Show context usage' },
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
 * CompletionProvider service
 */
export class CompletionProvider {
  private agentManager: AgentManager | null = null;
  private agentNamesCache: string[] = [];
  private agentsCacheTime: number = 0;
  private readonly cacheTTL = 5000; // 5 seconds

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
      const path = context.currentWord;

      // Resolve relative paths
      let baseDir: string;
      let searchPattern: string;

      if (path.startsWith('/')) {
        // Absolute path
        baseDir = dirname(path) || '/';
        searchPattern = basename(path);
      } else if (path.startsWith('~')) {
        // Home directory
        const homedir = require('os').homedir();
        const expandedPath = path.replace('~', homedir);
        baseDir = dirname(expandedPath);
        searchPattern = basename(expandedPath);
      } else {
        // Relative path - check if it contains a separator
        const hasSeparator = path.includes('/') || path.includes('\\');
        baseDir = hasSeparator ? dirname(path) : '.';
        searchPattern = basename(path);
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

      return completions.slice(0, 20); // Limit to 20 results
    } catch (error) {
      // Directory doesn't exist or can't be read
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
      // Directory doesn't exist or can't be read
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
}
