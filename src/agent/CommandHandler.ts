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
import { ConfigManager } from '../services/ConfigManager.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TokenManager } from './TokenManager.js';
import { logger } from '../services/Logger.js';
import { Message, ActivityEventType } from '../types/index.js';
import {
  BUFFER_SIZES,
  TEXT_LIMITS,
  CONTEXT_SIZES,
  FORMATTING,
} from '../config/constants.js';
import { CONTEXT_THRESHOLDS } from '../config/toolDefaults.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import type { MessageMetadata } from '../types/index.js';
import { Command } from './commands/Command.js';
import { UndoCommand } from './commands/UndoCommand.js';
import { ClearCommand } from './commands/ClearCommand.js';
import { FocusCommand } from './commands/FocusCommand.js';
import { DefocusCommand } from './commands/DefocusCommand.js';
import { FocusShowCommand } from './commands/FocusShowCommand.js';
import { ConfigCommand } from './commands/ConfigCommand.js';
import { ModelCommand } from './commands/ModelCommand.js';
import { ProjectCommand } from './commands/ProjectCommand.js';
import { TodoCommand } from './commands/TodoCommand.js';
import { AgentCommand } from './commands/AgentCommand.js';
import { PluginCommand } from './commands/PluginCommand.js';

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
    private configManager: ConfigManager,
    private serviceRegistry: ServiceRegistry
  ) {
    this.agent = agent;

    // Register class-based commands
    this.registerCommand(new UndoCommand());
    this.registerCommand(new ClearCommand());
    this.registerCommand(new FocusCommand());
    this.registerCommand(new DefocusCommand());
    this.registerCommand(new FocusShowCommand());
    this.registerCommand(new ConfigCommand());
    this.registerCommand(new ModelCommand());
    this.registerCommand(new ProjectCommand());
    this.registerCommand(new TodoCommand());
    this.registerCommand(new AgentCommand());
    this.registerCommand(new PluginCommand());
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
      case 'debug':
        return await this.handleDebug(args, messages);
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
    // Generate event ID: evt-{timestamp}-{7-char-random} (base-36, skip '0.' prefix)
    return `evt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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
  /debug [system|tokens|context|chat] - Show debug information
  /context                 - Show context usage (token count)
  /clear                   - Clear conversation history
  /compact                 - Compact conversation history
  /rewind                  - Rewind conversation to a previous message
  /undo [count]            - Undo last N file operations (default: 1)
  /exit, /quit             - Exit the application

Agent Commands:
  /agent create <desc>     - Create a new specialized agent
  /agent ls                - List available agents
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

Plugin Commands:
  /plugin config <name>    - Configure a plugin
`;

    return { handled: true, response: helpText };
  }

  /**
   * Handle /context command - show context usage (alias for /debug tokens)
   */
  private async handleContext(messages: Message[]): Promise<CommandResult> {
    // /context is a shortcut for /debug tokens
    return this.debugTokens(messages);
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

  private async handleDebug(args: string[], messages: Message[]): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    if (!argString) {
      return {
        handled: true,
        response: `Debug Commands:
  /debug system    - Show system prompt and tool definitions
  /debug tokens    - Show token usage and memory stats
  /debug context   - Show conversation context
  /debug chat      - Log full chat history as JSON to console
`,
      };
    }

    const parts = argString.split(/\s+/);
    const subcommand = parts[0];
    if (!subcommand) {
      return { handled: true, response: 'Invalid debug command' };
    }

    switch (subcommand.toLowerCase()) {
      case 'system':
        return this.debugSystem(messages);
      case 'tokens':
        return this.debugTokens(messages);
      case 'context':
        return this.debugContext(messages);
      case 'chat':
        return this.debugChat(messages);
      default:
        return {
          handled: true,
          response: `Unknown debug subcommand: ${subcommand}. Available: system, tokens, context, chat`,
        };
    }
  }

  /**
   * Debug: Show system prompt and tool definitions
   *
   * Based on Python implementation in command_handler.py:992-1060
   */
  private async debugSystem(messages: Message[]): Promise<CommandResult> {
    try {
      // Find system prompt in messages
      const systemMessage = messages.find(msg => msg.role === 'system');
      const systemPrompt = systemMessage?.content || '';

      if (!systemPrompt) {
        return {
          handled: true,
          response: 'No system prompt found in messages',
        };
      }

      // Get tool definitions if agent is available
      let toolDefinitions = '';
      if (this.agent) {
        const toolManager = this.serviceRegistry.get('tool_manager');
        if (toolManager && typeof toolManager === 'object' && 'getFunctionDefinitions' in toolManager) {
          const defs = (toolManager as any).getFunctionDefinitions();
          toolDefinitions = JSON.stringify(defs, null, 2);
        }
      }

      // Format output
      let output = '=== SYSTEM PROMPT ===\n\n';
      output += systemPrompt;
      output += '\n\n';

      if (toolDefinitions) {
        output += '=== TOOL DEFINITIONS ===\n\n';
        output += toolDefinitions;
      }

      return {
        handled: true,
        response: output,
      };
    } catch (error) {
      return {
        handled: true,
        response: `Error displaying system prompt: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Debug: Show token usage and memory stats
   *
   * Based on Python implementation in command_handler.py:1062-1091
   */
  private async debugTokens(messages: Message[]): Promise<CommandResult> {
    try {
      // Create a TokenManager instance for token counting
      const config = this.configManager.getConfig();
      const contextSize = config.context_size || CONTEXT_SIZES.XLARGE;
      const tokenManager = new TokenManager(contextSize);

      // Calculate token statistics
      const totalTokens = tokenManager.estimateMessagesTokens(messages);
      const percentUsed = ((totalTokens / contextSize) * 100).toFixed(
        FORMATTING.PERCENTAGE_DECIMAL_PLACES
      );

      // Breakdown by message type
      let userTokens = 0;
      let assistantTokens = 0;
      let systemTokens = 0;
      let toolTokens = 0;

      for (const msg of messages) {
        const msgTokens = tokenManager.estimateMessageTokens(msg);
        switch (msg.role) {
          case 'user':
            userTokens += msgTokens;
            break;
          case 'assistant':
            assistantTokens += msgTokens;
            break;
          case 'system':
            systemTokens += msgTokens;
            break;
          case 'tool':
            toolTokens += msgTokens;
            break;
        }
      }

      // Format output as a simple table
      let output = '=== TOKEN USAGE & MEMORY STATISTICS ===\n\n';
      output += `Total Tokens:        ${totalTokens}\n`;
      output += `Context Size:        ${contextSize}\n`;
      output += `Usage:               ${percentUsed}%\n`;
      output += `Remaining:           ${contextSize - totalTokens} tokens\n`;
      output += '\n=== MESSAGE BREAKDOWN ===\n\n';
      output += `Total Messages:      ${messages.length}\n`;
      output += `User Messages:       ${messages.filter(m => m.role === 'user').length} (${userTokens} tokens)\n`;
      output += `Assistant Messages:  ${messages.filter(m => m.role === 'assistant').length} (${assistantTokens} tokens)\n`;
      output += `System Messages:     ${messages.filter(m => m.role === 'system').length} (${systemTokens} tokens)\n`;
      output += `Tool Messages:       ${messages.filter(m => m.role === 'tool').length} (${toolTokens} tokens)\n`;

      // Add model info if available
      if (config.model) {
        output += '\n=== MODEL INFO ===\n\n';
        output += `Model:               ${config.model}\n`;
        output += `Temperature:         ${config.temperature || 0.7}\n`;
        output += `Max Tokens:          ${config.max_tokens || DEFAULT_CONFIG.max_tokens}\n`;
      }

      return {
        handled: true,
        response: output,
      };
    } catch (error) {
      return {
        handled: true,
        response: `Error displaying token usage: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Debug: Show conversation context
   *
   * Based on Python implementation in command_handler.py:1093-1132
   */
  private async debugContext(messages: Message[]): Promise<CommandResult> {
    try {
      // Format messages as JSON for display
      const contextData = messages.map(msg => ({
        role: msg.role,
        content: msg.content ? (msg.content.length > TEXT_LIMITS.CONTENT_PREVIEW_MAX ? msg.content.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX - 3) + '...' : msg.content) : undefined,
        tool_calls: msg.tool_calls,
        tool_call_id: msg.tool_call_id,
        name: msg.name,
      }));

      const jsonOutput = JSON.stringify(contextData, null, 2);

      let output = '=== CONVERSATION CONTEXT ===\n\n';
      output += `Total Messages: ${messages.length}\n\n`;
      output += jsonOutput;

      return {
        handled: true,
        response: output,
      };
    } catch (error) {
      return {
        handled: true,
        response: `Error displaying context: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Debug: Log full chat history to console as JSON
   */
  private async debugChat(messages: Message[]): Promise<CommandResult> {
    try {
      logger.debug('\n=== FULL CHAT HISTORY (JSON) ===\n');
      logger.debug(JSON.stringify(messages, null, 2));
      logger.debug('\n=== END CHAT HISTORY ===\n');

      return {
        handled: true,
        response: `Chat history logged to console (${messages.length} messages)`,
      };
    } catch (error) {
      return {
        handled: true,
        response: `Error logging chat history: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
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
