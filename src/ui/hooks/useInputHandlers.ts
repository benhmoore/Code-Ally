/**
 * useInputHandlers - Handle user input, interjections, and bash shortcuts
 *
 * This hook consolidates all input handling logic including:
 * - Regular user messages
 * - Slash commands
 * - Bash shortcuts (! prefix)
 * - User interjections (mid-response messages)
 */

import { useCallback } from 'react';
import { Agent } from '@agent/Agent.js';
import { CommandHandler } from '@agent/CommandHandler.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ToolManager } from '@tools/ToolManager.js';
import { isInjectableTool } from '@tools/InjectableTool.js';
import { AppState, AppActions } from '../contexts/AppContext.js';
import { ActivityEventType } from '@shared/index.js';
import { logger } from '@services/Logger.js';
import { PERMISSION_MESSAGES } from '@config/constants.js';
import { sendTerminalNotification } from '../../utils/terminal.js';
import { fileToBase64, isImageFile } from '@utils/imageUtils.js';
import { resolvePath } from '@utils/pathUtils.js';

/**
 * Input handler functions
 */
export interface InputHandlers {
  /** Handle regular user input (messages, commands, bash shortcuts) */
  handleInput: (input: string) => Promise<void>;
  /** Handle user interjection (submitting message mid-response) */
  handleInterjection: (message: string) => Promise<void>;
}

