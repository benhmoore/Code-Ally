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
import { Agent } from '../../agent/Agent.js';
import { CommandHandler } from '../../agent/CommandHandler.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ToolManager } from '../../tools/ToolManager.js';
import { AppState, AppActions } from '../contexts/AppContext.js';
import { ActivityEventType } from '../../types/index.js';
import { logger } from '../../services/Logger.js';

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
        (activeTool.tool as any).injectUserMessage(message);
        routedToTool = true;
        targetToolName = activeTool.name;
        parentId = activeTool.callId; // Use tool call ID for nesting

        logger.debug('[APP] Successfully routed to tool:', activeTool.name, 'callId:', activeTool.callId);
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
  const handleInput = useCallback(async (input: string) => {
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
          const result = await bashTool.execute({ command: bashCommand }, toolCallId);

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
      actions.addMessage({
        role: 'user',
        content: trimmed,
      });

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
        const response = await agent.sendMessage(trimmed);

        // Add assistant response
        actions.addMessage({
          role: 'assistant',
          content: response,
        });

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
      } catch (error) {
        // Add error message
        actions.addMessage({
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
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
