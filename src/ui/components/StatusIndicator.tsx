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
  const [elapsed, setElapsed] = useState<number>(0);

  // Reset timer when processing starts
  useEffect(() => {
    if (isProcessing) {
      setStartTime(Date.now());
      setElapsed(0);
    }
  }, [isProcessing]);

  // Poll for todo updates
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
            setStartTime(Date.now());
            setElapsed(0);
          }

          setCurrentTask(inProgress?.activeForm || null);
          setNextTask(nextPending?.task || null);
        }
      } catch (error) {
        console.error('[StatusIndicator] Error:', error);
      }
    };

    updateStatus();
    const interval = setInterval(updateStatus, 1000);

    return () => clearInterval(interval);
  }, [currentTask]);

  // Update elapsed time
  useEffect(() => {
    if (!isProcessing && !currentTask) return;

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [isProcessing, currentTask, startTime]);

  // Don't show if not processing and no task
  if (!isProcessing && !currentTask) {
    return null;
  }

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
