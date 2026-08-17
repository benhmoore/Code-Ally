/**
 * useInputHandlers - Handle user input, interjections, and bash shortcuts
 *
 * This hook consolidates all input handling logic including:
 * - Regular user messages
 * - Slash commands
 * - Bash shortcuts (! prefix)
 * - Memory shortcuts (# prefix) - saves to the project instructions file
 * - File/directory mentions (@ prefix) - attached as context before the message
 * - User interjections (mid-response messages)
 *
 * The hook parses input and routes it; it owns no orchestration of its own.
 * The `!` and `#` shortcuts are executed by UserShortcutService, and `@file` /
 * `@dir` mentions by MentionAttachmentService. Those services own the tool
 * execution, tool-result construction, event emission and history mutation.
 */

import { useCallback } from 'react';
import { CommandHandler } from '@agent/CommandHandler.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { isInjectableTool } from '@tools/InjectableTool.js';
import { AppState, AppActions } from '../contexts/AppContext.js';
import { ActivityEventType } from '@shared/index.js';
import { logger } from '@services/Logger.js';
import { PERMISSION_MESSAGES } from '@config/constants.js';
import { sendTerminalNotification } from '../../utils/terminal.js';
import { fileToBase64, isImageFile } from '@utils/imageUtils.js';
import { resolvePath } from '@utils/pathUtils.js';
import { ModelCapabilitiesIndex } from '@services/ModelCapabilitiesIndex.js';
import { UserShortcutService } from '@services/UserShortcutService.js';
import { MentionAttachmentService } from '@services/MentionAttachmentService.js';

/**
 * Input handler functions
 */
export interface InputHandlers {
  /** Handle regular user input (messages, commands, bash shortcuts) */
  handleInput: (input: string, mentions?: { files?: string[]; images?: string[]; directories?: string[] }) => Promise<void>;
  /** Handle user interjection (submitting message mid-response) */
  handleInterjection: (message: string) => Promise<void>;
}

/**
 * Create input handler functions
 *
 * @param commandHandler - The command handler instance
 * @param activityStream - ActivityStream to emit events
 * @param state - App context state
 * @param actions - App context actions
 * @returns Input handler functions
 *
 * @example
 * ```tsx
 * const { handleInput, handleInterjection } = useInputHandlers(
 *   commandHandler,
 *   activityStream,
 *   state,
 *   actions
 * );
 *
 * <InputPrompt
 *   onSubmit={handleInput}
 *   onInterjection={handleInterjection}
 * />
 * ```
 */
