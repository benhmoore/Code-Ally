/**
 * App - Root React component for Code Ally UI
 *
 * This is the main entry point for the Ink-based terminal UI. It sets up
 * the context providers, manages global state, and coordinates the overall
 * application structure.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityProvider, useActivityStreamContext } from './contexts/ActivityContext.js';
import { AppProvider, useAppContext } from './contexts/AppContext.js';
import { useActivityEvent } from './hooks/useActivityEvent.js';
import { ActivityEventType, Config, ToolCallState, Message } from '../types/index.js';
import { InputPrompt } from './components/InputPrompt.js';
import { ConversationView } from './components/ConversationView.js';
import { PermissionPrompt, PermissionRequest } from './components/PermissionPrompt.js';
import { ModelSelector, ModelOption } from './components/ModelSelector.js';
import { ConfigViewer } from './components/ConfigViewer.js';
import { SetupWizardView } from './components/SetupWizardView.js';
import { RewindSelector } from './components/RewindSelector.js';
import { StatusIndicator } from './components/StatusIndicator.js';
import { Agent } from '../agent/Agent.js';
import { CommandHistory } from '../services/CommandHistory.js';
import { CompletionProvider } from '../services/CompletionProvider.js';
import { AgentManager } from '../services/AgentManager.js';
import { CommandHandler } from '../agent/CommandHandler.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ConfigManager } from '../services/ConfigManager.js';
import { ToolManager } from '../tools/ToolManager.js';

/**
 * Props for the App component
 */
export interface AppProps {
  /** Initial configuration */
  config: Config;

  /** Activity stream instance */
  activityStream?: ActivityStream;

  /** Agent instance */
  agent: Agent;
}

/**
 * Inner app component that uses contexts
 *
 * This component is wrapped by providers and has access to all context values.
 * It subscribes to activity events and updates the app state accordingly.
 */
