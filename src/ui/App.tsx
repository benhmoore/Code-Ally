/**
 * App - Root React component for Code Ally UI
 *
 * This is the main entry point for the Ink-based terminal UI. It sets up
 * the context providers, manages global state, and coordinates the overall
 * application structure.
 */

import React, { useEffect, useRef } from 'react';
import { Box, Text, useApp } from 'ink';
import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityProvider } from './contexts/ActivityContext.js';
import { AppProvider, useAppContext } from './contexts/AppContext.js';
import { useActivityEvent } from './hooks/useActivityEvent.js';
import { ActivityEventType, Config, ToolCallState, Message } from '../types/index.js';
import { InputPrompt } from './components/InputPrompt.js';

/**
 * Props for the App component
 */
export interface AppProps {
  /** Initial configuration */
  config: Config;

  /** Activity stream instance */
  activityStream?: ActivityStream;
}

/**
 * Inner app component that uses contexts
 *
 * This component is wrapped by providers and has access to all context values.
 * It subscribes to activity events and updates the app state accordingly.
 */
const AppContent: React.FC = () => {
  const { state, actions } = useAppContext();
  const { exit } = useApp();

  // Subscribe to tool call start events
  useActivityEvent(ActivityEventType.TOOL_CALL_START, (event) => {
    const toolCall: ToolCallState = {
      id: event.id,
      status: 'executing',
      toolName: event.data.toolName,
      arguments: event.data.arguments,
      startTime: event.timestamp,
    };
    actions.addToolCall(toolCall);
  });

  // Subscribe to tool call end events
  useActivityEvent(ActivityEventType.TOOL_CALL_END, (event) => {
    actions.updateToolCall(event.id, {
      status: event.data.success ? 'success' : 'error',
      endTime: event.timestamp,
      error: event.data.error,
    });

    // Remove from active list after a short delay (for visual feedback)
    setTimeout(() => {
      actions.removeToolCall(event.id);
    }, 1000);
  });

  // Subscribe to tool output chunks
  useActivityEvent(ActivityEventType.TOOL_OUTPUT_CHUNK, (event) => {
    actions.updateToolCall(event.id, {
      output: event.data.chunk,
    });
  });

  // Subscribe to error events
  useActivityEvent(ActivityEventType.ERROR, (event) => {
    actions.updateToolCall(event.id, {
      status: 'error',
      error: event.data.error,
      endTime: event.timestamp,
    });

    // Remove from active list after a short delay
    setTimeout(() => {
      actions.removeToolCall(event.id);
    }, 1000);
  });

  // Handle user input
  const handleInput = (input: string) => {
    const trimmed = input.trim();

    // Exit commands
    if (trimmed === 'exit' || trimmed === 'quit') {
      exit();
      return;
    }

    // Add user message
    if (trimmed) {
      actions.addMessage({
        role: 'user',
        content: trimmed,
      });

      // TODO: Send to agent for processing
      // For now, just echo back
      setTimeout(() => {
        actions.addMessage({
          role: 'assistant',
          content: `Echo: ${trimmed}\n\n(Agent integration coming in Phase 6)`,
        });
      }, 100);
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

      {/* Active Tool Calls */}
      {state.activeToolCalls.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Active Tools:</Text>
          {state.activeToolCalls.map((toolCall) => (
            <Box key={toolCall.id} paddingLeft={2}>
              <Text color="cyan">{toolCall.toolName}</Text>
              <Text dimColor> - {toolCall.status}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Message History */}
      <Box flexDirection="column" flexGrow={1}>
        <Text bold dimColor>
          Messages: {state.messages.length}
        </Text>
        {state.messages.slice(-5).map((msg, idx) => (
          <Box key={idx} paddingLeft={2}>
            <Text color={msg.role === 'user' ? 'green' : 'blue'}>
              {msg.role}:
            </Text>
            <Text dimColor> {msg.content.substring(0, 50)}...</Text>
          </Box>
        ))}
      </Box>

      {/* Input Prompt */}
      <Box marginTop={1}>
        <InputPrompt onSubmit={handleInput} isActive={true} />
      </Box>

      {/* Footer / Help */}
      <Box marginTop={1}>
        <Text dimColor>
          Type 'exit' or 'quit' to exit | Active tools: {state.activeToolCallsCount} | Model: {state.config.model || 'none'}
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
export const App: React.FC<AppProps> = ({ config, activityStream }) => {
  // Create activity stream if not provided
  const streamRef = useRef(activityStream || new ActivityStream());

  return (
    <ActivityProvider activityStream={streamRef.current}>
      <AppProvider initialConfig={config}>
        <AppContent />
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
  initialMessages = [],
}) => {
  const streamRef = useRef(activityStream || new ActivityStream());

  return (
    <ActivityProvider activityStream={streamRef.current}>
      <AppProvider initialConfig={config}>
        <AppContentWithMessages initialMessages={initialMessages} />
      </AppProvider>
    </ActivityProvider>
  );
};

/**
 * Inner component that accepts initial messages
 */
const AppContentWithMessages: React.FC<{ initialMessages: Message[] }> = ({
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

  return <AppContent />;
};

export default App;
