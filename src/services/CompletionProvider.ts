/**
 * CompletionProvider - Provides context-aware completions
 *
 * Features:
 * - Command completions for slash commands
 * - File path completions
 * - Fuzzy file path completions (@ syntax)
 * - Context-aware suggestions based on cursor position
 */

import { promises as fs } from 'fs';
import { dirname, basename } from 'path';
import * as os from 'os';
import { AgentManager } from './AgentManager.js';
import { logger } from './Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { CACHE_TIMEOUTS, BUFFER_SIZES, REASONING_EFFORT_API_VALUES, API_TIMEOUTS } from '../config/constants.js';
import { FuzzyFilePathMatcher, FuzzyMatchResult } from './FuzzyFilePathMatcher.js';
import { formatRelativeTime } from '../ui/utils/timeUtils.js';
import type { Config, SessionInfo } from '../types/index.js';
import { CommandRegistry } from '../agent/commands/CommandRegistry.js';

/**
 * Interface for ConfigManager methods used by CompletionProvider
 * This breaks the circular dependency between ConfigManager and CompletionProvider
 */
export interface IConfigManagerForCompletions {
  getValue<K extends keyof Config>(key: K): Config[K];
  getValue<K extends keyof Config>(key: K, defaultValue: Config[K]): Config[K];
}

export type CompletionType = 'command' | 'file' | 'directory' | 'option' | 'plugin';

export interface Completion {
  value: string;
  description?: string;
  type: CompletionType;
  insertText?: string; // Text to insert (if different from value)
  currentValue?: string; // Current value for config options (displayed dimly)
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
 * Help topics for /help filtering
 */
const HELP_TOPICS = [
  { name: 'input', description: 'Input modes (!, #, @, +, -)' },
  { name: 'core', description: 'Core commands' },
  { name: 'prompts', description: 'Prompt library commands' },
  { name: 'agents', description: 'Agent commands' },
  { name: 'project', description: 'Project & focus commands' },
  { name: 'todos', description: 'Todo commands' },
  { name: 'tasks', description: 'Background task commands' },
  { name: 'plugins', description: 'Plugin commands' },
];

/**
 * CompletionProvider service
 */
export class CompletionProvider {
  private agentManager: AgentManager | null = null;
  private configManager: IConfigManagerForCompletions | null = null;
  private agentNamesCache: string[] = [];
  private agentsCacheTime: number = 0;
  private commandNamesCache: string[] = [];
  private commandsCacheTime: number = 0;
  private readonly cacheTTL = CACHE_TIMEOUTS.COMPLETION_CACHE_TTL;
  private fuzzyMatcher: FuzzyFilePathMatcher;

  constructor(agentManager?: AgentManager, configManager?: IConfigManagerForCompletions) {
    this.agentManager = agentManager || null;
    this.configManager = configManager || null;
    this.fuzzyMatcher = new FuzzyFilePathMatcher(process.cwd());
  }

  /**
   * Set the agent manager (for late binding)
   */
  setAgentManager(agentManager: AgentManager): void {
    this.agentManager = agentManager;
  }

  /**
   * Set the working directory for fuzzy file path matching (for testing)
   */
  setWorkingDirectory(workingDir: string): void {
    this.fuzzyMatcher.setRootDir(workingDir);
  }

  /**
   * Set the config manager (for late binding)
   */
  setConfigManager(configManager: IConfigManagerForCompletions): void {
    this.configManager = configManager;
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
      return await this.getFuzzyFilePathCompletions(context);
    } else if (context.currentWord.startsWith('+')) {
      return await this.getPluginActivationCompletions(context);
    } else if (context.currentWord.startsWith('-')) {
      return await this.getPluginDeactivationCompletions(context);
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

    // Prefix characters that start new completion contexts (+plugin, -plugin, @file, /command)
    const prefixChars = ['+', '-', '@', '/'];

    // Scan backwards to find word start
    // Special handling: prefix characters at word boundaries are completion triggers
    while (wordStart > 0) {
      const charBefore = input[wordStart - 1];

      // Stop at whitespace
      if (!charBefore || this.isWordBoundary(charBefore)) break;

      // Include this character by moving back
      wordStart--;

      // Check if we just included a prefix character
      const currentChar = input[wordStart];
      if (currentChar && prefixChars.includes(currentChar)) {
        // Only treat it as a prefix if there's whitespace before it
        // This distinguishes "+plugin" from "my-plugin-name"
        const charBeforePrefix = wordStart > 0 ? input[wordStart - 1] : '';
        if (!charBeforePrefix || this.isWordBoundary(charBeforePrefix)) {
          // It's a prefix character, stop here
          break;
        }
        // Otherwise, it's just a hyphen in a word, keep scanning
      }
    }

    // Scan forwards to find word end
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
      const allCommands = CommandRegistry.getAll();
      return allCommands
        .filter(meta => meta.name.startsWith(context.currentWord))
        .map(meta => ({
          value: meta.name.slice(1), // Remove leading / for display (icon already shows it)
          description: meta.description,
          type: 'command' as const,
          insertText: meta.name, // But insert the full command with /
        }));
    }

