/**
 * StatusIndicator - Real-time status display while model is working
 *
 * Shows:
 * [Spinner] [Current task description] (elapsed time)
 *  → Next: [Next task]
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { TodoManager } from '../../services/TodoManager.js';

interface StatusIndicatorProps {
  /** Whether the agent is currently processing */
  isProcessing: boolean;
}

// Static processing indicator
const ProcessingIcon: React.FC = () => {
  return <Text color="cyan">→</Text>;
};

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ isProcessing }) => {
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  const [nextTask, setNextTask] = useState<string | null>(null);
  const [startTime, setStartTime] = useState<number>(Date.now());
  const [, forceUpdate] = useState({});

  // Reset timer when processing starts
  useEffect(() => {
    if (isProcessing) {
      setStartTime(Date.now());
    }
  }, [isProcessing]);

  // Update task status and elapsed time every second (only when processing)
  useEffect(() => {
    if (!isProcessing) return;

    // Function to update todo status
    const updateTodos = () => {
      try {
        const registry = ServiceRegistry.getInstance();
        const todoManager = registry.get<TodoManager>('todo_manager');

        if (todoManager) {
          const inProgress = todoManager.getInProgressTodo();
          const nextPending = todoManager.getNextPendingTodo();

          // Reset timer when task changes
          if (inProgress && currentTask !== inProgress.activeForm) {
            setStartTime(Date.now());
          }

          setCurrentTask(inProgress?.activeForm || null);
          setNextTask(nextPending?.task || null);
        }
      } catch (error) {
        // Silently handle errors to avoid interfering with Ink rendering
      }

      // Force re-render for time updates
      forceUpdate({});
    };

    // Initial update
    updateTodos();

    // Update every second
    const interval = setInterval(updateTodos, 1000);

    return () => clearInterval(interval);
  }, [isProcessing, currentTask]);

  // Don't show if not processing
  if (!isProcessing) {
    return null;
  }

  // Calculate elapsed time (updates every second via forceUpdate)
  const elapsed = Math.floor((Date.now() - startTime) / 1000);

  const formatElapsed = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <Box flexDirection="column">
      {/* Current task */}
      {(currentTask || isProcessing) && (
        <Box>
          <ProcessingIcon />
          <Text> </Text>
          <Text>{currentTask || 'Thinking...'}</Text>
          <Text dimColor> ({formatElapsed(elapsed)})</Text>
        </Box>
      )}

      {/* Next task */}
      {nextTask && (
        <Box marginLeft={2}>
          <Text dimColor>→ Next: </Text>
          <Text dimColor>{nextTask}</Text>
        </Box>
      )}
    </Box>
  );
};