/**
 * Create input handler functions
 *
 * @param agent - The agent instance
 * @param commandHandler - The command handler instance
 * @param activityStream - ActivityStream to emit events
 * @param state - App context state
 * @param actions - App context actions
 * @returns Input handler functions
 *
 * @example
 * ```tsx
 * const { handleInput, handleInterjection } = useInputHandlers(
 *   agent,
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
  agent: Agent,
  commandHandler: CommandHandler | null,
  activityStream: ActivityStream,
  state: AppState,
  actions: AppActions
): InputHandlers => {
  /**
   * Handle user interjection (submitting message mid-response)
   */
  const handleInterjection = useCallback(async (message: string) => {
    if (!agent) return;

    logger.debug('[APP] Handling interjection:', message);

    // Get ServiceRegistry to access tools
    const serviceRegistry = ServiceRegistry.getInstance();
    const toolManager = serviceRegistry.get<ToolManager>('tool_manager');

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
          logger.warn('[APP] Active tool does not support message injection:', activeTool.name);
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
      agent.interrupt('interjection');
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
  }, [agent, activityStream, actions]);

  /**
   * Handle user input (messages, commands, bash shortcuts)
   */
  const handleInput = useCallback(async (input: string, mentions?: { files?: string[]; images?: string[]; directories?: string[] }) => {
    const trimmed = input.trim();

    // Check for bash shortcuts (! prefix)
    if (trimmed.startsWith('!')) {
      const bashCommand = trimmed.slice(1).trim();

      if (bashCommand) {
        try {
          // Get ToolManager from ServiceRegistry
          const serviceRegistry = ServiceRegistry.getInstance();
          const toolManager = serviceRegistry.get<ToolManager>('tool_manager');

          if (!toolManager) {
            actions.addMessage({
              role: 'assistant',
              content: 'Error: Tool manager not available',
            });
            return;
          }

          // Get BashTool
          const bashTool = toolManager.getTool('bash');

          if (!bashTool) {
            actions.addMessage({
              role: 'assistant',
              content: 'Error: Bash tool not available',
            });
            return;
          }

          // Generate unique tool call ID: bash-{timestamp}-{7-char-random} (base-36, skip '0.' prefix)
          const toolCallId = `bash-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

          // Create assistant message that describes the bash execution
          const assistantMessage = {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{
              id: toolCallId,
              type: 'function' as const,
              function: {
                name: 'bash',
                arguments: { command: bashCommand },
              },
            }],
          };

          // Add messages to Agent's conversation history
          agent.addMessage({ role: 'user', content: bashCommand });
          agent.addMessage(assistantMessage);

          // Add user message to UI
          actions.addMessage({
            role: 'user',
            content: bashCommand,
          });

          // Emit TOOL_CALL_START event to create UI element
          activityStream.emit({
            id: toolCallId,
            type: ActivityEventType.TOOL_CALL_START,
            timestamp: Date.now(),
            data: {
              toolName: 'bash',
              arguments: { command: bashCommand },
              visibleInChat: bashTool.visibleInChat ?? true,
              isTransparent: bashTool.isTransparentWrapper || false,
            },
          });

          // Execute bash command with ID for streaming output
          const result = await bashTool.execute({
            command: bashCommand,
            description: 'Execute user command',
          }, toolCallId);

          // Emit TOOL_CALL_END event to complete the tool call
          activityStream.emit({
            id: toolCallId,
            type: ActivityEventType.TOOL_CALL_END,
            timestamp: Date.now(),
            data: {
              toolName: 'bash',
              result,
              success: result.success,
              error: result.success ? undefined : result.error,
              visibleInChat: bashTool.visibleInChat ?? true,
              isTransparent: bashTool.isTransparentWrapper || false,
              collapsed: bashTool.shouldCollapse || false,
            },
          });

          // Format tool result message for Agent
          const toolResultMessage = {
            role: 'tool' as const,
            content: JSON.stringify(result),
            tool_call_id: toolCallId,
            name: 'bash',
          };

          // Add tool result to Agent's conversation history
          agent.addMessage(toolResultMessage);

          // Tool call display already shows the result, no need for additional message
          return;
        } catch (error) {
          actions.addMessage({
            role: 'assistant',
            content: `Error executing bash command: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
          return;
        }
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

      // Process images if present
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
      // This displays the message to the user immediately
      actions.addMessage({
        role: 'user',
        content: trimmed,
        metadata: filteredMentions && (filteredMentions.files?.length || filteredMentions.images?.length || filteredMentions.directories?.length)
          ? { mentions: filteredMentions }
          : undefined,
        images: base64Images,
      });

      // Handle file mentions - execute read tool before sending user message
      // Filter out image files (they're processed separately above)
      const readableFiles = filteredMentions?.files?.filter(filePath => !isImageFile(filePath)) || [];

      if (readableFiles.length > 0) {
        // Declare variables outside try block so they're accessible in catch
        let toolCallId: string | undefined;
        let readTool: any | undefined;

        try {
          // Get ToolManager from ServiceRegistry
          const serviceRegistry = ServiceRegistry.getInstance();
          const toolManager = serviceRegistry.get<ToolManager>('tool_manager');

          if (!toolManager) {
            actions.addMessage({
              role: 'assistant',
              content: 'Error: Tool manager not available',
            });
            return;
          }

          // Get ReadTool
          readTool = toolManager.getTool('read');

          if (!readTool) {
            actions.addMessage({
              role: 'assistant',
              content: 'Error: Read tool not available',
            });
            return;
          }

          // Generate unique tool call ID
          toolCallId = `read-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

          // Create assistant message that describes the read execution
          const assistantMessage = {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{
              id: toolCallId,
              type: 'function' as const,
              function: {
                name: 'read',
                arguments: { file_paths: readableFiles },
              },
            }],
          };

          // Add assistant message to Agent's conversation history
          agent.addMessage(assistantMessage);

          // Emit TOOL_CALL_START event to create UI element
          activityStream.emit({
            id: toolCallId,
            type: ActivityEventType.TOOL_CALL_START,
            timestamp: Date.now(),
            data: {
              toolName: 'read',
              arguments: { file_paths: readableFiles },
              visibleInChat: readTool.visibleInChat ?? true,
              isTransparent: readTool.isTransparentWrapper || false,
            },
          });

          // Reset tool call activity timer to prevent timeout
          if (typeof agent.resetToolCallActivity === 'function') {
            agent.resetToolCallActivity();
          }

          // Auto-promote first pending todo to in_progress
          // This helps the agent track progress through the todo list
          const todoManager = serviceRegistry.get<any>('todo_manager');

          if (todoManager) {
            const inProgress = todoManager.getInProgressTodo?.();
            if (!inProgress) {
              const nextPending = todoManager.getNextPendingTodo?.();
              if (nextPending) {
                // Find and update the todo
                const todos = todoManager.getTodos();
                const updated = todos.map((t: any) =>
                  t.id === nextPending.id ? { ...t, status: 'in_progress' as const } : t
                );
                todoManager.setTodos(updated);
              }
            }
          }

          // Execute read tool via ToolManager.executeTool() for proper integration
          const result = await toolManager.executeTool(
            'read',
            {
              file_paths: readableFiles,
              description: 'Read mentioned files',
            },
            toolCallId,
            false, // isRetry
            agent.getToolAbortSignal?.(),
            true,  // isUserInitiated (95% limit)
            false, // isContextFile (not applicable)
            agent.getAgentName?.() // currentAgentName for tool-agent binding validation
          );

          // Emit TOOL_CALL_END event to complete the tool call
          activityStream.emit({
            id: toolCallId,
            type: ActivityEventType.TOOL_CALL_END,
            timestamp: Date.now(),
            data: {
              toolName: 'read',
              result,
              success: result.success,
              error: result.success ? undefined : result.error,
              visibleInChat: readTool.visibleInChat ?? true,
              isTransparent: readTool.isTransparentWrapper || false,
              collapsed: readTool.shouldCollapse || false,
            },
          });

          // Format tool result message for Agent
          const toolResultMessage = {
            role: 'tool' as const,
            content: JSON.stringify(result),
            tool_call_id: toolCallId,
            name: 'read',
          };

          // Add tool result to Agent's conversation history
          agent.addMessage(toolResultMessage);
        } catch (error) {
          // Emit TOOL_CALL_END event with error to prevent stuck UI
          if (toolCallId) {
            activityStream.emit({
              id: toolCallId,
              type: ActivityEventType.TOOL_CALL_END,
              timestamp: Date.now(),
              data: {
                toolName: 'read',
                result: {
                  success: false,
                  error: error instanceof Error ? error.message : 'Unknown error',
                  error_type: 'system_error',
                },
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                visibleInChat: readTool?.visibleInChat ?? true,
                isTransparent: readTool?.isTransparentWrapper || false,
                collapsed: readTool?.shouldCollapse || false,
              },
            });

            // Add error tool result to Agent's conversation history
            const errorToolResultMessage = {
              role: 'tool' as const,
              content: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                error_type: 'system_error',
              }),
              tool_call_id: toolCallId,
              name: 'read',
            };
            agent.addMessage(errorToolResultMessage);
          }

          // Show error to user
          actions.addMessage({
            role: 'assistant',
            content: `Error reading mentioned files: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
          return;
        }
      }

      // Handle directory mentions - execute tree tool before sending user message
      if (filteredMentions?.directories && filteredMentions.directories.length > 0) {
        // Declare variables outside try block so they're accessible in catch
        let toolCallId: string | undefined;
        let treeTool: any | undefined;

        try {
          // Get ToolManager from ServiceRegistry
          const serviceRegistry = ServiceRegistry.getInstance();
          const toolManager = serviceRegistry.get<ToolManager>('tool_manager');

          if (!toolManager) {
            actions.addMessage({
              role: 'assistant',
              content: 'Error: Tool manager not available',
            });
            return;
          }

          // Get TreeTool
          treeTool = toolManager.getTool('tree');

          if (!treeTool) {
            actions.addMessage({
              role: 'assistant',
              content: 'Error: Tree tool not available',
            });
            return;
          }

          // Generate unique tool call ID
          toolCallId = `tree-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

          // Create assistant message that describes the tree execution
          const assistantMessage = {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{
              id: toolCallId,
              type: 'function' as const,
              function: {
                name: 'tree',
                arguments: { paths: filteredMentions.directories },
              },
            }],
          };

          // Add assistant message to Agent's conversation history
          agent.addMessage(assistantMessage);

          // Emit TOOL_CALL_START event to create UI element
          activityStream.emit({
            id: toolCallId,
            type: ActivityEventType.TOOL_CALL_START,
            timestamp: Date.now(),
            data: {
              toolName: 'tree',
              arguments: { paths: filteredMentions.directories },
              visibleInChat: treeTool.visibleInChat ?? true,
              isTransparent: treeTool.isTransparentWrapper || false,
            },
          });

          // Reset tool call activity timer to prevent timeout
          if (typeof agent.resetToolCallActivity === 'function') {
            agent.resetToolCallActivity();
          }

          // Execute tree tool via ToolManager.executeTool() for proper integration
          const result = await toolManager.executeTool(
            'tree',
            {
              paths: filteredMentions.directories,
              description: 'Show directory structure',
            },
            toolCallId,
            false, // isRetry
            agent.getToolAbortSignal?.(),
            true,  // isUserInitiated (95% limit)
            false, // isContextFile (not applicable)
            agent.getAgentName?.() // currentAgentName for tool-agent binding validation
          );

          // Emit TOOL_CALL_END event to complete the tool call
          activityStream.emit({
            id: toolCallId,
            type: ActivityEventType.TOOL_CALL_END,
            timestamp: Date.now(),
            data: {
              toolName: 'tree',
              result,
              success: result.success,
              error: result.success ? undefined : result.error,
              visibleInChat: treeTool.visibleInChat ?? true,
              isTransparent: treeTool.isTransparentWrapper || false,
              collapsed: treeTool.shouldCollapse || false,
            },
          });

          // Format tool result message for Agent
          const toolResultMessage = {
            role: 'tool' as const,
            content: JSON.stringify(result),
            tool_call_id: toolCallId,
            name: 'tree',
          };

          // Add tool result to Agent's conversation history
          agent.addMessage(toolResultMessage);
        } catch (error) {
          // Emit TOOL_CALL_END event with error to prevent stuck UI
          if (toolCallId) {
            activityStream.emit({
              id: toolCallId,
              type: ActivityEventType.TOOL_CALL_END,
              timestamp: Date.now(),
              data: {
                toolName: 'tree',
                result: {
                  success: false,
                  error: error instanceof Error ? error.message : 'Unknown error',
                  error_type: 'system_error',
                },
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                visibleInChat: treeTool?.visibleInChat ?? true,
                isTransparent: treeTool?.isTransparentWrapper || false,
                collapsed: treeTool?.shouldCollapse || false,
              },
            });

            // Add error tool result to Agent's conversation history
            const errorToolResultMessage = {
              role: 'tool' as const,
              content: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                error_type: 'system_error',
              }),
              tool_call_id: toolCallId,
              name: 'tree',
            };
            agent.addMessage(errorToolResultMessage);
          }

          // Show error to user
          actions.addMessage({
            role: 'assistant',
            content: `Error showing directory structure: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
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
      const serviceRegistry = ServiceRegistry.getInstance();
      const services = [
        serviceRegistry.get('idle_message_generator'),
        (serviceRegistry.get('session_manager') as any)?.titleGenerator,
      ].filter(Boolean);

      for (const service of services) {
        if (typeof (service as any).cancel === 'function') {
          (service as any).cancel();
        }
      }

      // Send to agent for processing
      try {
        const response = await agent.sendMessage(trimmed, undefined, base64Images);

        // Check if response is an error message that should be styled in red
        const isError = response === PERMISSION_MESSAGES.USER_FACING_DENIAL ||
                       response === PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;

        // Add assistant response for error messages only
        // Normal responses are added via ASSISTANT_MESSAGE_COMPLETE event for proper interleaving
        if (isError) {
          actions.addMessage({
            role: 'assistant',
            content: response,
            metadata: { isError: true },
          });
        }

        // Update TokenManager and context usage
        const registry = ServiceRegistry.getInstance();
        const tokenManager = registry.get('token_manager');
        if (tokenManager) {
          // Recalculate tokens from agent's messages
          const agentMessages = agent.getMessages();
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
  }, [agent, commandHandler, activityStream, state.messages, actions]);

  return {
    handleInput,
    handleInterjection,
  };
};
