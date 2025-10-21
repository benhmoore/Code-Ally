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
      } catch (error) {
        console.error('Failed to initialize input services:', error);
        // Continue without services
      }
    };

    initializeServices();
  }, [agent]);

  // Subscribe to tool call start events
  useActivityEvent(ActivityEventType.TOOL_CALL_START, (event) => {
    console.log('[TOOL_CALL_START]', event.id, event.data?.toolName, 'parentId:', event.parentId);

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
      isTransparent: event.data.isTransparent || false, // For wrapper tools
    };
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

    actions.updateToolCall(event.id, {
      status: event.data.success ? 'success' : 'error',
      endTime: event.timestamp,
      error: event.data.error,
      collapsed: event.data.collapsed || false,
    });
  });

  // Subscribe to tool output chunks
  useActivityEvent(ActivityEventType.TOOL_OUTPUT_CHUNK, (event) => {
    // Enforce structure
    if (!event.id) {
      throw new Error(`TOOL_OUTPUT_CHUNK event missing required 'id' field`);
    }

    actions.updateToolCall(event.id, {
      output: event.data?.chunk || '',
    });
  });

  // Subscribe to diff preview events
  useActivityEvent(ActivityEventType.DIFF_PREVIEW, (event) => {
    if (!event.id) {
      throw new Error(`DIFF_PREVIEW event missing required 'id' field`);
    }

    actions.updateToolCall(event.id, {
      diffPreview: {
        oldContent: event.data?.oldContent || '',
        newContent: event.data?.newContent || '',
        filePath: event.data?.filePath || '',
        operationType: event.data?.operationType || 'edit',
      },
    });
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

    actions.updateToolCall(event.id, {
      status: 'error',
      error: event.data?.error || 'Unknown error',
      endTime: event.timestamp,
    });
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

  // Subscribe to model select response events
  useActivityEvent(ActivityEventType.MODEL_SELECT_RESPONSE, async (event) => {
    const { modelName } = event.data;

    // Clear selector
    setModelSelectRequest(undefined);

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

          // Add user message (with the command, not the ! prefix)
          actions.addMessage({
            role: 'user',
            content: bashCommand,
          });

          // Execute bash command directly
          const result = await bashTool.execute({ command: bashCommand });

          // Format response based on result
          let responseContent = '';
          if (result.success) {
            const output = result.output || '';
            responseContent = output.trim() || '';
          } else {
            const error = result.error || 'Unknown error';
            responseContent = error;
          }

          // Add assistant response (only if there's content)
          if (responseContent.trim()) {
            actions.addMessage({
              role: 'assistant',
              content: responseContent,
            });
          }

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
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Code Ally
        </Text>
        <Text dimColor> - Terminal UI (Ink)</Text>
      </Box>

      {/* Context Usage Indicator */}
      {state.contextUsage >= 70 && (
        <Box marginBottom={1}>
          <Text color={state.contextUsage >= 90 ? 'red' : 'yellow'}>
            Context: {state.contextUsage}% used
          </Text>
        </Box>
      )}

      {/* Conversation View */}
      <Box flexDirection="column" flexGrow={1} marginBottom={1}>
        <ConversationView
          messages={state.messages}
          isThinking={state.isThinking}
          activeToolCalls={state.activeToolCalls}
        />
      </Box>

      {/* Status Indicator - hide when permission prompt is active */}
      {!permissionRequest && !modelSelectRequest && (
        <StatusIndicator isProcessing={state.isThinking} />
      )}

      {/* Model Selector (replaces input when active) */}
      {modelSelectRequest ? (
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
            />
          </Box>
        </Box>
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
            activityStream={activityStream}
            agent={agent}
          />
        </Box>
      )}

      {/* Footer / Help */}
      <Box marginTop={1}>
        <Text dimColor>
          Ctrl+C to exit | Model: {state.config.model || 'none'}
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
