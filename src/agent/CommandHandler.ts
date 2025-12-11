/**
 * CommandHandler - Comprehensive slash command system
 *
 * Implements all slash commands:
 * - Core: help, config, model, debug, compact, rewind, exit
 * - Agent: agent create/ls/show/use/delete
 * - Focus: focus, defocus, focus-show
 * - Project: project init/edit/view/clear
 * - Plugin: plugin config
 * - Utility: undo
 *
 * Note: Memory commands have been removed. Use session metadata for persistent facts.
 */

import { Agent } from './Agent.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { Message } from '../types/index.js';
import type { MessageMetadata } from '../types/index.js';
import { Command } from './commands/Command.js';
import { UndoCommand } from './commands/UndoCommand.js';
import { ClearCommand } from './commands/ClearCommand.js';
import { DebugCommand } from './commands/DebugCommand.js';
import { FocusCommand } from './commands/FocusCommand.js';
import { DefocusCommand } from './commands/DefocusCommand.js';
import { ConfigCommand } from './commands/ConfigCommand.js';
import { ModelCommand } from './commands/ModelCommand.js';
import { ProjectCommand } from './commands/ProjectCommand.js';
import { TodoCommand } from './commands/TodoCommand.js';
import { AgentCommand } from './commands/AgentCommand.js';
import { PluginCommand } from './commands/PluginCommand.js';
import { ResumeCommand } from './commands/ResumeCommand.js';
import { PromptCommand } from './commands/PromptCommand.js';
import { TaskCommand } from './commands/TaskCommand.js';
import { SwitchCommand } from './commands/SwitchCommand.js';
import { HelpCommand } from './commands/HelpCommand.js';
import { CompactCommand } from './commands/CompactCommand.js';
import { RewindCommand } from './commands/RewindCommand.js';
import { ExitCommand } from './commands/ExitCommand.js';
import { InitCommand } from './commands/InitCommand.js';
import { AddDirCommand } from './commands/AddDirCommand.js';
import { RemoveDirCommand } from './commands/RemoveDirCommand.js';
import { ListDirsCommand } from './commands/ListDirsCommand.js';
import { OpenCommand } from './commands/OpenCommand.js';

export interface CommandResult {
  handled: boolean;
  response?: string;
  updatedMessages?: Message[];
  metadata?: MessageMetadata; // Presentation hints for command responses
}

export class CommandHandler {
  private commands: Map<string, Command> = new Map();

  constructor(
    _agent: Agent | null,
    private serviceRegistry: ServiceRegistry
  ) {

    // Register class-based commands
    this.registerCommand(new AddDirCommand());
    this.registerCommand(new AgentCommand());
    this.registerCommand(new ClearCommand());
    this.registerCommand(new CompactCommand());
    this.registerCommand(new ConfigCommand());
    this.registerCommand(new DebugCommand());
    this.registerCommand(new DefocusCommand());
    this.registerCommand(new ExitCommand());
    this.registerCommand(new FocusCommand());
    this.registerCommand(new HelpCommand());
    this.registerCommand(new InitCommand());
    this.registerCommand(new ListDirsCommand());
    this.registerCommand(new ModelCommand());
    this.registerCommand(new OpenCommand());
    this.registerCommand(new PluginCommand());
    this.registerCommand(new ProjectCommand());
    this.registerCommand(new PromptCommand());
    this.registerCommand(new RemoveDirCommand());
    this.registerCommand(new ResumeCommand());
    this.registerCommand(new RewindCommand());
    this.registerCommand(new SwitchCommand());
    this.registerCommand(new TaskCommand());
    this.registerCommand(new TodoCommand());
    this.registerCommand(new UndoCommand());
  }

  /**
   * Register a command instance
   */
  private registerCommand(command: Command): void {
    // Strip the leading "/" from the command name
    const commandName = command.name.startsWith('/') ? command.name.slice(1) : command.name;
    this.commands.set(commandName, command);
  }

  /**
   * Handle a slash command
   *
   * @param input - Raw input starting with "/"
   * @param messages - Current conversation messages
   * @returns Command result with updated messages if needed
   */
  async handleCommand(input: string, messages: Message[]): Promise<CommandResult> {
    const parsed = this.parseCommand(input);

    if (!parsed) {
      return { handled: false };
    }

    const { command, args } = parsed;

    // Check if this is a class-based command
    const commandInstance = this.commands.get(command);
    if (commandInstance) {
      return await commandInstance.execute(args, messages, this.serviceRegistry);
    }

    // Unknown command
    return {
      handled: true,
      response: `Unknown command: /${command}. Type /help for available commands.`,
    };
  }

  /**
   * Parse command input
   *
   * @param input - Raw input
   * @returns Parsed command and args, or null if not a command
   */
  private parseCommand(input: string): { command: string; args: string[] } | null {
    const trimmed = input.trim();

    if (!trimmed.startsWith('/')) {
      return null;
    }

    // Remove leading slash
    const withoutSlash = trimmed.slice(1);

    // Split on first space to separate command from args
    const spaceIndex = withoutSlash.indexOf(' ');

    if (spaceIndex === -1) {
      return { command: withoutSlash.toLowerCase(), args: [] };
    }

    const command = withoutSlash.slice(0, spaceIndex).toLowerCase();
    const argsString = withoutSlash.slice(spaceIndex + 1).trim();

    // Split args on whitespace to get individual arguments
    return { command, args: argsString ? argsString.split(/\s+/) : [] };
  }

  // ===========================
  // Memory Commands - REMOVED
  // ===========================
  // Memory commands have been removed. Use session metadata for persistent facts instead.
  // Session metadata can be accessed through the SessionManager service and persists
  // across sessions without requiring a separate storage mechanism.


  // ===========================
  // NOTE: Undo functionality removed
  // ===========================
  // Users should use git for undoing file operations:
  // - git status        (see what changed)
  // - git diff          (view changes)
  // - git restore <file> (restore specific file)
  // - git reset --hard  (reset all changes)

}
