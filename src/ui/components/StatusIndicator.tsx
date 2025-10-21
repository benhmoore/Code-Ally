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
import { AnimationTicker } from '../../services/AnimationTicker.js';

interface StatusIndicatorProps {
  /** Whether the agent is currently processing */
  isProcessing: boolean;
}

// Synchronized spinner component
const SyncedSpinner: React.FC = () => {
  const [, forceUpdate] = useState({});
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const ticker = AnimationTicker.getInstance();

  useEffect(() => {
    const unsubscribe = ticker.subscribe(() => {
      forceUpdate({});
    });
    return unsubscribe;
  }, [ticker]);

  const frame = ticker.getFrame() % frames.length;

  return <Text color="cyan">{frames[frame]}</Text>;
};

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ isProcessing }) => {
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  const [nextTask, setNextTask] = useState<string | null>(null);
  const [startTime, setStartTime] = useState<number>(Date.now());
  const ticker = AnimationTicker.getInstance();
  const [, forceUpdate] = useState({});

  // Reset timer when processing starts
  useEffect(() => {
    if (isProcessing) {
      setStartTime(ticker.getCurrentTime());
    }
  }, [isProcessing, ticker]);

  // Subscribe to global ticker for coordinated updates
  // This replaces TWO separate intervals with ONE synchronized tick
  useEffect(() => {
    const updateStatus = () => {
      try {
        const registry = ServiceRegistry.getInstance();
        const todoManager = registry.get<TodoManager>('todo_manager');

        if (todoManager) {
          const inProgress = todoManager.getInProgressTodo();
          const nextPending = todoManager.getNextPendingTodo();

          // Reset timer when task changes
          if (inProgress && currentTask !== inProgress.activeForm) {
            setStartTime(ticker.getCurrentTime());
          }

          setCurrentTask(inProgress?.activeForm || null);
          setNextTask(nextPending?.task || null);
        }
      } catch (error) {
        console.error('[StatusIndicator] Error:', error);
      }

      // Trigger re-render for time updates
      forceUpdate({});
    };

    // Initial update
    updateStatus();

    // Subscribe to global ticker (only if processing or has task)
    if (isProcessing || currentTask) {
      const unsubscribe = ticker.subscribe(updateStatus);
      return unsubscribe;
    }

    return undefined;
  }, [isProcessing, currentTask, ticker]);

  // Don't show if not processing and no task
  if (!isProcessing && !currentTask) {
    return null;
  }

  // Calculate elapsed time from global ticker (not Date.now())
  const elapsed = Math.floor((ticker.getCurrentTime() - startTime) / 1000);

  const formatElapsed = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Current task */}
      {(currentTask || isProcessing) && (
        <Box>
          <SyncedSpinner />
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
