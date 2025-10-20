/**
 * Concurrent Tools Example
 *
 * Demonstrates the killer feature: Gemini-CLI-style concurrent tool visualization.
 * This example shows how multiple tools execute in parallel with independent displays.
 */

import React, { useState, useEffect } from 'react';
import { render, Box, Text } from 'ink';
import { ToolGroupMessage } from '../components/ToolGroupMessage';
import { ToolCallState } from '../../types';

// Generate a random ID
const generateId = () => Math.random().toString(36).substring(7);

// Simulate tool execution with delays
const simulateToolExecution = async (
  toolCall: ToolCallState,
  updateState: (id: string, updates: Partial<ToolCallState>) => void
): Promise<void> => {
  // Validating phase (500ms)
  updateState(toolCall.id, { status: 'validating' });
  await new Promise(resolve => setTimeout(resolve, 500));

  // Executing phase with streaming output
  updateState(toolCall.id, {
    status: 'executing',
    output: '',
  });

  const outputLines = [
    'Starting execution...',
    'Initializing dependencies...',
    'Processing data...',
    'Computing results...',
    'Finalizing output...',
    'Cleaning up resources...',
  ];

  // Simulate streaming output
  for (let i = 0; i < outputLines.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

    const currentOutput = outputLines.slice(0, i + 1).join('\n');
    updateState(toolCall.id, { output: currentOutput });
  }

  // Complete (random success/error)
  const isSuccess = Math.random() > 0.2; // 80% success rate

  if (isSuccess) {
    updateState(toolCall.id, {
      status: 'success',
      endTime: Date.now(),
      output: outputLines.join('\n') + '\n✓ Completed successfully',
    });
  } else {
    updateState(toolCall.id, {
      status: 'error',
      endTime: Date.now(),
      error: 'Simulated error occurred',
      output:
        outputLines.slice(0, 3).join('\n') + '\n✕ Error: Operation failed',
    });
  }
};

const ConcurrentToolsExample: React.FC = () => {
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([]);

  // Update a specific tool's state
  const updateToolState = (id: string, updates: Partial<ToolCallState>) => {
    setToolCalls(prev =>
      prev.map(tc => (tc.id === id ? { ...tc, ...updates } : tc))
    );
  };

  // Initialize concurrent tools
  useEffect(() => {
    const tools: ToolCallState[] = [
      {
        id: generateId(),
        status: 'pending',
        toolName: 'BashTool',
        arguments: { command: 'npm install' },
        startTime: Date.now(),
      },
      {
        id: generateId(),
        status: 'pending',
        toolName: 'ReadTool',
        arguments: { file_path: '/path/to/large/file.txt' },
        startTime: Date.now(),
      },
      {
        id: generateId(),
        status: 'pending',
        toolName: 'GrepTool',
        arguments: { pattern: 'TODO', path: './src' },
        startTime: Date.now(),
      },
      {
        id: generateId(),
        status: 'pending',
        toolName: 'GlobTool',
        arguments: { pattern: '**/*.ts' },
        startTime: Date.now(),
      },
    ];

    setToolCalls(tools);

    // Start all tools concurrently
    tools.forEach(tool => {
      simulateToolExecution(tool, updateToolState);
    });
  }, []);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Concurrent Tools Visualization Demo
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>
          This demonstrates Gemini-CLI-style concurrent tool execution with
          independent displays.
        </Text>
      </Box>

      {toolCalls.length > 0 && <ToolGroupMessage toolCalls={toolCalls} />}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Press Ctrl+C to exit
        </Text>
      </Box>
    </Box>
  );
};

// Run the example if this file is executed directly
if (require.main === module) {
  render(<ConcurrentToolsExample />);
}

export default ConcurrentToolsExample;
