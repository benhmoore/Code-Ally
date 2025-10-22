/**
 * StatusIndicator - Real-time status display while model is working
 *
 * Shows:
 * [Spinner] [Current task description] (elapsed time)
 *  → Next: [Next task]
 */

import React, { useEffect, useState, useRef } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { TodoManager } from '../../services/TodoManager.js';

interface StatusIndicatorProps {
  /** Whether the agent is currently processing */
  isProcessing: boolean;
  /** Whether the conversation is being compacted */
  isCompacting?: boolean;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ isProcessing, isCompacting }) => {
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  const [nextTask, setNextTask] = useState<string | null>(null);
  const [_startTime, setStartTime] = useState<number>(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  // Use ref to track previous task for comparison without triggering effect re-runs
  const previousTaskRef = useRef<string | null>(null);

  // Reset timer when processing or compacting starts
  useEffect(() => {
    if (isProcessing || isCompacting) {
      setStartTime(Date.now());
      setElapsedSeconds(0);
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
          const newTask = inProgress?.activeForm || null;

          // Reset timer when task changes
          if (newTask && previousTaskRef.current !== newTask) {
            setStartTime(Date.now());
            setElapsedSeconds(0);
            previousTaskRef.current = newTask;
          }

          setCurrentTask(newTask);
          setNextTask(nextPending?.task || null);
        }
      } catch (error) {
        // Silently handle errors to avoid interfering with Ink rendering
      }

      // Update elapsed time
      setElapsedSeconds(prev => prev + 1);
    };

    // Initial update
    updateTodos();

    // Update every second
    const interval = setInterval(updateTodos, 1000);

    return () => clearInterval(interval);
  }, [isProcessing]);

  // Don't show if not processing and not compacting
  if (!isProcessing && !isCompacting) {
    return null;
  }

  // Use elapsed seconds from state
  const elapsed = elapsedSeconds;

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
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
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
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
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
