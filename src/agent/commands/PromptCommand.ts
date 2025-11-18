/**
 * PromptCommand - Manage saved prompts
 *
 * Provides full CRUD operations for saved prompts, plus interactive selection.
 * Also supports interactive selection and direct insertion by ID.
 *
 * Usage:
 *   /prompt              - Browse prompts interactively
 *   /prompt <id>         - Insert prompt by ID
 *   /prompt add          - Add new prompt (select from messages or create new)
 *   /prompt edit <id>    - Edit an existing prompt
 *   /prompt delete <id>  - Delete prompt by ID
 *   /prompt list         - List all prompts
 *   /prompt clear        - Clear all saved prompts
 *
 * Autocomplete:
 *   - Searches by title, content, and tags
 *   - Shows match indicator (content match, tag match) when relevant
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import { ActivityEventType } from '@shared/index.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { PromptLibraryManager } from '@services/PromptLibraryManager.js';
import type { Agent } from '../Agent.js';

export class PromptCommand extends Command {
  readonly name = '/prompt';
  readonly description = 'Manage saved prompts';

  // Subcommands that should be routed to handlers
  private readonly SUBCOMMANDS = ['add', 'edit', 'delete', 'list', 'clear'];

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    // No args → show interactive selector
    if (!argString) {
      return this.handleInteractiveSelect(serviceRegistry);
    }

    // Parse first argument
    const parts = argString.split(/\s+/);
    const firstArg = parts[0]?.toLowerCase() || '';

    // Check if it's a subcommand
    if (this.SUBCOMMANDS.includes(firstArg)) {
      // Get PromptLibraryManager
      const promptLibraryManager = serviceRegistry.get<PromptLibraryManager>('prompt_library_manager');

      if (!promptLibraryManager) {
        return this.createError('Prompt library manager not available.');
      }

      // Route to subcommand handler
      switch (firstArg) {
        case 'add':
          return this.handleAdd(serviceRegistry);

        case 'edit':
          return this.handleEdit(promptLibraryManager, parts.slice(1));

        case 'delete':
          return this.handleDelete(promptLibraryManager, parts.slice(1));

        case 'list':
          return this.handleList(promptLibraryManager);

        case 'clear':
          return this.handleClear(promptLibraryManager);

        default:
          return this.createError(`Unknown subcommand: ${firstArg}`);
      }
    }

    // Not a subcommand - treat as prompt ID for direct insertion
    return this.handleDirectInsert(serviceRegistry, firstArg);
  }

  /**
   * Show interactive prompt library selector
   */
  private async handleInteractiveSelect(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    return this.emitActivityEvent(
      serviceRegistry,
      ActivityEventType.LIBRARY_SELECT_REQUEST,
      {},
      'library_select'
    );
  }

  /**
   * Directly insert a prompt by ID
   */
  private async handleDirectInsert(
    serviceRegistry: ServiceRegistry,
    promptId: string
  ): Promise<CommandResult> {
    return this.emitActivityEvent(
      serviceRegistry,
      ActivityEventType.LIBRARY_SELECT_RESPONSE,
      {
        requestId: `library_select_${Date.now()}`,
        promptId: promptId,
        cancelled: false,
      },
      'library_select_response'
    );
  }

  /**
   * Add a new prompt via interactive wizard (with optional message selection)
   */
  private async handleAdd(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    // Get agent to access conversation messages
    const agent = serviceRegistry.get<Agent>('agent');

    if (!agent) {
      // Agent not available - go straight to wizard
      return this.emitActivityEvent(
        serviceRegistry,
        ActivityEventType.PROMPT_ADD_REQUEST,
        {
          requestId: `prompt_add_${Date.now()}`,
          title: '',
          content: '',
          tags: '',
          focusedField: 'title',
        },
        'prompt_add'
      );
    }

    // Get user messages from conversation
    const userMessages = agent.getMessages().filter(m => m.role === 'user');

    if (userMessages.length === 0) {
      // No messages - skip selector, go straight to wizard
      return this.emitActivityEvent(
        serviceRegistry,
        ActivityEventType.PROMPT_ADD_REQUEST,
        {
          requestId: `prompt_add_${Date.now()}`,
          title: '',
          content: '',
          tags: '',
          focusedField: 'title',
        },
        'prompt_add'
      );
    }

    // Show message selector first
    return this.emitActivityEvent(
      serviceRegistry,
      ActivityEventType.PROMPT_MESSAGE_SELECT_REQUEST,
      {
        requestId: `message_select_${Date.now()}`,
        messages: userMessages,
        selectedIndex: userMessages.length - 1, // Start at most recent message
      },
      'message_select'
    );
  }

  /**
   * Edit an existing prompt by ID
   */
  private async handleEdit(
    promptLibraryManager: PromptLibraryManager,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length === 0 || !args[0]) {
      return this.createError('Prompt ID required. Usage: /prompt edit <id>');
    }

    const promptId = args[0];

    try {
      // Get the existing prompt
      const prompt = await promptLibraryManager.getPrompt(promptId);

      if (!prompt) {
        return this.createError(`Prompt not found: ${promptId}`);
      }

      // Show wizard with pre-filled data from existing prompt
      const serviceRegistry = ServiceRegistry.getInstance();
      return this.emitActivityEvent(
        serviceRegistry,
        ActivityEventType.PROMPT_ADD_REQUEST,
        {
          requestId: `prompt_edit_${Date.now()}`,
          promptId: prompt.id, // Include ID to indicate this is an edit
          title: prompt.title,
          content: prompt.content,
          tags: prompt.tags ? prompt.tags.join(', ') : '',
          focusedField: 'title',
        },
        'prompt_edit'
      );
    } catch (error) {
      return this.createError(`Failed to load prompt: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Delete a prompt by ID
   */
  private async handleDelete(
    promptLibraryManager: PromptLibraryManager,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length === 0 || !args[0]) {
      return this.createError('Prompt ID required. Usage: /prompt delete <id>');
    }

    const promptId = args[0];

    try {
      // Check if prompt exists before deleting
      const prompts = await promptLibraryManager.getPrompts();
      const prompt = prompts.find(p => p.id === promptId);

      if (!prompt) {
        return this.createError(`Prompt not found: ${promptId}`);
      }

      await promptLibraryManager.deletePrompt(promptId);

      return this.createResponse(`Deleted prompt: ${prompt.title}`);
    } catch (error) {
      return this.createError(`Failed to delete prompt: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * List all prompts
   */
  private async handleList(promptLibraryManager: PromptLibraryManager): Promise<CommandResult> {
    try {
      const prompts = await promptLibraryManager.getPrompts();

      if (prompts.length === 0) {
        return {
          handled: true,
          response: 'No saved prompts. Use /prompt add to create one.',
        };
      }

      let output = 'Saved Prompts:\n\n';

      prompts.forEach(prompt => {
        const date = new Date(prompt.createdAt).toLocaleDateString();
        const tags = prompt.tags && prompt.tags.length > 0 ? ` [${prompt.tags.join(', ')}]` : '';
        const preview = prompt.content.length > 60
          ? prompt.content.substring(0, 60) + '...'
          : prompt.content;

        output += `  ${prompt.id}\n`;
        output += `    ${prompt.title}${tags}\n`;
        output += `    ${preview}\n`;
        output += `    Created: ${date}\n\n`;
      });

      return {
        handled: true,
        response: output,
      };
    } catch (error) {
      return this.createError(`Failed to list prompts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Clear all prompts from the library (with confirmation)
   */
  private async handleClear(promptLibraryManager: PromptLibraryManager): Promise<CommandResult> {
    try {
      const prompts = await promptLibraryManager.getPrompts();

      if (prompts.length === 0) {
        return this.createResponse('No prompts to clear.');
      }

      // Show confirmation dialog
      const serviceRegistry = ServiceRegistry.getInstance();
      return this.emitActivityEvent(
        serviceRegistry,
        ActivityEventType.LIBRARY_CLEAR_CONFIRM_REQUEST,
        {
          requestId: `library_clear_${Date.now()}`,
          promptCount: prompts.length,
          selectedIndex: 1, // Default to Cancel (safer option)
        },
        'library_clear_confirm'
      );
    } catch (error) {
      return this.createError(`Failed to clear prompts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
