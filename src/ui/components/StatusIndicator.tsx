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
  /** Whether the conversation is being compacted */
  isCompacting?: boolean;
}

// Static processing indicator
const ProcessingIcon: React.FC = () => {
  return <Text color="cyan">→</Text>;
};

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ isProcessing, isCompacting }) => {
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  const [nextTask, setNextTask] = useState<string | null>(null);
  const [startTime, setStartTime] = useState<number>(Date.now());
  const [, forceUpdate] = useState({});

  // Reset timer when processing or compacting starts
  useEffect(() => {
    if (isProcessing || isCompacting) {
      setStartTime(Date.now());
    }
  }, [isProcessing, isCompacting]);

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

  // Don't show if not processing and not compacting
  if (!isProcessing && !isCompacting) {
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

  // Show compaction status if compacting (overrides todo display)
  if (isCompacting) {
    return (
      <Box>
        <ProcessingIcon />
        <Text> </Text>
        <Text color="cyan">Compacting conversation...</Text>
        <Text dimColor> ({formatElapsed(elapsed)})</Text>
      </Box>
    );
  }

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
