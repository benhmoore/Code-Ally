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
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { AppActions } from '../contexts/AppContext.js';
import { ActivityEventType } from '@shared/index.js';
import { logger } from '@services/Logger.js';
import { PERMISSION_MESSAGES } from '@config/constants.js';
import { sendTerminalNotification } from '../../utils/terminal.js';
import { fileToBase64, isImageFile } from '@utils/imageUtils.js';
import { resolvePath } from '@utils/pathUtils.js';
import { ModelCapabilitiesIndex } from '@services/ModelCapabilitiesIndex.js';
import { UserShortcutService } from '@services/UserShortcutService.js';
import { MentionAttachmentService } from '@services/MentionAttachmentService.js';
import type { ConversationRoute } from '@services/ConversationRoute.js';
import type { Message } from '@shared/index.js';

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
 * @param route - Immutable target conversation and its scoped activity stream
 * @param actions - App context actions
 * @returns Input handler functions
 *
 * @example
 * ```tsx
 * const { handleInput, handleInterjection } = useInputHandlers(
 *   commandHandler,
 *   route,
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
  route: ConversationRoute,
  actions: AppActions
): InputHandlers => {
  const ensureRouteAvailable = useCallback(() => {
    if (route.isAvailable()) return true;
    actions.addMessage({
      role: 'assistant',
      content: 'That delegated conversation has already finished. Return to main and resend your message.',
      metadata: { isError: true },
    });
    return false;
  }, [actions, route]);

  const addDisplayMessage = useCallback((message: Message) => {
    if (route.kind === 'primary') {
      actions.addMessage(message);
      return;
    }
    route.activityStream.emit({
      id: `display-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: ActivityEventType.CONVERSATION_DISPLAY_MESSAGE,
      timestamp: Date.now(),
      data: { message },
    });
  }, [actions, route]);

  /**
   * Handle user interjection (submitting message mid-response)
   */
  const handleInterjection = useCallback(async (message: string) => {
    if (!ensureRouteAvailable()) return;
    const { agent, activityStream } = route;

    logger.debug('[APP] Handling interjection:', message);

    logger.debug('[APP] Routing interjection to selected conversation:', route.id);
    agent.addUserInterjection(message);
    agent.interrupt({ kind: 'user_interjection' });

    const parentId = 'root';
    const targetAgent = route.kind === 'primary' ? 'main' : route.id;

    // Add user message to UI conversation with parentId for reconstruction
    if (route.kind === 'primary') {
      addDisplayMessage({
        role: 'user',
        content: message,
        timestamp: Date.now(),
        metadata: { isInterjection: true, parentId },
      });
    }

    // Emit event for UI
    activityStream.emit({
      id: `interjection-${Date.now()}`,
      type: ActivityEventType.USER_INTERJECTION,
      timestamp: Date.now(),
      parentId: parentId,
      data: {
        message,
        targetAgent,
      },
    });
  }, [addDisplayMessage, ensureRouteAvailable, route]);

  /**
   * Handle user input (messages, commands, bash shortcuts)
   */
  const handleInput = useCallback(async (input: string, mentions?: { files?: string[]; images?: string[]; directories?: string[] }) => {
    if (!ensureRouteAvailable()) return;
    const serviceRegistry = ServiceRegistry.getInstance();
    const { agent, activityStream } = route;
    // Child views are projections of the Agent transcript, so durable user
    // echoes arrive through CONVERSATION_MESSAGE_ADDED. Presentation-only
    // errors and responses still use the route-local display channel.
    const shortcutMessageSink = (message: Message) => {
      if (route.kind === 'child' && message.role === 'user') return;
      addDisplayMessage(message);
    };

    logger.debug('[INPUT_HANDLER]', 'Handling input with agent:', agent.getInstanceId());

    const trimmed = input.trim();

    const createMentionService = () =>
      new MentionAttachmentService(
        agent.getToolManager(),
        activityStream,
        route.kind === 'primary' ? serviceRegistry.get('todo_manager') : null,
      );

    // Check for bash shortcuts (! prefix)
    if (trimmed.startsWith('!')) {
      const bashCommand = trimmed.slice(1).trim();

      if (bashCommand) {
        const shortcutService = new UserShortcutService(
          agent.getToolManager(),
          activityStream
        );
        await shortcutService.runBashShortcut(bashCommand, agent, shortcutMessageSink);
        return;
      }
    }

    // Check for memory shortcuts (# prefix) - saves to the project instructions file
    if (trimmed.startsWith('#')) {
      const memoryContent = trimmed.slice(1).trim();

      if (memoryContent) {
        const shortcutService = new UserShortcutService(
          agent.getToolManager(),
          activityStream
        );
        shortcutService.saveMemoryShortcut(memoryContent, trimmed, shortcutMessageSink);
        return;
      }
    }

    // Check for slash commands
    if (trimmed.startsWith('/') && commandHandler) {
      try {
        const routeMessages = agent.getMessages().filter((message) => message.role !== 'system') as Message[];
        const result = await commandHandler.handleCommand(trimmed, routeMessages, { route });

        if (result.handled) {
          // Add user message
          addDisplayMessage({
            role: 'user',
            content: trimmed,
          });

          // Add command response if provided
          if (result.response) {
            addDisplayMessage({
              role: 'assistant',
              content: result.response,
              metadata: result.metadata, // Pass command metadata for styling
            });
          }

          // Add any updated messages (e.g., system reminders) to both UI and Agent
          if (result.updatedMessages) {
            result.updatedMessages.forEach(msg => {
              addDisplayMessage(msg);  // route-local UI display
              agent.addMessage(msg);    // Agent context for LLM
            });
          }

          return;
        }
      } catch (error) {
        // Add error message for failed command
        addDisplayMessage({
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
        const modelClient = agent.getModelClient();
        const capabilitiesIndex = ModelCapabilitiesIndex.getInstance();
        await capabilitiesIndex.load();
        const capabilities = capabilitiesIndex.getCapabilities(modelClient.modelName, modelClient.endpoint);
        if (capabilities) modelSupportsImages = capabilities.supportsImages;
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
          addDisplayMessage({
            role: 'assistant',
            content: `Error loading image: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
          return;
        }
      }

      // Add user message to UI (separate from Agent's internal message history)
      // This displays the message to the user immediately.
      // Child projections receive the durable user message from the Agent's
      // own message-added event; the primary UI still owns its legacy context.
      if (route.kind === 'primary') {
        addDisplayMessage({
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
          addDisplayMessage
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
          addDisplayMessage
        );
        if (outcome === 'aborted') {
          return;
        }
      }

      // Set thinking state
      if (route.kind === 'primary') actions.setIsThinking(true);

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
        // Some internal interruptions carry a specific reason (for example an
        // activity-watchdog timeout) instead of the generic interruption text.
        // They are not emitted as normal assistant message events, so filtering
        // them here leaves the conversation visibly idle with no explanation.
        const turnWasInterrupted = agent.getTurnSnapshot().terminationReason === 'interrupted';
        const isError = response === PERMISSION_MESSAGES.USER_FACING_DENIAL ||
                       response === PERMISSION_MESSAGES.USER_FACING_INTERRUPTION ||
                       turnWasInterrupted ||
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

          addDisplayMessage({
            role: 'assistant',
            content: messageContent,
            metadata: { isError: true },
          });
        } else if (response && response.trim().length > 0) {
          // Response exists but was filtered - log for debugging
          logger.debug('[UI_INPUT_HANDLER] Response filtered (not displayed in UI). Length:', response.length, 'Preview:', response.substring(0, 100));
        }

        // Update TokenManager and context usage
        const tokenManager = agent.getTokenManager();
        // Recalculate from the model's compacted window. The complete
        // transcript is UI history and must not re-inflate context usage.
        const agentMessages = agent.getContextMessages();
        tokenManager.updateTokenCount(agentMessages);
        if (route.kind === 'primary') {
          actions.setContextUsage(tokenManager.getContextUsagePercentage());
        }

        // Send terminal bell/badge notification
        sendTerminalNotification();
      } catch (error) {
        // Add error message
        addDisplayMessage({
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });

        // Send terminal bell/badge notification
        sendTerminalNotification();
      } finally {
        // Clear thinking state
        if (route.kind === 'primary') actions.setIsThinking(false);
      }
    }
  }, [addDisplayMessage, commandHandler, ensureRouteAvailable, route, actions]);

  return {
    handleInput,
    handleInterjection,
  };
};