    // Complete subcommands for /agent (user typed "/agent ")
    if (command === '/agent' && wordCount === 2) {
      const subcommands = CommandRegistry.getSubcommands('/agent');
      const prefix = subcommand || '';
      return subcommands
        .filter(sub => sub.name.startsWith(prefix))
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

    // Complete subcommands for /debug (user typed "/debug ")
    if (command === '/debug' && wordCount === 2) {
      const subcommands = CommandRegistry.getSubcommands('/debug');
      const prefix = subcommand || '';
      return subcommands
        .filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));
    }

    // Complete subcommands for /todo (user typed "/todo ")
    if (command === '/todo' && wordCount === 2) {
      const subcommands = CommandRegistry.getSubcommands('/todo');
      const prefix = subcommand || '';
      return subcommands
        .filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));
    }

    // Complete subcommands for /task (user typed "/task ")
    if (command === '/task' && wordCount === 2) {
      const subcommands = CommandRegistry.getSubcommands('/task');
      const prefix = subcommand || '';
      return subcommands
        .filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));
    }

    // Complete shell IDs for /task kill (user typed "/task kill ")
    if (command === '/task' && subcommand === 'kill' && wordCount === 3) {
      return await this.getRunningProcessCompletions(context.currentWord);
    }

    // Complete subcommands for /config (user typed "/config ")
    if (command === '/config' && wordCount === 2) {
      const subcommands = CommandRegistry.getSubcommands('/config');
      const prefix = subcommand || '';
      return subcommands
        .filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));
    }

    // Complete config keys and values for /config set
    // Format: /config set key=value (no space between key and value)
    if (command === '/config' && subcommand === 'set' && wordCount >= 3) {
      const thirdPart = parts[2] || context.currentWord;

      // Check if user has typed key= (value completion) or just key (key completion)
      const equalsIndex = thirdPart.indexOf('=');
      if (equalsIndex === -1) {
        // No equals sign yet - complete key names
        return await this.getConfigKeyCompletions(context.currentWord);
      } else {
        // Has equals sign - complete values
        const configKey = thirdPart.slice(0, equalsIndex);
        const valuePrefix = thirdPart.slice(equalsIndex + 1);
        const completions = await this.getConfigValueCompletions(configKey, valuePrefix);

        // Transform completions to include key= prefix in insertText
        return completions.map(c => ({
          ...c,
          insertText: `${configKey}=${c.value}`,
        }));
      }
    }

    // Complete subcommands for /project (user typed "/project ")
    if (command === '/project' && wordCount === 2) {
      const subcommands = CommandRegistry.getSubcommands('/project');
      const prefix = subcommand || '';
      return subcommands
        .filter(sub => sub.name.startsWith(prefix))
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

    // Complete directory paths for /add-dir (user typed "/add-dir ")
    if (command === '/add-dir' && wordCount >= 2) {
      return await this.getFileCompletions(context);
    }

    // Complete additional directories for /remove-dir (user typed "/remove-dir ")
    if (command === '/remove-dir' && wordCount === 2) {
      return await this.getAdditionalDirectoryCompletions(context.currentWord);
    }

    // Complete session names for /resume (user typed "/resume ")
    if (command === '/resume' && wordCount === 2) {
      return await this.getSessionNameCompletions(context.currentWord);
    }

    // Complete subcommands and prompts for /prompt (user typed "/prompt ")
    if (command === '/prompt' && wordCount === 2) {
      const prefix = subcommand || '';

      // Get subcommand completions
      const subcommands = CommandRegistry.getSubcommands('/prompt');
      const subcommandCompletions = subcommands
        .filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));

      // Get prompt completions
      const promptCompletions = await this.getPromptLibraryCompletions(prefix);

      // Return subcommands first, then prompts
      return [...subcommandCompletions, ...promptCompletions];
    }

    // Complete prompt IDs for /prompt delete (user typed "/prompt delete ")
    if (command === '/prompt' && subcommand === 'delete' && wordCount === 3) {
      return await this.getPromptLibraryCompletions(context.currentWord);
    }

    // Complete prompt IDs for /prompt edit (user typed "/prompt edit ")
    if (command === '/prompt' && subcommand === 'edit' && wordCount === 3) {
      return await this.getPromptLibraryCompletions(context.currentWord);
    }

    // Complete agent names for /switch (user typed "/switch ")
    if (command === '/switch' && wordCount === 2) {
      return await this.getSwitchAgentCompletions(context.currentWord);
    }

    // Complete subcommands for /plugin (user typed "/plugin ")
    if (command === '/plugin' && wordCount === 2) {
      const subcommands = CommandRegistry.getSubcommands('/plugin');
      const prefix = subcommand || '';
      return subcommands
        .filter(sub => sub.name.startsWith(prefix))
        .map(sub => ({
          value: sub.name,
          description: sub.description,
          type: 'command' as const,
        }));
    }

    // Complete plugin names for /plugin config (user typed "/plugin config ")
    if (command === '/plugin' && subcommand === 'config' && wordCount === 3) {
      return await this.getPluginNameCompletions(context.currentWord);
    }

    // Complete plugin names for /plugin show (user typed "/plugin show ")
    if (command === '/plugin' && subcommand === 'show' && wordCount === 3) {
      return await this.getPluginNameCompletions(context.currentWord);
    }

    // Complete file paths for /plugin install (user typed "/plugin install ")
    if (command === '/plugin' && subcommand === 'install' && wordCount >= 3) {
      return await this.getFileCompletions(context);
    }

    // Complete plugin names for /plugin uninstall (user typed "/plugin uninstall ")
    if (command === '/plugin' && subcommand === 'uninstall' && wordCount === 3) {
      return await this.getPluginNameCompletions(context.currentWord);
    }

    // Complete plugin names for /plugin activate (user typed "/plugin activate ")
    if (command === '/plugin' && subcommand === 'activate' && wordCount === 3) {
      return await this.getPluginNameCompletions(context.currentWord);
    }

    // Complete plugin names for /plugin deactivate (user typed "/plugin deactivate ")
    if (command === '/plugin' && subcommand === 'deactivate' && wordCount === 3) {
      return await this.getPluginNameCompletions(context.currentWord);
    }

    // Complete topics for /help (user typed "/help ")
    if (command === '/help' && wordCount === 2) {
      const prefix = subcommand || '';
      return HELP_TOPICS.filter(topic => topic.name.startsWith(prefix))
        .map(topic => ({
          value: topic.name,
          description: topic.description,
          type: 'command' as const,
        }));
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
        type: 'option' as const,
      }));
  }

  /**
   * Get agent name completions for /switch command
   * Includes special alias "ally" (main agent) plus all available agents
   */
  private async getSwitchAgentCompletions(prefix: string): Promise<Completion[]> {
    const completions: Completion[] = [];

    // Add special alias for main agent
    if ('ally'.startsWith(prefix)) {
      completions.push({
        value: 'ally',
        description: 'Main Ally agent',
        type: 'option' as const,
      });
    }

    // Add all available agents (including from inactive plugins)
    if (this.agentManager) {
      try {
        const agents = await this.agentManager.listAgents(undefined, { includeInactivePlugins: true });

        for (const agent of agents) {
          if (agent.name.startsWith(prefix)) {
            // Mark inactive plugin agents in the description
            const description = agent.isInactive
              ? `${agent.description || 'Specialized agent'} (plugin inactive)`
              : agent.description || 'Specialized agent';

            completions.push({
              value: agent.name,
              description,
              type: 'option' as const,
            });
          }
        }
      } catch (error) {
        logger.debug(`Unable to get agent list for /switch completion: ${formatError(error)}`);
      }
    }

    return completions;
  }

  /**
   * Get running process completions for /task kill command
   */
  private async getRunningProcessCompletions(prefix: string): Promise<Completion[]> {
    try {
      const { ServiceRegistry } = await import('./ServiceRegistry.js');
      const registry = ServiceRegistry.getInstance();
      const processManager = registry.get('bash_process_manager');

      if (!processManager || typeof (processManager as any).listProcesses !== 'function') {
        return [];
      }

      const allProcesses = (processManager as any).listProcesses();
      const runningProcesses = allProcesses.filter((p: any) => p.exitCode === null);

      if (runningProcesses.length === 0) {
        return [];
      }

      // Filter by prefix (allow matching full ID or short ID)
      const matches = runningProcesses.filter((proc: any) => {
        const shortId = proc.id.startsWith('shell-')
          ? proc.id.substring(6, 14) // First 8 digits after "shell-"
          : proc.id;
        return proc.id.includes(prefix) || shortId.includes(prefix);
      });

      const now = Date.now();

      // Map to completions with helpful descriptions
      return matches.map((proc: any) => {
        const { formatDuration } = require('../ui/utils/timeUtils.js');
        const elapsed = formatDuration(now - proc.startTime);
        const shortId = proc.id.startsWith('shell-')
          ? proc.id.substring(6, 14)
          : proc.id;

        // Truncate command if too long
        const maxCommandLength = 40;
        const displayCommand = proc.command.length > maxCommandLength
          ? proc.command.substring(0, maxCommandLength) + '...'
          : proc.command;

        return {
          value: shortId,
          description: `${displayCommand} (${elapsed})`,
          type: 'option' as const,
          insertText: proc.id, // Insert full ID
        };
      });
    } catch (error) {
      logger.debug(`Unable to get running process completions: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Get session name completions for /resume command
   */
  private async getSessionNameCompletions(prefix: string): Promise<Completion[]> {
    try {
      const { ServiceRegistry } = await import('./ServiceRegistry.js');
      const registry = ServiceRegistry.getInstance();
      const sessionManager = registry.get('session_manager');

      if (!sessionManager) {
        return [];
      }

      const sessions = await (sessionManager as any).getSessionsInfoByDirectory();

      // Sort by most recent first
      const sorted = sessions
        .sort((a: SessionInfo, b: SessionInfo) => b.last_modified_timestamp - a.last_modified_timestamp)
        .filter((s: SessionInfo) => s.display_name.toLowerCase().includes(prefix.toLowerCase()))
        .slice(0, 20);

      return sorted.map((session: SessionInfo) => ({
        value: session.display_name,
        description: `(${formatRelativeTime(session.last_modified_timestamp)})`,
        type: 'option' as const,
        insertText: session.session_id,
      }));
    } catch (error) {
      logger.debug(`Unable to get session completions: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Get additional directory completions for /remove-dir command
   */
  private async getAdditionalDirectoryCompletions(prefix: string): Promise<Completion[]> {
    try {
      const { ServiceRegistry } = await import('./ServiceRegistry.js');
      const registry = ServiceRegistry.getInstance();
      const additionalDirsManager = registry.get('additional_dirs_manager');

      if (!additionalDirsManager || typeof (additionalDirsManager as any).getDisplayPaths !== 'function') {
        return [];
      }

      const directories = (additionalDirsManager as any).getDisplayPaths();

      if (!directories || directories.length === 0) {
        return [];
      }

      // Filter by prefix
      const matches = directories.filter((dir: string) =>
        dir.toLowerCase().includes(prefix.toLowerCase())
      );

      return matches.map((dir: string) => ({
        value: dir,
        description: 'Additional directory',
        type: 'directory' as const,
      }));
    } catch (error) {
      logger.debug(`Unable to get additional directory completions: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Get prompt completions for /prompt command
   */
  private async getPromptLibraryCompletions(prefix: string): Promise<Completion[]> {
    try {
      const { ServiceRegistry } = await import('./ServiceRegistry.js');
      const registry = ServiceRegistry.getInstance();
      const promptLibraryManager = registry.getPromptLibraryManager();

      if (!promptLibraryManager) {
        return [];
      }

      const prompts = await promptLibraryManager.getPrompts();
      const lowerPrefix = prefix.toLowerCase();

      // Filter by title, content, ID, or tags matching prefix
      const filtered = prompts.filter((p: any) => {
        const titleMatch = p.title.toLowerCase().includes(lowerPrefix);
        const contentMatch = p.content.toLowerCase().includes(lowerPrefix);
        const idMatch = p.id.toLowerCase().includes(lowerPrefix);
        const tagsMatch = p.tags && p.tags.some((tag: string) => tag.toLowerCase().includes(lowerPrefix));

        return titleMatch || contentMatch || idMatch || tagsMatch;
      });

      // Sort by most recent first (already sorted by getPrompts, but ensure)
      const sorted = filtered.slice(0, 20); // Limit to 20 results

      return sorted.map((prompt: any) => {
        // Determine what matched for better user feedback
        const titleMatch = prompt.title.toLowerCase().includes(lowerPrefix);
        const contentMatch = prompt.content.toLowerCase().includes(lowerPrefix);
        const tagsMatch = prompt.tags && prompt.tags.some((tag: string) => tag.toLowerCase().includes(lowerPrefix));

        let matchIndicator = '';
        if (!titleMatch && contentMatch) {
          matchIndicator = ' (content match)';
        } else if (!titleMatch && tagsMatch) {
          matchIndicator = ' (tag match)';
        }

        const timeStr = formatRelativeTime(prompt.createdAt);
        const tagsStr = prompt.tags && prompt.tags.length > 0 ? ` • [${prompt.tags.join(', ')}]` : '';

        return {
          value: prompt.title,
          description: `${timeStr}${tagsStr}${matchIndicator}`,
          type: 'option' as const,
          insertText: prompt.id,
        };
      });
    } catch (error) {
      logger.debug(`Unable to get prompt library completions: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Get plugin name completions
   */
  private async getPluginNameCompletions(prefix: string): Promise<Completion[]> {
    try {
      const { getPluginsDir } = await import('../config/paths.js');
      const pluginsDir = getPluginsDir();
      const entries = await fs.readdir(pluginsDir);

      // Filter directories that start with prefix
      const pluginNames: string[] = [];
      for (const entry of entries) {
        try {
          const stat = await fs.stat(`${pluginsDir}/${entry}`);
          if (stat.isDirectory() && entry.startsWith(prefix)) {
            pluginNames.push(entry);
          }
        } catch {
          // Skip entries we can't stat
        }
      }

      return pluginNames.map(name => ({
        value: name,
        description: 'Plugin',
        type: 'plugin' as const,
      }));
    } catch (error) {
      logger.debug(`Unable to read plugins directory: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Get configuration value completions for a given key
   */
  private async getConfigValueCompletions(key: string, prefix: string): Promise<Completion[]> {
    // Import config types dynamically
    const { DEFAULT_CONFIG, CONFIG_TYPES } = await import('../config/defaults.js');

    // Check if this is a valid config key
    if (!(key in DEFAULT_CONFIG)) {
      return [];
    }

    const type = CONFIG_TYPES[key as keyof typeof CONFIG_TYPES];
    const completions: Completion[] = [];

    // Boolean values
    if (type === 'boolean') {
      const boolValues = ['true', 'false'];
      return boolValues
        .filter(val => val.startsWith(prefix))
        .map(val => ({
          value: val,
          description: val === 'true' ? 'Enable' : 'Disable',
          type: 'option' as const,
        }));
    }

    // Model field - fetch from Ollama
    if (key === 'model' || key === 'service_model' || key === 'explore_model' || key === 'plan_model') {
      const models = await this.getOllamaModels();
      return models
        .filter(model => model.toLowerCase().includes(prefix.toLowerCase()))
        .map(model => ({
          value: model,
          description: 'Ollama model',
          type: 'option' as const,
        }));
    }

    // Reasoning effort - predefined values
    if (key === 'reasoning_effort') {
      return [...REASONING_EFFORT_API_VALUES]
        .filter(val => val.startsWith(prefix))
        .map(val => ({
          value: val,
          description: `${val.charAt(0).toUpperCase() + val.slice(1)} reasoning effort`,
          type: 'option' as const,
        }));
    }

    // Default agent - list available agents
    if (key === 'default_agent') {
      const completions: Completion[] = [];

      // Add 'ally' as the default option
      if ('ally'.startsWith(prefix)) {
        completions.push({
          value: 'ally',
          description: 'Main Ally agent (default)',
          type: 'option' as const,
        });
      }

      // Add agents from AgentManager
      if (this.agentManager) {
        try {
          const agents = await this.agentManager.listAgents(undefined, { includeInactivePlugins: true });
          for (const agent of agents) {
            if (agent.name.startsWith(prefix)) {
              const inactive = agent.isInactive ? ' (plugin inactive)' : '';
              completions.push({
                value: agent.name,
                description: `${agent.description || 'Specialized agent'}${inactive}`,
                type: 'option' as const,
              });
            }
          }
        } catch (error) {
          logger.debug(`Unable to get agent list for default_agent completion: ${formatError(error)}`);
        }
      }

      return completions;
    }

    // Theme field - predefined values
    if (key === 'theme' || key === 'diff_display_theme') {
      const themes = key === 'theme'
        ? ['default', 'dark', 'light', 'minimal']
        : ['auto', 'dark', 'light', 'minimal'];
      return themes
        .filter(val => val.startsWith(prefix))
        .map(val => ({
          value: val,
          description: `${val.charAt(0).toUpperCase() + val.slice(1)} theme`,
          type: 'option' as const,
        }));
    }

    // For numbers, suggest the current value and some common alternatives
    if (type === 'number' && this.configManager) {
      try {
        const currentValue = this.configManager.getValue(key as keyof Config);
        if (typeof currentValue === 'number') {
          const suggestions: number[] = [currentValue];

          // Add contextual suggestions based on the key
          if (key === 'temperature') {
            suggestions.push(0.0, 0.3, 0.5, 0.7, 1.0);
          } else if (key === 'context_size') {
            suggestions.push(8192, 16384, 32768, 65536, 131072, 262144);
          } else if (key === 'max_tokens') {
            suggestions.push(2000, 4000, 7000, 10000, 16000);
          } else if (key === 'compact_threshold') {
            suggestions.push(80, 85, 90, 95, 99);
          }

          // Remove duplicates and filter by prefix
          const uniqueValues = [...new Set(suggestions)]
            .map(String)
            .filter(val => val.startsWith(prefix));

          return uniqueValues.map(val => ({
            value: val,
            description: val === String(currentValue) ? 'Current value' : 'Suggested value',
            type: 'option' as const,
          }));
        }
      } catch {
        // Fall through if we can't get current value
      }
    }

    return completions;
  }

  /**
   * Get available models from Ollama endpoint
   */
  private async getOllamaModels(): Promise<string[]> {
    try {
      // Get endpoint from config
      if (!this.configManager || typeof this.configManager.getValue !== 'function') {
        return [];
      }

      const endpoint = this.configManager.getValue('endpoint');
      if (!endpoint) {
        return [];
      }

      const url = `${endpoint}/api/tags`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUTS.OLLAMA_MODEL_LIST_TIMEOUT);

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as any;
      if (data?.models && Array.isArray(data.models)) {
        return data.models.map((m: any) => m.name || m.model).filter(Boolean);
      }

      return [];
    } catch (error) {
      // Failed to fetch models - this is expected if Ollama isn't running
      logger.debug(`Unable to fetch Ollama models: ${formatError(error)}`);
      return [];
    }
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
      'service_model': 'Model for background services (titles, idle messages)',
      'explore_model': 'Model for Explore agent',
      'plan_model': 'Model for Plan agent',
      'endpoint': 'Ollama API endpoint',
      'context_size': 'Context window size (tokens)',
      'temperature': 'Generation temperature (0.0-1.0)',
      'max_tokens': 'Max tokens per response',
      'reasoning_effort': 'Reasoning effort level (low/medium/high)',

      // Agent Settings
      'default_agent': 'Default agent at startup',

      // Execution Settings
      'bash_timeout': 'Bash command timeout (seconds)',
      'auto_confirm': 'Skip permission prompts',
      'parallel_tools': 'Enable parallel tool execution',

      // UI Preferences
      'theme': 'UI theme name',
      'compact_threshold': 'Auto-compact threshold (%)',
      'show_context_in_prompt': 'Show context % in prompt',
      'show_thinking_in_chat': 'Show model thinking in chat',
      'show_system_prompt_in_chat': 'Show system prompts in chat',
      'show_full_tool_output': 'Show full tool output without truncation',

      // Diff Display
      'diff_display_enabled': 'Show file diffs',
      'diff_display_max_file_size': 'Max diff file size (bytes)',
      'diff_display_context_lines': 'Diff context lines',
      'diff_display_theme': 'Diff theme',
      'diff_display_color_removed': 'Removed line color',
      'diff_display_color_added': 'Added line color',
      'diff_display_color_modified': 'Modified line color',

      // Tool Result Truncation
      'tool_result_max_context_percent': 'Max context % per tool result',
      'tool_result_min_tokens': 'Minimum tokens per result',
    };

    return configKeys
      .filter(key => key.startsWith(prefix) && key !== 'setup_completed') // Hide internal keys
      .map(key => {
        const baseDescription = keyDescriptions[key] || `${CONFIG_TYPES[key]} setting`;

        // Get current value if config manager is available
        let currentValue: string | undefined;
        if (this.configManager && typeof this.configManager.getValue === 'function') {
          try {
            const value = this.configManager.getValue(key);
            // Format value without quotes for strings, just the raw value
            if (typeof value === 'string') {
              currentValue = value;
            } else {
              currentValue = JSON.stringify(value);
            }
          } catch {
            // If we can't get the value, leave it undefined
          }
        }

        return {
          value: key,
          description: baseDescription,
          type: 'option' as const,
          currentValue,
          insertText: `${key}=`, // Add = suffix for immediate value entry
        };
      });
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
   * Get fuzzy file path completions (for @filepath syntax)
   *
   * Uses fuzzy matching to find files that match the query string after the @ symbol.
   * Results are sorted by relevance score, with bonuses for recent files and proximity.
   *
   * @param context - Completion context containing the current word and cursor position
   * @returns Array of file path completions sorted by relevance
   */
  private async getFuzzyFilePathCompletions(context: CompletionContext): Promise<Completion[]> {
    try {
      // Strip the @ prefix from the query
      const query = context.currentWord.slice(1);

      // If query is empty, return empty results
      if (!query || query.trim().length === 0) {
        return [];
      }

      // Search for matching files using fuzzy matcher
      const results: FuzzyMatchResult[] = await this.fuzzyMatcher.search(query);

      // Map results to Completion format
      return results.map(result => ({
        value: result.filename, // Show just the filename in left label
        description: dirname(result.relativePath), // Show directory in right label
        type: result.isDirectory ? ('directory' as const) : ('file' as const),
        insertText: result.relativePath, // Insert full path when selected
      }));
    } catch (error) {
      logger.debug(`Fuzzy file path completion failed: ${formatError(error)}`);
      return [];
    }
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
   * Get plugin activation completions (for +plugin-name syntax)
   *
   * Provides autocomplete suggestions when user types + followed by partial plugin name.
   * Shows all installed plugins, prioritizing inactive ones.
   *
   * @param context - Completion context containing the current word and cursor position
   * @returns Array of plugin completions sorted by relevance
   */
  private async getPluginActivationCompletions(context: CompletionContext): Promise<Completion[]> {
    try {
      // Get the partial plugin name after the + symbol
      const partial = context.currentWord.slice(1); // Remove + prefix

      // Get the service registry to access PluginActivationManager
      const { ServiceRegistry } = await import('./ServiceRegistry.js');
      const registry = ServiceRegistry.getInstance();

      // Get PluginActivationManager
      let activationManager;
      try {
        activationManager = registry.getPluginActivationManager();
      } catch {
        // If activation manager not available, return empty completions
        return [];
      }

      const installedPlugins = activationManager.getInstalledPlugins();

      // Filter plugins by partial match
      const matches = installedPlugins.filter(name =>
        name.toLowerCase().includes(partial.toLowerCase())
      );

      // Sort: inactive tagged plugins first (most likely to want to activate), then others
      const sorted = matches.sort((a, b) => {
        const aMode = activationManager.getActivationMode(a);
        const bMode = activationManager.getActivationMode(b);
        const aActive = activationManager.isActive(a);
        const bActive = activationManager.isActive(b);

        // Prioritize inactive tagged plugins (most likely to want to activate)
        if (!aActive && aMode === 'tagged' && (bActive || bMode === 'always')) return -1;
        if (!bActive && bMode === 'tagged' && (aActive || aMode === 'always')) return 1;

        return a.localeCompare(b);
      });

      // Map to Completion format with status indicators
      return sorted.map(name => {
        const mode = activationManager.getActivationMode(name);
        const active = activationManager.isActive(name);

        // Status indicators:
        // ✓ - Currently active
        // ● - Always mode (always active)
        // ○ - Tagged mode, inactive (needs activation)
        let status: string;
        let description: string;

        if (active && mode === 'always') {
          status = '● ';
          description = 'always active';
        } else if (active && mode === 'tagged') {
          status = '✓ ';
          description = 'tagged mode (active)';
        } else {
          status = '○ ';
          description = 'tagged mode (inactive)';
        }

        return {
          value: name,
          description: `${status}${description}`,
          type: 'plugin' as const,
          insertText: `+${name} `, // Insert with + prefix and trailing space
        };
      });
    } catch (error) {
      logger.debug(`Plugin activation completion failed: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Get plugin deactivation completions (for -plugin-name syntax)
   *
   * Provides autocomplete suggestions when user types - followed by partial plugin name.
   * Shows all currently active plugins (can deactivate temporarily in this conversation).
   *
   * @param context - Completion context containing the current word and cursor position
   * @returns Array of plugin completions sorted by relevance
   */
  private async getPluginDeactivationCompletions(context: CompletionContext): Promise<Completion[]> {
    try {
      // Get the partial plugin name after the - symbol
      const partial = context.currentWord.slice(1); // Remove - prefix

      // Get the service registry to access PluginActivationManager
      const { ServiceRegistry } = await import('./ServiceRegistry.js');
      const registry = ServiceRegistry.getInstance();

      // Get PluginActivationManager
      let activationManager;
      try {
        activationManager = registry.getPluginActivationManager();
      } catch {
        // If activation manager not available, return empty completions
        return [];
      }

      const activePlugins = activationManager.getActivePlugins();

      // Show all active plugins (user can deactivate any active plugin for this conversation)

      // Filter by partial match
      const matches = activePlugins.filter(name =>
        name.toLowerCase().includes(partial.toLowerCase())
      );

      // Sort alphabetically
      const sorted = matches.sort((a, b) => a.localeCompare(b));

      // Map to Completion format with mode indicator
      return sorted.map(name => {
        const mode = activationManager.getActivationMode(name);
        const modeLabel = mode === 'always' ? ' (always)' : '';
        return {
          value: name,
          description: `✓ active${modeLabel} (will deactivate)`,
          type: 'plugin' as const,
          insertText: `-${name} `, // Insert with - prefix and trailing space
        };
      });
    } catch (error) {
      logger.debug(`Plugin deactivation completion failed: ${formatError(error)}`);
      return [];
    }
  }

  /**
   * Get available slash commands
   */
  getSlashCommands(): Array<{ name: string; description: string }> {
    return CommandRegistry.getAll().map(meta => ({
      name: meta.name,
      description: meta.description,
    }));
  }

  /**
   * Get agent subcommands
   */
  getAgentSubcommands(): Array<{ name: string; description: string }> {
    return CommandRegistry.getSubcommands('/agent').map(sub => ({
      name: sub.name,
      description: sub.description,
    }));
  }

  /**
   * Get debug subcommands
   */
  getDebugSubcommands(): Array<{ name: string; description: string }> {
    return CommandRegistry.getSubcommands('/debug').map(sub => ({
      name: sub.name,
      description: sub.description,
    }));
  }

  /**
   * Get todo subcommands
   */
  getTodoSubcommands(): Array<{ name: string; description: string }> {
    return CommandRegistry.getSubcommands('/todo').map(sub => ({
      name: sub.name,
      description: sub.description,
    }));
  }

  /**
   * Get plugin subcommands
   */
  getPluginSubcommands(): Array<{ name: string; description: string }> {
    return CommandRegistry.getSubcommands('/plugin').map(sub => ({
      name: sub.name,
      description: sub.description,
    }));
  }
}
