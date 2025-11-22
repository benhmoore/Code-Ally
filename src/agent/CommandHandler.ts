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
import { Message, ActivityEventType } from '../types/index.js';
import { ID_GENERATION, BUFFER_SIZES } from '../config/constants.js';
import { CONTEXT_THRESHOLDS } from '../config/toolDefaults.js';
import type { MessageMetadata } from '../types/index.js';
import { Command } from './commands/Command.js';
import { UndoCommand } from './commands/UndoCommand.js';
import { ClearCommand } from './commands/ClearCommand.js';
import { DebugCommand } from './commands/DebugCommand.js';
import { FocusCommand } from './commands/FocusCommand.js';
import { DefocusCommand } from './commands/DefocusCommand.js';
import { FocusShowCommand } from './commands/FocusShowCommand.js';
import { ConfigCommand } from './commands/ConfigCommand.js';
import { ModelCommand } from './commands/ModelCommand.js';
import { ProjectCommand } from './commands/ProjectCommand.js';
import { TodoCommand } from './commands/TodoCommand.js';
import { AgentCommand } from './commands/AgentCommand.js';
import { PluginCommand } from './commands/PluginCommand.js';
import { ResumeCommand } from './commands/ResumeCommand.js';
import { PromptCommand } from './commands/PromptCommand.js';
import { ProfileCommand } from './commands/ProfileCommand.js';
import { TaskCommand } from './commands/TaskCommand.js';

export interface CommandResult {
  handled: boolean;
  response?: string;
  updatedMessages?: Message[];
  metadata?: MessageMetadata; // Presentation hints for command responses
}

export class CommandHandler {
  private agent: Agent | null;
  private commands: Map<string, Command> = new Map();

