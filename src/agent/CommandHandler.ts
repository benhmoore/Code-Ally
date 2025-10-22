/**
 * CommandHandler - Comprehensive slash command system
 *
 * Implements all slash commands:
 * - Core: help, config, model, debug, compact, rewind, exit
 * - Agent: agent create/ls/show/use/delete
 * - Focus: focus, defocus, focus-show
 * - Memory: memory add/ls/rm/clear/show
 * - Project: project init/edit/view/clear
 * - Utility: undo
 */

import { Agent } from './Agent.js';
import { ConfigManager } from '../services/ConfigManager.js';
import { AgentManager } from '../services/AgentManager.js';
import { FocusManager } from '../services/FocusManager.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TokenManager } from './TokenManager.js';
import { Message, ActivityEventType } from '../types/index.js';
import type { MemoryManager } from '../services/MemoryManager.js';
import type { ProjectManager } from '../services/ProjectManager.js';
import type { UndoManager } from '../services/UndoManager.js';
import type { TodoManager } from '../services/TodoManager.js';

export interface CommandResult {
  handled: boolean;
  response?: string;
  updatedMessages?: Message[];
}

export class CommandHandler {
  private agent: Agent | null;

  constructor(
    agent: Agent | null,
    private configManager: ConfigManager,
    private serviceRegistry: ServiceRegistry
  ) {
    this.agent = agent;
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

    // Route to appropriate handler
    switch (command) {
      // Core commands
      case 'help':
        return await this.handleHelp();
      case 'config':
        return await this.handleConfig(args);
      case 'model':
        return await this.handleModel(args);
      case 'debug':
        return await this.handleDebug(args, messages);
      case 'compact':
        return await this.handleCompact(args, messages);
      case 'rewind':
        return await this.handleRewind();
      case 'exit':
      case 'quit':
        return await this.handleExit();

      // Agent commands
      case 'agent':
        return await this.handleAgent(args, messages);

      // Focus commands
      case 'focus':
        return await this.handleFocus(args);
      case 'defocus':
        return await this.handleDefocus();
      case 'focus-show':
        return await this.handleFocusShow();

      // Memory commands
      case 'memory':
        return await this.handleMemory(args, messages);

      // Project commands
      case 'project':
        return await this.handleProject(args, messages);

      // Utility commands
      case 'undo':
        return await this.handleUndo(args, messages);

      // Todo commands
      case 'todo':
        return await this.handleTodo(args);

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

    return { command, args: argsString ? [argsString] : [] };
  }

  /**
   * Generate a random ID for events
   */
  private generateRandomId(): string {
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
  /model [name]            - Switch model or show current model
  /debug [system|tokens]   - Show debug information
  /compact                 - Compact conversation history
  /rewind                  - Rewind conversation to a previous message
  /exit, /quit             - Exit the application

Agent Commands:
  /agent create <desc>     - Create a new specialized agent
  /agent ls                - List available agents
  /agent show <name>       - Show agent details
  /agent use <name> <task> - Use specific agent for a task
  /agent delete <name>     - Delete an agent

Focus Commands:
  /focus <path>            - Set directory focus
  /defocus                 - Clear focus
  /focus-show              - Show current focus

Memory Commands:
  /memory add <fact>       - Add a memory fact
  /memory ls               - List all memories
  /memory rm <id>          - Remove a memory
  /memory clear            - Clear all memories
  /memory show <id>        - Show memory details

Project Commands:
  /project init            - Initialize project context
  /project edit            - Edit project file
  /project view            - View project file
  /project clear           - Clear project context

Utility Commands:
  /undo [count]            - Undo last file operation(s)

Todo Commands:
  /todo                    - Show current todo list
  /todo add <task>         - Add a new todo
  /todo complete <index>   - Complete a todo by index
  /todo clear              - Clear completed todos
  /todo clear-all          - Clear all todos
`;

    return { handled: true, response: helpText };
  }

  private async handleConfig(args: string[]): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    // Parse subcommands
    const parts = argString.split(/\s+/);
    const subcommand = parts[0];

    // No args or "show" - show interactive config viewer
    if (!argString || subcommand?.toLowerCase() === 'show') {
      const activityStream = this.serviceRegistry.get('activity_stream');

      if (!activityStream || typeof (activityStream as any).emit !== 'function') {
        return {
          handled: true,
          response: 'Configuration viewer not available.',
        };
      }

      // Emit config view request event
      const requestId = `config_view_${Date.now()}`;

      (activityStream as any).emit({
        id: requestId,
        type: ActivityEventType.CONFIG_VIEW_REQUEST,
        timestamp: Date.now(),
        data: {
          requestId,
        },
      });

      return { handled: true }; // Handled via UI
    }

    if (!subcommand) {
      return { handled: true, response: 'Invalid config command' };
    }

    if (subcommand.toLowerCase() === 'reset') {
      return this.handleConfigReset();
    }

    if (subcommand.toLowerCase() === 'set') {
      // /config set key=value
      const kvString = parts.slice(1).join(' ');
      return this.handleConfigSet(kvString);
    }

    return {
      handled: true,
      response: 'Invalid format. Use /config, /config set key=value, or /config reset',
    };
  }

  private async handleConfigSet(kvString: string): Promise<CommandResult> {
    const parts = kvString.split('=', 2);

    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return {
        handled: true,
        response: 'Invalid format. Use /config set key=value',
      };
    }

    const key = parts[0].trim();
    const valueString = parts[1].trim();

    // Check if key exists
    if (!this.configManager.hasKey(key)) {
      return {
        handled: true,
        response: `Unknown configuration key: ${key}. Use /config show to see all options.`,
      };
    }

    try {
      // Parse value based on type
      let value: any = valueString;

      // Try to parse as JSON first (handles booleans, numbers, etc.)
      try {
        value = JSON.parse(valueString);
      } catch {
        // Keep as string if not valid JSON
        value = valueString;
      }

      await this.configManager.setValue(key as any, value);

      return {
        handled: true,
        response: `Configuration updated: ${key}=${JSON.stringify(value)}`,
      };
    } catch (error) {
      return {
        handled: true,
        response: `Error updating configuration: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async handleConfigReset(): Promise<CommandResult> {
    try {
      const changes = await this.configManager.reset();
      const changedKeys = Object.keys(changes);

      if (changedKeys.length === 0) {
        return {
          handled: true,
          response: 'Configuration is already at default values.',
        };
      }

      return {
        handled: true,
        response: `Configuration reset to defaults. ${changedKeys.length} settings changed.`,
      };
    } catch (error) {
      return {
        handled: true,
        response: `Error resetting configuration: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
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

  private async handleModel(args: string[]): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    // Direct model name provided - set it immediately
    if (argString) {
      const modelName = argString;

      try {
        await this.configManager.setValue('model', modelName);

        // Update the active ModelClient to use the new model immediately
        const modelClient = this.serviceRegistry.get<any>('model_client');
        if (modelClient && typeof modelClient.setModelName === 'function') {
          modelClient.setModelName(modelName);
        }

        return {
          handled: true,
          response: `Model changed to: ${modelName}`,
        };
      } catch (error) {
        return {
          handled: true,
          response: `Error changing model: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // No args - show interactive selector
    try {
      const currentModel = this.configManager.getValue('model');
      const config = this.configManager.getConfig();
      const endpoint = config.endpoint || 'http://localhost:11434';

      // Fetch available models from Ollama
      const response = await fetch(`${endpoint}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          handled: true,
          response: `Failed to fetch models from Ollama (HTTP ${response.status}). Try /model <name> to set directly.`,
        };
      }

      const data = (await response.json()) as { models?: Array<{ name: string; size?: number; modified_at?: string }> };
      const models = (data.models || []).map(m => ({
        name: m.name,
        size: m.size ? this.formatSize(m.size) : undefined,
        modified: m.modified_at,
      }));

      if (models.length === 0) {
        return {
          handled: true,
          response: 'No models available in Ollama. Install models with: ollama pull <model>',
        };
      }

      // Emit interactive selection request
      const activityStream = this.serviceRegistry.get('activity_stream');
      if (activityStream && typeof (activityStream as any).emit === 'function') {
        const requestId = `model_select_${Date.now()}`;

        (activityStream as any).emit({
          id: requestId,
          type: 'model_select_request',
          timestamp: Date.now(),
          data: {
            requestId,
            models,
            currentModel,
          },
        });

        return { handled: true }; // Selection handled via UI
      }

      // Fallback: show list
      let output = `Current model: ${currentModel || 'not set'}\n\nAvailable models:\n`;
      models.forEach(m => {
        output += `  - ${m.name}${m.size ? ` (${m.size})` : ''}\n`;
      });
      output += '\nUse /model <name> to switch.';

      return { handled: true, response: output };
    } catch (error) {
      return {
        handled: true,
        response: `Error fetching models: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
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
      default:
        return {
          handled: true,
          response: `Unknown debug subcommand: ${subcommand}. Available: system, tokens, context`,
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
      const contextSize = config.context_size || 128000;
      const tokenManager = new TokenManager(contextSize);

      // Calculate token statistics
      const totalTokens = tokenManager.estimateMessagesTokens(messages);
      const percentUsed = ((totalTokens / contextSize) * 100).toFixed(1);

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
        output += `Max Tokens:          ${config.max_tokens || 2048}\n`;
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
        content: msg.content ? (msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content) : undefined,
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

    // Check if we have enough messages to compact
    if (messages.length < 3) {
      return {
        handled: true,
        response: `Not enough messages to compact (only ${messages.length} messages). Need at least 3 messages.`,
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

      // Emit compaction start event (same as auto-compaction)
      (activityStream as any).emit({
        id: this.generateRandomId(),
        type: ActivityEventType.AUTO_COMPACTION_START,
        timestamp: Date.now(),
        data: {},
      });

      // Get context usage before compaction
      const registry = ServiceRegistry.getInstance();
      const tokenManager = registry.get('token_manager');
      const oldContextUsage = tokenManager && typeof (tokenManager as any).getContextUsagePercentage === 'function'
        ? (tokenManager as any).getContextUsagePercentage()
        : 0;

      // Perform compaction
      const compactedMessages = await this.compactConversation(
        messages,
        customInstructions
      );

      // Update agent's internal messages
      this.agent.updateMessagesAfterCompaction(compactedMessages);

      // Update token count
      if (tokenManager && typeof (tokenManager as any).updateTokenCount === 'function') {
        (tokenManager as any).updateTokenCount(compactedMessages);
      }

      const newContextUsage = tokenManager && typeof (tokenManager as any).getContextUsagePercentage === 'function'
        ? (tokenManager as any).getContextUsagePercentage()
        : 0;

      // Emit compaction complete event (same as auto-compaction)
      (activityStream as any).emit({
        id: this.generateRandomId(),
        type: ActivityEventType.AUTO_COMPACTION_COMPLETE,
        timestamp: Date.now(),
        data: {
          oldContextUsage,
          newContextUsage,
          threshold: 95, // Manual compaction doesn't have a threshold, use default
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

  /**
   * Compact the conversation by generating a summary
   *
   * Based on Python implementation in command_handler.py:708-862
   */
  private async compactConversation(
    messages: Message[],
    customInstructions?: string
  ): Promise<Message[]> {
    // Extract system message and other messages
    const { systemMessage, otherMessages } = this.extractSystemMessage(messages);

    // If we have fewer than 2 messages to summarize, nothing to compact
    if (otherMessages.length < 2) {
      return messages;
    }

    // Start building compacted message list
    const compacted: Message[] = [];
    if (systemMessage) {
      compacted.push(systemMessage);
    }

    // Create summarization request
    const summarizationRequest: Message[] = [];

    // Add system message for summarization
    summarizationRequest.push({
      role: 'system',
      content:
        'You are an AI assistant helping to summarize a conversation while preserving critical context for ongoing work. ' +
        'Focus heavily on:\n' +
        '• UNRESOLVED ISSUES: Any bugs, errors, or problems currently being investigated or fixed\n' +
        '• DEBUGGING CONTEXT: Error messages, stack traces, failed attempts, and partial solutions\n' +
        '• CURRENT INVESTIGATION: What is being analyzed, hypotheses being tested, next steps planned\n' +
        '• TECHNICAL STATE: File paths, function names, variable values, configuration details relevant to ongoing work\n' +
        '• ATTEMPTED SOLUTIONS: What has been tried and why it didn\'t work\n' +
        '• BREAKTHROUGH FINDINGS: Recent discoveries or insights that advance the investigation\n\n' +
        'Be extremely detailed about ongoing problems but brief about completed/resolved topics. ' +
        'Use bullet points and preserve specific technical details (file paths, error messages, code snippets).',
    });

    // Add messages to be summarized
    summarizationRequest.push(...otherMessages);

    // Add final user request
    const baseRequest =
      'Summarize this conversation with special attention to any ongoing debugging, ' +
      'problem-solving, or issue resolution. Prioritize unresolved problems, current ' +
      'investigations, and technical context needed to continue work seamlessly. ' +
      'Include specific error messages, file paths, and attempted solutions.';

    const finalRequest = customInstructions
      ? `${baseRequest} Additional instructions: ${customInstructions}`
      : baseRequest;

    summarizationRequest.push({
      role: 'user',
      content: finalRequest,
    });

    // Get model client and generate summary
    if (!this.agent) {
      throw new Error('Agent not available');
    }

    const modelClient = this.agent.getModelClient();
    const response = await modelClient.send(summarizationRequest, {
      stream: false,
    });

    const summary = response.content.trim();

    // Add summary as system message if we got one
    if (summary && summary !== 'Conversation history has been compacted to save context space.') {
      compacted.push({
        role: 'system',
        content: `CONVERSATION SUMMARY: ${summary}`,
      });
    }

    return compacted;
  }

  /**
   * Extract system message from message list
   *
   * Based on Python implementation in command_handler.py:864-874
   */
  private extractSystemMessage(messages: Message[]): {
    systemMessage: Message | null;
    otherMessages: Message[];
  } {
    if (messages.length === 0) {
      return { systemMessage: null, otherMessages: [] };
    }

    // Check if first message is a system message
    if (messages[0]?.role === 'system') {
      return {
        systemMessage: messages[0],
        otherMessages: messages.slice(1),
      };
    }

    return {
      systemMessage: null,
      otherMessages: messages,
    };
  }

  private async handleExit(): Promise<CommandResult> {
    process.exit(0);
  }

  // ===========================
  // Agent Commands
  // ===========================

  private async handleAgent(args: string[], _messages: Message[]): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    if (!argString) {
      return {
        handled: true,
        response: `Agent Commands:
  /agent create <description> - Create new specialized agent
  /agent ls                   - List available agents
  /agent show <name>          - Show agent details
  /agent use <name> <task>    - Use specific agent
  /agent delete <name>        - Delete agent
`,
      };
    }

    const parts = argString.split(/\s+/);
    const subcommand = parts[0];
    if (!subcommand) {
      return { handled: true, response: 'Invalid agent command' };
    }

    switch (subcommand.toLowerCase()) {
      case 'create':
        return this.handleAgentCreate(parts.slice(1).join(' '));
      case 'ls':
      case 'list':
        return this.handleAgentList();
      case 'show':
        return this.handleAgentShow(parts.slice(1).join(' '));
      case 'use':
        return this.handleAgentUse(parts.slice(1).join(' '));
      case 'delete':
      case 'rm':
        return this.handleAgentDelete(parts.slice(1).join(' '));
      default:
        return {
          handled: true,
          response: `Unknown agent subcommand: ${subcommand}`,
        };
    }
  }

  private async handleAgentCreate(_description: string): Promise<CommandResult> {
    if (!_description) {
      return {
        handled: true,
        response: 'Description required. Usage: /agent create <description>',
      };
    }

    // TODO: Implement agent creation (requires LLM integration)
    return {
      handled: true,
      response: 'Agent creation not yet implemented',
    };
  }

  private async handleAgentList(): Promise<CommandResult> {
    const agentManager = this.serviceRegistry.get('agentManager') as AgentManager;
    const agents = await agentManager.listAgents();

    if (agents.length === 0) {
      return {
        handled: true,
        response: 'No agents available. Use /agent create to create one.',
      };
    }

    let output = 'Available Agents:\n\n';

    for (const agent of agents) {
      output += `  - ${agent.name}: ${agent.description}\n`;
    }

    return { handled: true, response: output };
  }

  private async handleAgentShow(name: string): Promise<CommandResult> {
    if (!name) {
      return {
        handled: true,
        response: 'Agent name required. Usage: /agent show <name>',
      };
    }

    const agentManager = this.serviceRegistry.get('agentManager') as AgentManager;
    const agent = await agentManager.loadAgent(name);

    if (!agent) {
      return {
        handled: true,
        response: `Agent '${name}' not found.`,
      };
    }

    let output = `Agent: ${agent.name}\n\n`;
    output += `Description: ${agent.description}\n`;
    output += `Created: ${agent.created_at || 'Unknown'}\n\n`;
    output += `System Prompt:\n${agent.system_prompt}\n`;

    return { handled: true, response: output };
  }

  private async handleAgentUse(_args: string): Promise<CommandResult> {
    // TODO: Implement agent delegation
    return {
      handled: true,
      response: 'Agent delegation not yet implemented',
    };
  }

  private async handleAgentDelete(name: string): Promise<CommandResult> {
    if (!name) {
      return {
        handled: true,
        response: 'Agent name required. Usage: /agent delete <name>',
      };
    }

    const agentManager = this.serviceRegistry.get('agentManager') as AgentManager;
    const deleted = await agentManager.deleteAgent(name);

    if (deleted) {
      return {
        handled: true,
        response: `Agent '${name}' deleted successfully.`,
      };
    } else {
      return {
        handled: true,
        response: `Failed to delete agent '${name}'. It may not exist or cannot be deleted.`,
      };
    }
  }

  // ===========================
  // Focus Commands
  // ===========================

  private async handleFocus(args: string[]): Promise<CommandResult> {
    const path = args.join(' ').trim();

    if (!path) {
      const focusManager = this.serviceRegistry.get('focusManager') as FocusManager;
      const focused = focusManager.isFocused();

      if (focused) {
        const display = focusManager.getFocusDisplay();
        return {
          handled: true,
          response: `Currently focused on: ${display}\n\nUsage:\n  /focus <path>  - Set focus\n  /defocus       - Clear focus`,
        };
      } else {
        return {
          handled: true,
          response: 'No focus is currently set.\n\nUsage: /focus <path>',
        };
      }
    }

    const focusManager = this.serviceRegistry.get('focusManager') as FocusManager;
    const result = await focusManager.setFocus(path);

    return {
      handled: true,
      response: result.message,
    };
  }

  private async handleDefocus(): Promise<CommandResult> {
    const focusManager = this.serviceRegistry.get('focusManager') as FocusManager;
    const result = focusManager.clearFocus();

    return {
      handled: true,
      response: result.message,
    };
  }

  private async handleFocusShow(): Promise<CommandResult> {
    const focusManager = this.serviceRegistry.get('focusManager') as FocusManager;
    const display = focusManager.getFocusDisplay();

    if (display) {
      return {
        handled: true,
        response: `Current focus: ${display}`,
      };
    } else {
      return {
        handled: true,
        response: 'No focus is currently set.',
      };
    }
  }

  // ===========================
  // Memory Commands
  // ===========================

  private async handleMemory(args: string[], _messages: Message[]): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    if (!argString) {
      return {
        handled: true,
        response: `Memory Commands:
  /memory add <fact>    - Add a memory fact
  /memory ls            - List all memories
  /memory rm <id>       - Remove memory by ID
  /memory clear         - Clear all memories
  /memory show <id>     - Show memory details
`,
      };
    }

    const parts = argString.split(/\s+/);
    const subcommand = parts[0];
    if (!subcommand) {
      return { handled: true, response: 'Invalid memory command' };
    }

    const memoryManager = this.serviceRegistry.get('memoryManager') as MemoryManager;

    switch (subcommand.toLowerCase()) {
      case 'add':
        return this.handleMemoryAdd(memoryManager, parts.slice(1).join(' '));
      case 'ls':
      case 'list':
        return this.handleMemoryList(memoryManager);
      case 'rm':
      case 'remove':
        return this.handleMemoryRemove(memoryManager, parts.length > 1 ? parts[1] : undefined);
      case 'clear':
        return this.handleMemoryClear(memoryManager);
      case 'show':
        return this.handleMemoryShow(memoryManager, parts.length > 1 ? parts[1] : undefined);
      default:
        return {
          handled: true,
          response: `Unknown memory subcommand: ${subcommand}`,
        };
    }
  }

  private async handleMemoryAdd(
    memoryManager: MemoryManager,
    content: string
  ): Promise<CommandResult> {
    if (!content) {
      return {
        handled: true,
        response: 'Content required. Usage: /memory add <fact>',
      };
    }

    const memory = await memoryManager.addMemory(content);

    return {
      handled: true,
      response: `Memory added: ${memory.id}`,
    };
  }

  private async handleMemoryList(memoryManager: MemoryManager): Promise<CommandResult> {
    const memories = await memoryManager.listMemories();

    if (memories.length === 0) {
      return {
        handled: true,
        response: 'No memories found. Use /memory add to create one.',
      };
    }

    let output = 'Memories:\n\n';

    for (const memory of memories) {
      const date = new Date(memory.created).toLocaleDateString();
      output += `  [${memory.id}] ${memory.content} (${date})\n`;
    }

    return { handled: true, response: output };
  }

  private async handleMemoryRemove(
    memoryManager: MemoryManager,
    id: string | undefined
  ): Promise<CommandResult> {
    if (!id) {
      return {
        handled: true,
        response: 'Memory ID required. Usage: /memory rm <id>',
      };
    }

    const removed = await memoryManager.removeMemory(id);

    if (removed) {
      return {
        handled: true,
        response: `Memory ${id} removed.`,
      };
    } else {
      return {
        handled: true,
        response: `Memory ${id} not found.`,
      };
    }
  }

  private async handleMemoryClear(memoryManager: MemoryManager): Promise<CommandResult> {
    await memoryManager.clearMemories();

    return {
      handled: true,
      response: 'All memories cleared.',
    };
  }

  private async handleMemoryShow(
    memoryManager: MemoryManager,
    id: string | undefined
  ): Promise<CommandResult> {
    if (!id) {
      return {
        handled: true,
        response: 'Memory ID required. Usage: /memory show <id>',
      };
    }

    const memory = await memoryManager.getMemory(id);

    if (!memory) {
      return {
        handled: true,
        response: `Memory ${id} not found.`,
      };
    }

    const date = new Date(memory.created).toLocaleString();
    let output = `Memory: ${memory.id}\n\n`;
    output += `Content: ${memory.content}\n`;
    output += `Created: ${date}\n`;

    if (memory.tags && memory.tags.length > 0) {
      output += `Tags: ${memory.tags.join(', ')}\n`;
    }

    return { handled: true, response: output };
  }

  // ===========================
  // Project Commands
  // ===========================

  private async handleProject(
    args: string[],
    _messages: Message[]
  ): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    if (!argString) {
      return {
        handled: true,
        response: `Project Commands:
  /project init    - Initialize project context
  /project edit    - Edit project file
  /project view    - View project file
  /project clear   - Clear project context
`,
      };
    }

    const parts = argString.split(/\s+/);
    const subcommand = parts[0];
    if (!subcommand) {
      return { handled: true, response: 'Invalid project command' };
    }

    const projectManager = this.serviceRegistry.get('projectManager') as ProjectManager;

    switch (subcommand.toLowerCase()) {
      case 'init':
        return this.handleProjectInit(projectManager);
      case 'edit':
        return this.handleProjectEdit(projectManager);
      case 'view':
        return this.handleProjectView(projectManager);
      case 'clear':
        return this.handleProjectClear(projectManager);
      default:
        return {
          handled: true,
          response: `Unknown project subcommand: ${subcommand}`,
        };
    }
  }

  private async handleProjectInit(_projectManager: ProjectManager): Promise<CommandResult> {
    const activityStream = this.serviceRegistry.get('activity_stream');

    if (!activityStream || typeof (activityStream as any).emit !== 'function') {
      return {
        handled: true,
        response: 'Project wizard not available.',
      };
    }

    // Emit project wizard request event
    const requestId = `project_wizard_${Date.now()}`;

    (activityStream as any).emit({
      id: requestId,
      type: ActivityEventType.PROJECT_WIZARD_REQUEST,
      timestamp: Date.now(),
      data: {
        requestId,
      },
    });

    return { handled: true }; // Handled via UI
  }

  private async handleProjectEdit(_projectManager: ProjectManager): Promise<CommandResult> {
    // TODO: Implement project file editing
    return {
      handled: true,
      response: 'Project editing not yet implemented',
    };
  }

  private async handleProjectView(projectManager: ProjectManager): Promise<CommandResult> {
    const context = await projectManager.getContext();

    if (!context) {
      return {
        handled: true,
        response: 'No project context found. Use /project init to create one.',
      };
    }

    let output = `Project: ${context.name}\n\n`;
    output += `Description: ${context.description}\n`;
    output += `Files: ${context.files.length}\n`;
    output += `Created: ${new Date(context.created).toLocaleString()}\n`;
    output += `Updated: ${new Date(context.updated).toLocaleString()}\n`;

    return { handled: true, response: output };
  }

  private async handleProjectClear(projectManager: ProjectManager): Promise<CommandResult> {
    await projectManager.clearContext();

    return {
      handled: true,
      response: 'Project context cleared.',
    };
  }

  // ===========================
  // Utility Commands
  // ===========================

  private async handleUndo(args: string[], _messages: Message[]): Promise<CommandResult> {
    const argString = args.join(' ').trim();
    let count = 1;

    if (argString) {
      const parsed = parseInt(argString, 10);

      if (isNaN(parsed) || parsed <= 0) {
        return {
          handled: true,
          response: 'Invalid count. Usage: /undo [count]',
        };
      }

      count = parsed;
    }

    const undoManager = this.serviceRegistry.get('undoManager') as UndoManager;
    const result = await undoManager.undo(count);

    return {
      handled: true,
      response: result.message,
    };
  }

  // ===========================
  // Todo Commands
  // ===========================

  private async handleTodo(args: string[]): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    if (!argString) {
      return await this.handleTodoShow();
    }

    const parts = argString.split(/\s+/);
    const subcommand = parts[0];
    if (!subcommand) {
      return { handled: true, response: 'Invalid todo command' };
    }

    const todoManager = this.serviceRegistry.get('todo_manager') as TodoManager;

    if (!todoManager) {
      return {
        handled: true,
        response: 'Todo manager not available.',
      };
    }

    switch (subcommand.toLowerCase()) {
      case 'add':
        return this.handleTodoAdd(todoManager, parts.slice(1).join(' '));
      case 'complete':
      case 'done':
        return this.handleTodoComplete(todoManager, parts.length > 1 ? parts[1] : undefined);
      case 'clear':
        return this.handleTodoClear(todoManager, false);
      case 'clear-all':
        return this.handleTodoClear(todoManager, true);
      default:
        return {
          handled: true,
          response: `Unknown todo subcommand: ${subcommand}. Type /help for usage.`,
        };
    }
  }

  private async handleTodoShow(): Promise<CommandResult> {
    const todoManager = this.serviceRegistry.get('todo_manager') as TodoManager;

    if (!todoManager) {
      return {
        handled: true,
        response: 'Todo manager not available.',
      };
    }

    const todos = todoManager.getTodos();

    if (todos.length === 0) {
      return {
        handled: true,
        response: 'No todos. Use /todo add <task> to add one.',
      };
    }

    let output = 'Todo List:\n\n';

    const inProgress = todoManager.getInProgressTodo();
    const pending = todos.filter(t => t.status === 'pending');
    const completed = todoManager.getCompletedTodos();

    // Show in-progress task (highlighted)
    if (inProgress) {
      output += `  → IN PROGRESS: ${inProgress.task}\n\n`;
    }

    // Show pending tasks with indices
    if (pending.length > 0) {
      output += 'Pending:\n';
      pending.forEach((todo, index) => {
        output += `  ${index}. ${todo.task}\n`;
      });
      output += '\n';
    }

    // Show completed tasks
    if (completed.length > 0) {
      output += 'Completed:\n';
      completed.forEach(todo => {
        output += `  ✓ ${todo.task}\n`;
      });
    }

    return { handled: true, response: output };
  }

  private async handleTodoAdd(
    todoManager: TodoManager,
    task: string
  ): Promise<CommandResult> {
    if (!task || task.trim() === '') {
      return {
        handled: true,
        response: 'Task description required. Usage: /todo add <task>',
      };
    }

    const newTodo = todoManager.createTodoItem(task.trim(), 'pending');
    const todos = todoManager.getTodos();
    todos.push(newTodo);
    todoManager.setTodos(todos);

    return {
      handled: true,
      response: `Todo added: ${task.trim()}`,
    };
  }

  private async handleTodoComplete(
    todoManager: TodoManager,
    indexStr: string | undefined
  ): Promise<CommandResult> {
    if (!indexStr) {
      return {
        handled: true,
        response: 'Index required. Usage: /todo complete <index>',
      };
    }

    const index = parseInt(indexStr, 10);

    if (isNaN(index) || index < 0) {
      return {
        handled: true,
        response: 'Invalid index. Use /todo to see indices.',
      };
    }

    const completedTodo = todoManager.completeTodoByIndex(index);

    if (!completedTodo) {
      return {
        handled: true,
        response: `No pending todo at index ${index}. Use /todo to see current list.`,
      };
    }

    return {
      handled: true,
      response: `Completed: ${completedTodo.task}`,
    };
  }

  private async handleTodoClear(
    todoManager: TodoManager,
    clearAll: boolean
  ): Promise<CommandResult> {
    const cleared = todoManager.clearTodos(clearAll);

    if (cleared === 0) {
      return {
        handled: true,
        response: clearAll ? 'No todos to clear.' : 'No completed todos to clear.',
      };
    }

    return {
      handled: true,
      response: `Cleared ${cleared} ${clearAll ? 'todo(s)' : 'completed todo(s)'}.`,
    };
  }
}
