/**
 * BasicExample - Example usage of the foundation UI system
 *
 * This file demonstrates how to use the contexts, hooks, and App component
 * to build a simple Code Ally UI.
 */

import React from 'react';
import { render } from 'ink';
import { App } from '../App.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ActivityEventType } from '../../types/index.js';
import type { Config } from '../../types/index.js';

/**
 * Example: Basic App Setup
 *
 * Shows the minimal setup needed to render the Code Ally UI.
 */
async function basicExample() {
  // Sample configuration
  const config: Config = {
    model: 'qwen2.5-coder:7b',
    endpoint: 'http://localhost:11434',
    context_size: 32768,
    temperature: 0.7,
    max_tokens: 4096,
    bash_timeout: 300000,
    auto_confirm: false,
    check_context_msg: true,
    parallel_tools: true,
    theme: 'dark',
    compact_threshold: 50,
    show_token_usage: true,
    show_context_in_prompt: true,
    tool_result_preview_lines: 10,
    tool_result_preview_enabled: true,
    diff_display_enabled: true,
    diff_display_max_file_size: 102400,
    diff_display_context_lines: 3,
    diff_display_theme: 'auto',
    diff_display_color_removed: '',
    diff_display_color_added: '',
    diff_display_color_modified: '',
    tool_result_max_tokens_normal: 1000,
    tool_result_max_tokens_moderate: 750,
    tool_result_max_tokens_aggressive: 500,
    tool_result_max_tokens_critical: 200,
    setup_completed: true,
  };

  // Create activity stream
  const activityStream = new ActivityStream();

  // Render the app
  const { unmount } = render(<App config={config} activityStream={activityStream} />);

  // Simulate some activity after a delay
  setTimeout(() => {
    // Emit a tool call start event
    activityStream.emit({
      id: 'tool-1',
      type: ActivityEventType.TOOL_CALL_START,
      timestamp: Date.now(),
      data: {
        toolName: 'BashTool',
        arguments: { command: 'ls -la' },
      },
    });

    // Simulate tool output
    setTimeout(() => {
      activityStream.emit({
        id: 'tool-1',
        type: ActivityEventType.TOOL_OUTPUT_CHUNK,
        timestamp: Date.now(),
        data: {
          chunk: 'total 64\ndrwxr-xr-x  10 user  staff  320 Oct 20 10:00 .\n',
        },
      });
    }, 1000);

    // Simulate tool completion
    setTimeout(() => {
      activityStream.emit({
        id: 'tool-1',
        type: ActivityEventType.TOOL_CALL_END,
        timestamp: Date.now(),
        data: {
          success: true,
          result: { output: 'Command completed successfully' },
        },
      });
    }, 2000);
  }, 1000);

  // Cleanup after 5 seconds
  setTimeout(() => {
    unmount();
    process.exit(0);
  }, 5000);
}

/**
 * Example: Using Hooks in a Custom Component
 *
 * Shows how to use the provided hooks in your own components.
 */
import { Box, Text } from 'ink';
import { useActivityEvent } from '../hooks/useActivityEvent.js';
import { useToolState } from '../hooks/useToolState.js';
import { useAnimation } from '../hooks/useAnimation.js';

const CustomToolMonitor: React.FC<{ toolCallId: string }> = ({ toolCallId }) => {
  const toolState = useToolState(toolCallId);
  const animation = useAnimation({ autoStart: true });

  return (
    <Box flexDirection="column" borderStyle="round" padding={1}>
      <Text bold>Tool Monitor</Text>
      <Text>
        Status: <Text color={toolState.status === 'success' ? 'green' : 'yellow'}>
          {toolState.status}
        </Text>
      </Text>
      <Text>Elapsed: {animation.elapsedSeconds}s</Text>
      {toolState.output && <Text dimColor>{toolState.output.substring(0, 100)}</Text>}
      {toolState.error && <Text color="red">Error: {toolState.error}</Text>}
    </Box>
  );
};

const CustomActivityLogger: React.FC = () => {
  const [events, setEvents] = React.useState<string[]>([]);

  // Subscribe to all events
  useActivityEvent('*', (event) => {
    const log = `[${event.type}] ${event.id}`;
    setEvents((prev) => [...prev.slice(-10), log]); // Keep last 10 events
  });

  return (
    <Box flexDirection="column" borderStyle="single" padding={1}>
      <Text bold>Activity Log</Text>
      {events.map((log, idx) => (
        <Text key={idx} dimColor>
          {log}
        </Text>
      ))}
    </Box>
  );
};

/**
 * Run the basic example if this file is executed directly
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  basicExample().catch((error) => {
    console.error('Error running example:', error);
    process.exit(1);
  });
}

export { basicExample, CustomToolMonitor, CustomActivityLogger };