  constructor(
    agent: Agent | null,
    private serviceRegistry: ServiceRegistry
  ) {
    this.agent = agent;

    // Register class-based commands
    this.registerCommand(new AgentCommand());
    this.registerCommand(new ClearCommand());
    this.registerCommand(new ConfigCommand());
    this.registerCommand(new DebugCommand());
    this.registerCommand(new DefocusCommand());
    this.registerCommand(new FocusCommand());
    this.registerCommand(new FocusShowCommand());
    this.registerCommand(new ModelCommand());
    this.registerCommand(new PluginCommand());
    this.registerCommand(new ProfileCommand());
    this.registerCommand(new ProjectCommand());
    this.registerCommand(new PromptCommand());
    this.registerCommand(new ResumeCommand());
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

    // Route to appropriate handler
    switch (command) {
      // Core commands
      case 'help':
        return await this.handleHelp();
      case 'context':
        return await this.handleContext(messages);
      case 'compact':
        return await this.handleCompact(args, messages);
      case 'rewind':
        return await this.handleRewind();
      case 'exit':
      case 'quit':
        return await this.handleExit();

      // Setup wizard
      case 'init':
        return await this.handleInit();

      default:
        return {
          handled: true,
          response: `Unknown command: /${command}. Type /help for available commands.`,
        };
    }
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

  /**
   * Generate a random ID for events
   */
  private generateRandomId(): string {
    // Generate event ID: evt-{timestamp}-{9-char-random} (base-36, skip '0.' prefix)
    return `evt-${Date.now()}-${Math.random().toString(ID_GENERATION.RANDOM_STRING_RADIX).substring(ID_GENERATION.RANDOM_STRING_SUBSTRING_START, ID_GENERATION.RANDOM_STRING_SUBSTRING_START + ID_GENERATION.RANDOM_STRING_LENGTH_LONG)}`;
  }

  // ===========================
  // Core Commands
  // ===========================

  private async handleHelp(): Promise<CommandResult> {
    const helpText = `
Available Commands:

Core Commands:
  /help                    - Show this help message
  /init                    - Run setup wizard
  /config                  - Toggle configuration viewer
  /config set <key>=<val>  - Set a configuration value
  /config reset            - Reset all settings to defaults
  /model [ally|service] [name] - Switch model or show current model
  /debug [calls] [n]       - Show tool call history
  /context                 - Show context usage (token count)
  /clear                   - Clear conversation history
  /compact                 - Compact conversation history
  /rewind                  - Rewind conversation to a previous message
  /resume                  - Resume a previous session
  /undo [count]            - Undo last N file operations (default: 1)

Saved Prompts:
  /prompt                  - Browse and insert saved prompts
  /prompt <id>             - Insert specific prompt by ID
  /prompt add              - Create a new prompt (select from messages or new)
  /prompt edit <id>        - Edit an existing prompt
  /prompt delete <id>      - Delete a prompt by ID
  /prompt list             - List all saved prompts
  /prompt clear            - Clear all saved prompts
  /exit, /quit             - Exit the application

Agent Commands:
  /agent create <desc>     - Create a new specialized agent
  /agent list              - List available agents
  /agent show <name>       - Show agent details
  /agent use <name> <task> - Use specific agent for a task
  /agent delete <name>     - Delete an agent
  /agent active            - Show active pooled agents
  /agent stats             - Show pool statistics
  /agent clear [id]        - Clear specific agent or all from pool

Focus Commands:
  /focus <path>            - Set directory focus
  /defocus                 - Clear focus
  /focus-show              - Show current focus

Project Commands:
  /project init            - Initialize project context
  /project edit            - Edit project file
  /project view            - View project file
  /project clear           - Clear project context

Todo Commands:
  /todo                    - Show current todo list
  /todo add <task>         - Add a new todo
  /todo complete <index>   - Complete a todo by index
  /todo clear              - Clear completed todos
  /todo clear-all          - Clear all todos

Task Commands:
  /task list               - List running background processes
  /task kill <shell_id>    - Kill a background process by ID

Plugin Commands:
  /plugin config <name>    - Configure a plugin

Profile Commands:
  /profile                 - Show current profile
  /profile list            - List all profiles
  /profile info [name]     - Show profile information
`;

    return { handled: true, response: helpText };
  }

  /**
   * Handle /context command - show context usage
   */
  private async handleContext(_messages: Message[]): Promise<CommandResult> {
    return {
      handled: true,
      response: 'Use /debug calls [n] to view recent tool call history.',
    };
  }


  /**
   * Handle /rewind command - show interactive conversation rewind UI
   */
  private async handleRewind(): Promise<CommandResult> {
    // Get activity stream from service registry
    const activityStream = this.serviceRegistry.get('activity_stream');

    if (!activityStream || typeof (activityStream as any).emit !== 'function') {
      return {
        handled: true,
        response: 'Rewind feature not available (activity stream not found).',
      };
    }

    // Emit rewind request event
    const requestId = `rewind_${Date.now()}`;

    (activityStream as any).emit({
      id: requestId,
      type: 'rewind_request',
      timestamp: Date.now(),
      data: {
        requestId,
      },
    });

    return { handled: true }; // Selection handled via UI
  }

  private async handleInit(): Promise<CommandResult> {
    const activityStream = this.serviceRegistry.get('activity_stream');

    if (!activityStream || typeof (activityStream as any).emit !== 'function') {
      return {
        handled: true,
        response: 'Setup wizard not available.',
      };
    }

    // Emit setup wizard request event
    const requestId = `setup_wizard_${Date.now()}`;

    (activityStream as any).emit({
      id: requestId,
      type: ActivityEventType.SETUP_WIZARD_REQUEST,
      timestamp: Date.now(),
      data: {
        requestId,
      },
    });

    return { handled: true }; // Handled via UI
  }

  private async handleCompact(
    args: string[],
    messages: Message[]
  ): Promise<CommandResult> {
    // Check if agent is available
    if (!this.agent) {
      return {
        handled: true,
        response: 'Error: Agent not available for compaction',
      };
    }

    // Check if we have enough messages to attempt compaction (Level 1: attempt threshold)
    if (messages.length < BUFFER_SIZES.MIN_MESSAGES_TO_ATTEMPT_COMPACTION) {
      return {
        handled: true,
        response: `Not enough messages to compact (only ${messages.length} messages). Need at least ${BUFFER_SIZES.MIN_MESSAGES_TO_ATTEMPT_COMPACTION} messages.`,
      };
    }

    // Extract custom instructions if provided
    const customInstructions = args.join(' ').trim() || undefined;

    try {
      // Get activity stream from service registry
      const activityStream = this.serviceRegistry.get('activity_stream');
      if (!activityStream || typeof (activityStream as any).emit !== 'function') {
        throw new Error('Activity stream not available');
      }

      // Emit compaction start event
      (activityStream as any).emit({
        id: this.generateRandomId(),
        type: ActivityEventType.COMPACTION_START,
        timestamp: Date.now(),
        data: {},
      });

      // Get context usage before compaction
      const registry = ServiceRegistry.getInstance();
      const tokenManager = registry.get('token_manager');
      const oldContextUsage = tokenManager && typeof (tokenManager as any).getContextUsagePercentage === 'function'
        ? (tokenManager as any).getContextUsagePercentage()
        : 0;

      // Perform compaction (delegate to Agent's unified method)
      // Use agent's internal messages (includes system prompt) rather than command parameter
      const compactedMessages = await this.agent.compactConversation(this.agent.getMessages(), {
        customInstructions,
        preserveLastUserMessage: false,
        timestampLabel: undefined,
      });

      // Update agent's internal messages
      this.agent.updateMessagesAfterCompaction(compactedMessages);

      // Update token count
      if (tokenManager && typeof (tokenManager as any).updateTokenCount === 'function') {
        (tokenManager as any).updateTokenCount(compactedMessages);
      }

      const newContextUsage = tokenManager && typeof (tokenManager as any).getContextUsagePercentage === 'function'
        ? (tokenManager as any).getContextUsagePercentage()
        : 0;

      // Emit compaction complete event
      (activityStream as any).emit({
        id: this.generateRandomId(),
        type: ActivityEventType.COMPACTION_COMPLETE,
        timestamp: Date.now(),
        data: {
          oldContextUsage,
          newContextUsage,
          threshold: CONTEXT_THRESHOLDS.CRITICAL,
          compactedMessages,
        },
      });

      return {
        handled: true,
        response: '', // No response needed, UI shows compaction notice
      };
    } catch (error) {
      return {
        handled: true,
        response: `Error compacting conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }


  private async handleExit(): Promise<CommandResult> {
    process.exit(0);
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