const AppContent: React.FC<{ agent: Agent }> = ({ agent }) => {
  const { state, actions } = useAppContext();
  const activityStream = useActivityStreamContext();

  // Initialize command history, completion provider, and command handler
  const commandHistory = useRef<CommandHistory | null>(null);
  const [completionProvider, setCompletionProvider] = useState<CompletionProvider | null>(null);
  const commandHandler = useRef<CommandHandler | null>(null);


  // Permission prompt state
  const [permissionRequest, setPermissionRequest] = useState<(PermissionRequest & { requestId: string }) | undefined>(undefined);
  const [permissionSelectedIndex, setPermissionSelectedIndex] = useState(0);

  // Model selector state
  const [modelSelectRequest, setModelSelectRequest] = useState<{ requestId: string; models: ModelOption[]; currentModel?: string } | undefined>(undefined);
  const [modelSelectedIndex, setModelSelectedIndex] = useState(0);

  // Config viewer state (non-modal - stays open while user interacts)
  const [configViewerOpen, setConfigViewerOpen] = useState(false);

  // Setup wizard state
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);

  // Rewind selector state
  const [rewindRequest, setRewindRequest] = useState<{ requestId: string; userMessagesCount: number; selectedIndex: number } | undefined>(undefined);
  const [inputPrefillText, setInputPrefillText] = useState<string | undefined>(undefined);

  // Throttle tool call updates to max once every 2 seconds
  const pendingToolUpdates = useRef<Map<string, Partial<ToolCallState>>>(new Map());
  const lastUpdateTime = useRef<number>(Date.now());
  const updateTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Flush pending tool call updates
  const flushToolUpdates = useRef(() => {
    if (pendingToolUpdates.current.size === 0) return;

    // Apply all pending updates
    pendingToolUpdates.current.forEach((update, id) => {
      if (update.status === 'executing' && update.startTime) {
        // This is a new tool call
        actions.addToolCall(update as ToolCallState);
      } else {
        // This is an update to existing tool call
        actions.updateToolCall(id, update);
      }
    });

    pendingToolUpdates.current.clear();
    lastUpdateTime.current = Date.now();
  });

  // Schedule throttled update (batches updates, applies every 2s max)
  const scheduleToolUpdate = useRef((id: string, update: Partial<ToolCallState>, immediate: boolean = false) => {
    // Immediate updates for completion events (to avoid perceived lag)
    if (immediate) {
      actions.updateToolCall(id, update);
      return;
    }

    // Batch update
    const existing = pendingToolUpdates.current.get(id);
    pendingToolUpdates.current.set(id, { ...existing, ...update });

    // Clear existing timer
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
    }

    // If last update was > 2s ago, flush immediately
    const timeSinceLastUpdate = Date.now() - lastUpdateTime.current;
    if (timeSinceLastUpdate >= 2000) {
      flushToolUpdates.current();
    } else {
      // Otherwise schedule flush in remaining time
      const delay = 2000 - timeSinceLastUpdate;
      updateTimerRef.current = setTimeout(flushToolUpdates.current, delay);
    }
  });

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
      }
    };
  }, []);

  // Initialize services on mount
  useEffect(() => {
    const initializeServices = async () => {
      try {
        // Create and load command history
        const history = new CommandHistory();
        await history.load();
        commandHistory.current = history;

        // Create completion provider with agent manager
        const agentManager = new AgentManager();
        const provider = new CompletionProvider(agentManager);
        setCompletionProvider(provider);

        // Create command handler with service registry and config manager
        const serviceRegistry = ServiceRegistry.getInstance();
        const configManager = serviceRegistry.get<ConfigManager>('config_manager');

        if (configManager) {
          const handler = new CommandHandler(agent, configManager, serviceRegistry);
          commandHandler.current = handler;
        }

        // Initialize context usage from TokenManager
        const tokenManager = serviceRegistry.get('token_manager');
        if (tokenManager && typeof (tokenManager as any).getContextUsagePercentage === 'function') {
          const initialContextUsage = (tokenManager as any).getContextUsagePercentage();
          actions.setContextUsage(initialContextUsage);
        }
      } catch (error) {
        console.error('Failed to initialize input services:', error);
        // Continue without services
      }
    };

    initializeServices();
  }, [agent, actions]);

  // Subscribe to tool call start events
  useActivityEvent(ActivityEventType.TOOL_CALL_START, (event) => {
    // Skip tool group orchestration events (they're not actual tool calls)
    if (event.data?.groupExecution) {
      return;
    }

    // Enforce structure: tool calls MUST have IDs
    if (!event.id) {
      throw new Error(`TOOL_CALL_START event missing required 'id' field. Tool: ${event.data?.toolName || 'unknown'}, Timestamp: ${event.timestamp}`);
    }

    if (!event.data?.toolName) {
      throw new Error(`TOOL_CALL_START event missing required 'toolName' field. ID: ${event.id}`);
    }

    if (!event.timestamp) {
      throw new Error(`TOOL_CALL_START event missing required 'timestamp' field. ID: ${event.id}, Tool: ${event.data.toolName}`);
    }

    const toolCall: ToolCallState = {
      id: event.id,
      status: 'executing',
      toolName: event.data.toolName,
      arguments: event.data.arguments || {},
      startTime: event.timestamp,
      parentId: event.parentId, // For nested tool calls (e.g., from subagents)
      visibleInChat: event.data.visibleInChat ?? true, // Whether to show in conversation
      isTransparent: event.data.isTransparent || false, // For wrapper tools
    };
    // Tool call creation must be immediate to avoid race conditions with completion events
    actions.addToolCall(toolCall);
  });

  // Subscribe to tool call end events
  useActivityEvent(ActivityEventType.TOOL_CALL_END, (event) => {
    // Skip tool group orchestration events (they're not actual tool calls)
    if (event.data?.groupExecution) {
      return;
    }

    // Enforce structure
    if (!event.id) {
      throw new Error(`TOOL_CALL_END event missing required 'id' field. Timestamp: ${event.timestamp}`);
    }

    if (!event.timestamp) {
      throw new Error(`TOOL_CALL_END event missing required 'timestamp' field. ID: ${event.id}`);
    }

    if (event.data?.success === undefined) {
      throw new Error(`TOOL_CALL_END event missing required 'success' field. ID: ${event.id}`);
    }

    scheduleToolUpdate.current(event.id, {
      status: event.data.success ? 'success' : 'error',
      endTime: event.timestamp,
      error: event.data.error,
      collapsed: event.data.collapsed || false,
      // Clear diff preview on completion - the preview is no longer relevant
      diffPreview: undefined,
    }, true); // Immediate update for completion
  });

  // Subscribe to tool output chunks
  useActivityEvent(ActivityEventType.TOOL_OUTPUT_CHUNK, (event) => {
    // Enforce structure
    if (!event.id) {
      throw new Error(`TOOL_OUTPUT_CHUNK event missing required 'id' field`);
    }

    scheduleToolUpdate.current(event.id, {
      output: event.data?.chunk || '',
    }, false); // Throttled update
  });

  // Subscribe to diff preview events
  useActivityEvent(ActivityEventType.DIFF_PREVIEW, (event) => {
    if (!event.id) {
      throw new Error(`DIFF_PREVIEW event missing required 'id' field`);
    }

    scheduleToolUpdate.current(event.id, {
      diffPreview: {
        oldContent: event.data?.oldContent || '',
        newContent: event.data?.newContent || '',
        filePath: event.data?.filePath || '',
        operationType: event.data?.operationType || 'edit',
      },
    }, false); // Throttled update
  });

  // Subscribe to error events
  useActivityEvent(ActivityEventType.ERROR, (event) => {
    // Skip tool group orchestration events (they're not actual tool calls)
    if (event.data?.groupExecution) {
      return;
    }

    // Enforce structure
    if (!event.id) {
      throw new Error(`ERROR event missing required 'id' field`);
    }

    if (!event.timestamp) {
      throw new Error(`ERROR event missing required 'timestamp' field. ID: ${event.id}`);
    }

    scheduleToolUpdate.current(event.id, {
      status: 'error',
      error: event.data?.error || 'Unknown error',
      endTime: event.timestamp,
      // Clear diff preview on error
      diffPreview: undefined,
    }, true); // Immediate update for errors
  });

  // Subscribe to permission request events
  useActivityEvent(ActivityEventType.PERMISSION_REQUEST, (event) => {
    // Enforce structure
    if (!event.id) {
      throw new Error(`PERMISSION_REQUEST event missing required 'id' field`);
    }

    const { requestId, toolName, path, command, arguments: args, sensitivity, options } = event.data || {};

    if (!requestId) {
      throw new Error(`PERMISSION_REQUEST event missing required 'requestId' field. ID: ${event.id}`);
    }

    // Note: Permission requests have their own IDs (perm_xxx) that are separate from tool call IDs
    // They occur BEFORE tool calls start, so there's no tool call to update yet

    setPermissionRequest({
      requestId,
      toolName,
      path,
      command,
      arguments: args,
      sensitivity,
      options,
    });
    setPermissionSelectedIndex(0); // Reset selection
  });

  // Subscribe to permission response events (to clear UI state)
  useActivityEvent(ActivityEventType.PERMISSION_RESPONSE, () => {
    // Just clear the permission prompt UI
    // The tool call will start (TOOL_CALL_START) after permission is granted
    setPermissionRequest(undefined);
    setPermissionSelectedIndex(0);
  });

  // Subscribe to model select request events
  useActivityEvent(ActivityEventType.MODEL_SELECT_REQUEST, (event) => {
    const { requestId, models, currentModel } = event.data;
    setModelSelectRequest({ requestId, models, currentModel });
    setModelSelectedIndex(0);
  });

  // Subscribe to config view toggle events
  useActivityEvent(ActivityEventType.CONFIG_VIEW_REQUEST, () => {
    // Toggle config viewer open/closed
    setConfigViewerOpen(prev => !prev);
  });

  // Subscribe to setup wizard request events
  useActivityEvent(ActivityEventType.SETUP_WIZARD_REQUEST, () => {
    setSetupWizardOpen(true);
  });

  // Subscribe to setup wizard completion events
  useActivityEvent(ActivityEventType.SETUP_WIZARD_COMPLETE, () => {
    setSetupWizardOpen(false);
    actions.addMessage({
      role: 'assistant',
      content: 'Setup completed successfully! Code Ally is ready to use.',
    });
  });

  // Subscribe to setup wizard skip events
  useActivityEvent(ActivityEventType.SETUP_WIZARD_SKIP, () => {
    setSetupWizardOpen(false);
    actions.addMessage({
      role: 'assistant',
      content: 'Setup wizard skipped. You can run /init anytime to configure Code Ally.',
    });
  });

  // Subscribe to context usage updates (real-time updates during tool execution)
  useActivityEvent(ActivityEventType.CONTEXT_USAGE_UPDATE, (event) => {
    const { contextUsage } = event.data;
    if (typeof contextUsage === 'number') {
      actions.setContextUsage(contextUsage);
    }
  });

  // Subscribe to auto-compaction start event
  useActivityEvent(ActivityEventType.AUTO_COMPACTION_START, () => {
    actions.setIsCompacting(true);
  });

  // Subscribe to auto-compaction complete event
  useActivityEvent(ActivityEventType.AUTO_COMPACTION_COMPLETE, (event) => {
    const { oldContextUsage, newContextUsage, threshold, compactedMessages } = event.data;

    // Update messages to compacted state
    if (compactedMessages) {
      actions.setMessages(compactedMessages);
      agent.setMessages(compactedMessages);
    }

    // Add compaction notice
    actions.addCompactionNotice({
      id: event.id,
      timestamp: event.timestamp,
      oldContextUsage,
      threshold,
    });

    // Update context usage
    if (typeof newContextUsage === 'number') {
      actions.setContextUsage(newContextUsage);
    }

    // Clear compacting flag
    actions.setIsCompacting(false);
  });

  // Subscribe to model select response events
  useActivityEvent(ActivityEventType.MODEL_SELECT_RESPONSE, async (event) => {
    const { modelName } = event.data;

    // Clear selector immediately (crucial for unblocking input)
    setModelSelectRequest(undefined);
    setModelSelectedIndex(0);

    // Apply selection if not cancelled
    if (modelName) {
      const registry = ServiceRegistry.getInstance();
      const configManager = registry.get<ConfigManager>('config_manager');

      if (configManager) {
        try {
          // Update config
          await configManager.setValue('model', modelName);

          // Update the active ModelClient to use the new model
          const modelClient = registry.get<any>('model_client');
          if (modelClient && typeof modelClient.setModelName === 'function') {
            modelClient.setModelName(modelName);
          }

          // Update state config for UI display
          actions.updateConfig({ model: modelName });

          // Add confirmation message
          actions.addMessage({
            role: 'assistant',
            content: `Model changed to: ${modelName}`,
          });
        } catch (error) {
          actions.addMessage({
            role: 'assistant',
            content: `Error changing model: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      }
    }
  });

  // Subscribe to rewind request events
  useActivityEvent(ActivityEventType.REWIND_REQUEST, (event) => {
    const { requestId } = event.data;

    // Only allow rewind when agent is not thinking and no active tools
    if (state.isThinking || state.activeToolCalls.length > 0) {
      actions.addMessage({
        role: 'assistant',
        content: 'Cannot rewind while agent is processing. Please wait for current operation to complete.',
      });
      return;
    }

    // Don't calculate here - state.messages is stale!
    // Just set a marker request that will be populated in useEffect
    setRewindRequest({
      requestId,
      userMessagesCount: -1, // Marker that this needs initialization
      selectedIndex: -1 // Marker that this needs initialization
    });
  });

  // Update rewind request with current state when it's first set
  useEffect(() => {
    if (rewindRequest && rewindRequest.userMessagesCount === -1) {
      const userMessages = state.messages.filter(m => m.role === 'user');
      const initialIndex = Math.max(0, userMessages.length - 1);

      setRewindRequest(prev => prev ? {
        ...prev,
        userMessagesCount: userMessages.length,
        selectedIndex: initialIndex
      } : undefined);
    }
  }, [rewindRequest, state.messages]);

  // Subscribe to rewind response events
  useActivityEvent(ActivityEventType.REWIND_RESPONSE, async (event) => {
    const { selectedIndex, cancelled } = event.data;

    // Clear selector immediately (crucial for unblocking input)
    setRewindRequest(undefined);

    // Apply rewind if not cancelled
    if (!cancelled && selectedIndex !== undefined) {
      try {
        const targetMessageContent = await agent.rewindToMessage(selectedIndex);

        // Update UI state - get fresh messages from agent, filter out system messages
        const newMessages = agent.getMessages().filter(m => m.role !== 'system');
        actions.setMessages(newMessages);

        // Clear any active tool calls
        actions.clearToolCalls();

        // Pre-fill the input with the target message for editing
        setInputPrefillText(targetMessageContent);
      } catch (error) {
        actions.addMessage({
          role: 'assistant',
          content: `Error rewinding conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }
  });

  // Handle user input
  const handleInput = async (input: string) => {
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

          // Generate unique tool call ID
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

          // Format response based on result
          let responseContent = '';
          if (result.success) {
            responseContent = `Command executed successfully${result.output ? ':\n' + result.output : ''}`;
          } else {
            responseContent = `Command failed: ${result.error || 'Unknown error'}`;
          }

          // Add assistant response to UI
          actions.addMessage({
            role: 'assistant',
            content: responseContent,
          });

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

    // Check for slash commands first
    if (trimmed.startsWith('/') && commandHandler.current) {
      try {
        const result = await commandHandler.current.handleCommand(trimmed, state.messages);

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
            });
          }

          // Update messages if command modified them (e.g., /compact)
          if (result.updatedMessages) {
            actions.setMessages(result.updatedMessages);

            // Update agent's internal messages
            agent.setMessages(result.updatedMessages);

            // Update TokenManager with new token count after compaction
            const registry = ServiceRegistry.getInstance();
            const tokenManager = registry.get('token_manager');
            if (tokenManager) {
              if (typeof (tokenManager as any).updateTokenCount === 'function') {
                (tokenManager as any).updateTokenCount(result.updatedMessages);
              }

              // Update context usage display
              if (typeof (tokenManager as any).getContextUsagePercentage === 'function') {
                const contextUsage = (tokenManager as any).getContextUsagePercentage();
                actions.setContextUsage(contextUsage);
              }
            }
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
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Conversation View - contains header + all conversation history in Static */}
      <Box flexDirection="column" flexGrow={1}>
        <ConversationView
          messages={state.messages}
          isThinking={state.isThinking}
          activeToolCalls={state.activeToolCalls}
          contextUsage={state.contextUsage}
          compactionNotices={state.compactionNotices}
        />
      </Box>

      {/* Status Indicator - hide when any modal is active */}
      {!permissionRequest && !modelSelectRequest && !rewindRequest && !setupWizardOpen && (
        <StatusIndicator isProcessing={state.isThinking} isCompacting={state.isCompacting} />
      )}

      {/* Config Viewer (non-modal - shown above input) */}
      {configViewerOpen && !setupWizardOpen && (
        <Box marginTop={1}>
          <ConfigViewer visible={true} />
        </Box>
      )}

      {/* Setup Wizard (modal - replaces input when active) */}
      {setupWizardOpen ? (
        <Box marginTop={1}>
          <SetupWizardView
            onComplete={() => {
              if (activityStream) {
                activityStream.emit({
                  id: `setup_wizard_complete_${Date.now()}`,
                  type: ActivityEventType.SETUP_WIZARD_COMPLETE,
                  timestamp: Date.now(),
                  data: {},
                });
              }
            }}
            onSkip={() => {
              if (activityStream) {
                activityStream.emit({
                  id: `setup_wizard_skip_${Date.now()}`,
                  type: ActivityEventType.SETUP_WIZARD_SKIP,
                  timestamp: Date.now(),
                  data: {},
                });
              }
            }}
          />
        </Box>
      ) : /* Model Selector (replaces input when active) */
      modelSelectRequest ? (
        <Box marginTop={1} flexDirection="column">
          <ModelSelector
            models={modelSelectRequest.models}
            selectedIndex={modelSelectedIndex}
            currentModel={modelSelectRequest.currentModel}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              isActive={true}
              commandHistory={commandHistory.current || undefined}
              completionProvider={completionProvider || undefined}
              modelSelectRequest={modelSelectRequest}
              modelSelectedIndex={modelSelectedIndex}
              onModelNavigate={setModelSelectedIndex}
              activityStream={activityStream}
              agent={agent}
              prefillText={inputPrefillText}
              onPrefillConsumed={() => setInputPrefillText(undefined)}
            />
          </Box>
        </Box>
      ) : rewindRequest ? (
        /* Rewind Selector (replaces input when active) */
        (() => {
          const userMessages = state.messages.filter(m => m.role === 'user');
          return (
            <Box marginTop={1} flexDirection="column">
              <RewindSelector
                messages={userMessages}
                selectedIndex={rewindRequest.selectedIndex}
                visible={true}
              />
              {/* Hidden InputPrompt for keyboard handling only */}
              <Box height={0} overflow="hidden">
                <InputPrompt
                  onSubmit={handleInput}
                  isActive={true}
                  commandHistory={commandHistory.current || undefined}
                  completionProvider={completionProvider || undefined}
                  rewindRequest={rewindRequest}
                  onRewindNavigate={(newIndex) => setRewindRequest(prev => prev ? { ...prev, selectedIndex: newIndex } : undefined)}
                  activityStream={activityStream}
                  agent={agent}
                  prefillText={inputPrefillText}
                  onPrefillConsumed={() => setInputPrefillText(undefined)}
                />
              </Box>
            </Box>
          );
        })()
      ) : permissionRequest ? (
        /* Permission Prompt (replaces input when active) */
        <Box marginTop={1} flexDirection="column">
          <PermissionPrompt
            request={permissionRequest}
            selectedIndex={permissionSelectedIndex}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              isActive={true}
              commandHistory={commandHistory.current || undefined}
              completionProvider={completionProvider || undefined}
              permissionRequest={permissionRequest}
              permissionSelectedIndex={permissionSelectedIndex}
              onPermissionNavigate={setPermissionSelectedIndex}
              activityStream={activityStream}
              agent={agent}
              prefillText={inputPrefillText}
              onPrefillConsumed={() => setInputPrefillText(undefined)}
            />
          </Box>
        </Box>
      ) : (
        /* Input Prompt */
        <Box marginTop={1}>
          <InputPrompt
            onSubmit={handleInput}
            isActive={true}
            commandHistory={commandHistory.current || undefined}
            completionProvider={completionProvider || undefined}
            configViewerOpen={configViewerOpen}
            activityStream={activityStream}
            agent={agent}
            prefillText={inputPrefillText}
            onPrefillConsumed={() => setInputPrefillText(undefined)}
          />
        </Box>
      )}

      {/* Footer / Help */}
      <Box marginTop={1}>
        <Text dimColor>
          Ctrl+C to exit | Model: {state.config.model || 'none'} | Context:{' '}
          <Text color={state.contextUsage >= 90 ? 'red' : state.contextUsage >= 85 ? 'yellow' : state.contextUsage >= 70 ? 'cyan' : undefined}>
            {state.contextUsage}%
          </Text>
          {state.contextUsage >= 95 && <Text color="red"> (Critical - use /compact)</Text>}
          {state.contextUsage >= 85 && state.contextUsage < 95 && <Text color="yellow"> (High - consider /compact)</Text>}
          {state.contextUsage >= 70 && state.contextUsage < 85 && <Text color="cyan"> (Elevated)</Text>}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * Root App Component
 *
 * Sets up all context providers and renders the main application.
 * This is the entry point for the Ink application.
 *
 * @example
 * ```tsx
 * import { render } from 'ink';
 * import { App } from './ui/App.js';
 *
 * const config = await configManager.getConfig();
 * const { unmount } = render(<App config={config} />);
 * ```
 */
export const App: React.FC<AppProps> = ({ config, activityStream, agent }) => {
  // Create activity stream if not provided
  const streamRef = useRef(activityStream || new ActivityStream());

  return (
    <ActivityProvider activityStream={streamRef.current}>
      <AppProvider initialConfig={config}>
        <AppContent agent={agent} />
      </AppProvider>
    </ActivityProvider>
  );
};

/**
 * Example usage with message injection for testing
 */
export interface AppWithMessagesProps extends AppProps {
  /** Initial messages to display */
  initialMessages?: Message[];
}

/**
 * App component with initial messages
 *
 * Useful for testing and development. Allows pre-populating the conversation.
 *
 * @example
 * ```tsx
 * const messages: Message[] = [
 *   { role: 'user', content: 'Hello!' },
 *   { role: 'assistant', content: 'Hi there!' },
 * ];
 *
 * render(<AppWithMessages config={config} initialMessages={messages} />);
 * ```
 */
export const AppWithMessages: React.FC<AppWithMessagesProps> = ({
  config,
  activityStream,
  agent,
  initialMessages = [],
}) => {
  const streamRef = useRef(activityStream || new ActivityStream());

  return (
    <ActivityProvider activityStream={streamRef.current}>
      <AppProvider initialConfig={config}>
        <AppContentWithMessages agent={agent} initialMessages={initialMessages} />
      </AppProvider>
    </ActivityProvider>
  );
};

/**
 * Inner component that accepts initial messages
 */
const AppContentWithMessages: React.FC<{ agent: Agent; initialMessages: Message[] }> = ({
  agent,
  initialMessages,
}) => {
  const { actions } = useAppContext();

  // Load initial messages on mount
  useEffect(() => {
    if (initialMessages.length > 0) {
      actions.setMessages(initialMessages);
    }
  }, []); // Only run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps

  return <AppContent agent={agent} />;
};

export default App;