export const useInputHandlers = (
  commandHandler: CommandHandler | null,
  activityStream: ActivityStream,
  state: AppState,
  actions: AppActions
): InputHandlers => {
  /**
   * Handle user interjection (submitting message mid-response)
   */
  const handleInterjection = useCallback(async (message: string) => {
    // Get current agent from ServiceRegistry (supports agent switching)
    const serviceRegistry = ServiceRegistry.getInstance();
    const agent = serviceRegistry.get('agent');

    if (!agent) {
      logger.error('[INTERJECTION] No agent available to handle interjection');
      actions.addMessage({
        role: 'assistant',
        content: 'Error: Agent not available. Please try again or restart the application.',
        metadata: { isError: true },
      });
      return;
    }

    logger.debug('[APP] Handling interjection:', message);

    // Get ToolManager from ServiceRegistry
    const toolManager = serviceRegistry.get('tool_manager');

    // Find currently active injectable tool (explore, plan, agent)
    const activeTool = toolManager?.getActiveInjectableTool();

    let routedToTool = false;
    let targetToolName = 'main';
    let parentId = 'root';

    if (activeTool) {
      // Route to active tool
      logger.debug('[APP] Routing interjection to active tool:', activeTool.name);

      try {
        // Type-safe check for injectable tool
        if (isInjectableTool(activeTool.tool)) {
          activeTool.tool.injectUserMessage(message);
          routedToTool = true;
          targetToolName = activeTool.name;
          parentId = activeTool.callId; // Use tool call ID for nesting

          logger.debug('[APP] Successfully routed to tool:', activeTool.name, 'callId:', activeTool.callId);
        } else {
          logger.debug('[APP] Active tool does not support message injection:', activeTool.name);
          routedToTool = false;
        }
      } catch (error) {
        logger.error('[APP] Failed to inject into tool:', error);
        routedToTool = false;
      }
    }

    // Fallback to main agent if no active tool or routing failed
    if (!routedToTool) {
      logger.debug('[APP] Routing interjection to main agent');
      agent.addUserInterjection(message);
      agent.interrupt({ kind: 'user_interjection' });
    }

    // Add user message to UI conversation with parentId for reconstruction
    actions.addMessage({
      role: 'user',
      content: message,
      timestamp: Date.now(),
      metadata: {
        isInterjection: true,
        parentId: parentId,
      },
    });

    // Emit event for UI
    activityStream.emit({
      id: `interjection-${Date.now()}`,
      type: ActivityEventType.USER_INTERJECTION,
      timestamp: Date.now(),
      parentId: parentId,
      data: {
        message,
        targetAgent: targetToolName,
      },
    });
  }, [activityStream, actions]);

  /**
   * Handle user input (messages, commands, bash shortcuts)
   */
  const handleInput = useCallback(async (input: string, mentions?: { files?: string[]; images?: string[]; directories?: string[] }) => {
    // Get current agent from ServiceRegistry (supports agent switching)
    const serviceRegistry = ServiceRegistry.getInstance();
    const agent = serviceRegistry.get('agent');

    if (!agent) {
      logger.error('[INPUT_HANDLER] No agent available to handle input');
      actions.addMessage({
        role: 'assistant',
        content: 'Error: Agent not available. Please try again or restart the application.',
        metadata: { isError: true },
      });
      return;
    }

    logger.debug('[INPUT_HANDLER]', 'Handling input with agent:', agent.getInstanceId());

    const trimmed = input.trim();

    // Built per submission: the registry's tool manager and todo manager are
    // swapped when the user enters a background agent's view.
    const createMentionService = () =>
      new MentionAttachmentService(
        serviceRegistry.get('tool_manager'),
        activityStream,
        serviceRegistry.get('todo_manager') ?? null
      );

    // Check for bash shortcuts (! prefix)
    if (trimmed.startsWith('!')) {
      const bashCommand = trimmed.slice(1).trim();

      if (bashCommand) {
        const shortcutService = new UserShortcutService(
          serviceRegistry.get('tool_manager'),
          activityStream
        );
        await shortcutService.runBashShortcut(bashCommand, agent, actions.addMessage);
        return;
      }
    }

    // Check for memory shortcuts (# prefix) - saves to the project instructions file
    if (trimmed.startsWith('#')) {
      const memoryContent = trimmed.slice(1).trim();

      if (memoryContent) {
        const shortcutService = new UserShortcutService(
          serviceRegistry.get('tool_manager'),
          activityStream
        );
        shortcutService.saveMemoryShortcut(memoryContent, trimmed, actions.addMessage);
        return;
      }
    }

    // Check for slash commands
    if (trimmed.startsWith('/') && commandHandler) {
      try {
        const result = await commandHandler.handleCommand(trimmed, state.messages);

        if (result.handled) {
          // Add user message
          actions.addMessage({
            role: 'user',
            content: trimmed,
          });

          // Add command response if provided
          if (result.response) {
            actions.addMessage({
              role: 'assistant',
              content: result.response,
              metadata: result.metadata, // Pass command metadata for styling
            });
          }

          // Add any updated messages (e.g., system reminders) to both UI and Agent
          if (result.updatedMessages) {
            result.updatedMessages.forEach(msg => {
              actions.addMessage(msg);  // UI display
              agent.addMessage(msg);    // Agent context for LLM
            });
          }

          return;
        }
      } catch (error) {
        // Add error message for failed command
        actions.addMessage({
          role: 'assistant',
          content: `Command error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
        return;
      }
    }

    // Add user message
    if (trimmed) {
      // Filter mentions to only include files/images/directories still present in the input text
      // This handles cases where user completed a path but then deleted it
      const filteredMentions = {
        ...(mentions?.files && { files: mentions.files.filter(filePath => trimmed.includes(filePath)) }),
        ...(mentions?.images && { images: mentions.images.filter(imagePath => trimmed.includes(imagePath)) }),
        ...(mentions?.directories && { directories: mentions.directories.filter(dirPath => trimmed.includes(dirPath)) }),
      };

      // Check if current model supports images
      let modelSupportsImages = true; // Default to true if we can't determine
      try {
        const configManager = serviceRegistry.get('config_manager');
        if (configManager) {
          const config = configManager.getConfig();
          const endpoint = config.endpoint || 'http://localhost:11434';
          const modelName = config.model;
          if (modelName) {
            const capabilitiesIndex = ModelCapabilitiesIndex.getInstance();
            await capabilitiesIndex.load();
            const capabilities = capabilitiesIndex.getCapabilities(modelName, endpoint);
            if (capabilities) {
              modelSupportsImages = capabilities.supportsImages;
            }
          }
        }
      } catch (error) {
        logger.debug('[INPUT] Failed to check model image support, assuming supported:', error);
      }

      // If model doesn't support images, treat image paths as regular files
      if (!modelSupportsImages && filteredMentions?.images && filteredMentions.images.length > 0) {
        // Move images to files array so they're treated as regular file paths
        filteredMentions.files = [...(filteredMentions.files || []), ...filteredMentions.images];
        filteredMentions.images = [];
        logger.debug('[INPUT] Model does not support images, treating image paths as files');
      }

      // Process images if present and model supports them
      let base64Images: string[] | undefined;
      if (filteredMentions?.images && filteredMentions.images.length > 0) {
        try {
          // Convert all image paths to base64
          base64Images = await Promise.all(
            filteredMentions.images.map(async (imagePath) => {
              const resolvedPath = resolvePath(imagePath);
              return await fileToBase64(resolvedPath);
            })
          );
        } catch (error) {
          // If image conversion fails, show error but continue
          actions.addMessage({
            role: 'assistant',
            content: `Error loading image: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
          return;
        }
      }

      // Add user message to UI (separate from Agent's internal message history)
      // This displays the message to the user immediately.
      // While viewing an entered background agent, skip the main conversation:
      // the message goes to that agent (registry 'agent' is swapped) and shows
      // in its transcript via the snapshot refresh, keeping main untouched.
      if (state.activeAgentId === 'main') {
        actions.addMessage({
          role: 'user',
          content: trimmed,
          metadata: filteredMentions && (filteredMentions.files?.length || filteredMentions.images?.length || filteredMentions.directories?.length)
            ? { mentions: filteredMentions }
            : undefined,
          images: base64Images,
        });
      }

      // Handle file mentions - execute read tool before sending user message
      // Filter out image files only if model supports images (they're processed separately above)
      const readableFiles = modelSupportsImages
        ? (filteredMentions?.files?.filter(filePath => !isImageFile(filePath)) || [])
        : (filteredMentions?.files || []);

      if (readableFiles.length > 0) {
        const outcome = await createMentionService().attachFiles(
          readableFiles,
          agent,
          actions.addMessage
        );
        if (outcome === 'aborted') {
          return;
        }
      }

      // Handle directory mentions - execute tree tool before sending user message
      if (filteredMentions?.directories && filteredMentions.directories.length > 0) {
        const outcome = await createMentionService().attachDirectories(
          filteredMentions.directories,
          agent,
          actions.addMessage
        );
        if (outcome === 'aborted') {
          return;
        }
      }

      // Set thinking state
      actions.setIsThinking(true);

      // Cancel any ongoing background LLM tasks (idle messages, title generation)
      // This must be done BEFORE calling agent.sendMessage() to avoid resource competition
      //
      // Retry behavior:
      // - IdleMessageGenerator: Will naturally retry every 60s when idle (StatusIndicator)
      // - SessionTitleGenerator: Will retry when next new session is created (low priority)
      const services = [
        serviceRegistry.get('idle_message_generator'),
        serviceRegistry.get('session_title_generator'),
      ].filter(Boolean);

      for (const service of services) {
        if (typeof (service as any).cancel === 'function') {
          (service as any).cancel();
        }
      }

      // Send to agent for processing
      try {
        logger.debug('[INPUT_HANDLER]', 'Sending message to agent:', agent.getInstanceId());
        const response = await agent.sendMessage(trimmed, undefined, base64Images);
        logger.debug('[INPUT_HANDLER]', 'Received response (length:', response?.length || 0, ')');

        // Check if response is an error message that should be styled in red
        const isError = response === PERMISSION_MESSAGES.USER_FACING_DENIAL ||
                       response === PERMISSION_MESSAGES.USER_FACING_INTERRUPTION ||
                       response.includes('Error communicating with Ollama');

        // Add assistant response for error messages only
        // Normal responses are added via ASSISTANT_MESSAGE_COMPLETE event for proper interleaving
        if (isError) {
          let messageContent: string = response;

          // For interruptions, check if there are file changes and provide helpful guidance
          if (response === PERMISSION_MESSAGES.USER_FACING_INTERRUPTION) {
            const patchManager = serviceRegistry.get('patch_manager');

            if (patchManager) {
              // Get the last user message timestamp
              const messages = agent.getMessages();
              const userMessages = messages.filter(m => m.role === 'user');
              const lastUserMessage = userMessages[userMessages.length - 1];

              if (lastUserMessage?.timestamp) {
                // Check if there are any patches since the last user message
                const patches = await (patchManager as any).getPatchesSinceTimestamp(lastUserMessage.timestamp);

                if (patches && patches.length > 0) {
                  messageContent = 'Interrupted. Tell Ally what to do instead. Use /undo to revert a change or press escape twice to rewind the conversation.';
                }
              }
            }
          }

          actions.addMessage({
            role: 'assistant',
            content: messageContent,
            metadata: { isError: true },
          });
        } else if (response && response.trim().length > 0) {
          // Response exists but was filtered - log for debugging
          logger.debug('[UI_INPUT_HANDLER] Response filtered (not displayed in UI). Length:', response.length, 'Preview:', response.substring(0, 100));
        }

        // Update TokenManager and context usage
        const tokenManager = serviceRegistry.get('token_manager');
        if (tokenManager) {
          // Recalculate from the model's compacted window. The complete
          // transcript is UI history and must not re-inflate context usage.
          const agentMessages = agent.getContextMessages();
          if (typeof (tokenManager as any).updateTokenCount === 'function') {
            (tokenManager as any).updateTokenCount(agentMessages);
          }

          // Update context usage display
          if (typeof (tokenManager as any).getContextUsagePercentage === 'function') {
            const contextUsage = (tokenManager as any).getContextUsagePercentage();
            actions.setContextUsage(contextUsage);
          }
        }

        // Send terminal bell/badge notification
        sendTerminalNotification();
      } catch (error) {
        // Add error message
        actions.addMessage({
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });

        // Send terminal bell/badge notification
        sendTerminalNotification();
      } finally {
        // Clear thinking state
        actions.setIsThinking(false);
      }
    }
  }, [commandHandler, activityStream, state.messages, state.activeAgentId, actions]);

  return {
    handleInput,
    handleInterjection,
  };
};
