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
import { IdleMessageGenerator } from '../../services/IdleMessageGenerator.js';
import { ChickAnimation } from './ChickAnimation.js';

interface StatusIndicatorProps {
  /** Whether the agent is currently processing */
  isProcessing: boolean;
  /** Whether the conversation is being compacted */
  isCompacting?: boolean;
  /** Recent messages for context-aware idle messages */
  recentMessages?: Array<{ role: string; content: string }>;
}

const GREETING_MESSAGES = [
  "Hello! Ready to code?",
  "Hi there! Let's build something!",
  "Hey! What are we working on?",
  "Chirp! Ready to help!",
  "Welcome back!",
  "Let's get started!",
  "Ready to assist!",
  "Hi! How can I help?",
];

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ isProcessing, isCompacting, recentMessages = [] }) => {
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  const [_startTime, setStartTime] = useState<number>(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  // Pick a random greeting on mount
  const [initialGreeting] = useState<string>(() => {
    return GREETING_MESSAGES[Math.floor(Math.random() * GREETING_MESSAGES.length)] || "Ready to help!";
  });
  const [idleMessage, setIdleMessage] = useState<string>(initialGreeting);

  // Use ref to track previous task for comparison without triggering effect re-runs
  const previousTaskRef = useRef<string | null>(null);
  const wasProcessingRef = useRef<boolean>(isProcessing);
  const hasStartedRef = useRef<boolean>(false);

  // Reset timer when processing or compacting starts
  useEffect(() => {
    if (isProcessing || isCompacting) {
      setStartTime(Date.now());
      setElapsedSeconds(0);
    }
  }, [isProcessing, isCompacting]);

  const [allTodos, setAllTodos] = useState<Array<{ task: string; status: string; activeForm: string }>>([]);

  // Handle idle message generation when transitioning to idle state
  useEffect(() => {
    const wasProcessing = wasProcessingRef.current;
    wasProcessingRef.current = isProcessing;

    // Mark that processing has started at least once
    if (isProcessing) {
      hasStartedRef.current = true;
    }

    // When transitioning from processing to idle, trigger idle message generation
    if (wasProcessing && !isProcessing && !isCompacting && hasStartedRef.current) {
      try {
        const registry = ServiceRegistry.getInstance();
        const idleMessageGenerator = registry.get<IdleMessageGenerator>('idle_message_generator');

        if (idleMessageGenerator) {
          // Trigger background generation with recent message context
          idleMessageGenerator.generateMessageBackground(recentMessages as any);

          // Poll for updates every second when idle
          const pollInterval = setInterval(() => {
            const message = idleMessageGenerator.getCurrentMessage();
            setIdleMessage(message);
          }, 1000);

          return () => clearInterval(pollInterval);
        }
      } catch (error) {
        // Silently handle errors
      }
    }

    // Return empty cleanup if no interval was created
    return undefined;
  }, [isProcessing, isCompacting, recentMessages]);

  // Update task status and elapsed time every second
  useEffect(() => {
    // Function to update todo status
    const updateTodos = () => {
      try {
        const registry = ServiceRegistry.getInstance();
        const todoManager = registry.get<TodoManager>('todo_manager');

        if (todoManager) {
          const inProgress = todoManager.getInProgressTodo();
          const newTask = inProgress?.activeForm || null;

          // Reset timer when task changes (only when processing)
          if (isProcessing && newTask && previousTaskRef.current !== newTask) {
            setStartTime(Date.now());
            setElapsedSeconds(0);
            previousTaskRef.current = newTask;
          }

          setCurrentTask(newTask);

          // Get all todos for display (reversed order)
          const todos = todoManager.getTodos();
          setAllTodos([...todos].reverse());
        }
      } catch (error) {
        // Silently handle errors to avoid interfering with Ink rendering
      }

      // Update elapsed time only when processing
      if (isProcessing) {
        setElapsedSeconds(prev => prev + 1);
      }
    };

    // Initial update
    updateTodos();

    // Update every second
    const interval = setInterval(updateTodos, 1000);

    return () => clearInterval(interval);
  }, [isProcessing]);

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

  // Get checkbox symbol based on status
  const getCheckbox = (status: string): string => {
    if (status === 'completed') return '☑';
    if (status === 'in_progress') return '☐';
    return '☐';
  };

  return (
    <Box flexDirection="column">
      {/* Status line - always show */}
      <Box>
        {isProcessing || isCompacting ? (
          <>
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
            <Text> </Text>
            <Text>{allTodos.length === 0 ? 'Thinking...' : currentTask || 'Processing...'}</Text>
            <Text dimColor> (ctrl+c to interrupt) </Text>
            <Text dimColor>[{formatElapsed(elapsed)}]</Text>
          </>
        ) : (
          <>
            <ChickAnimation color="yellow" speed={4000} />
            <Text> </Text>
            <Text color="yellow">{idleMessage}</Text>
          </>
        )}
      </Box>

      {/* Todo list with improved display - always show if we have todos */}
      {allTodos.length > 0 && (
        <Box flexDirection="column" marginLeft={3}>
          {allTodos.map((todo, index) => (
            <Box key={index}>
              {/* Arrow for in-progress task */}
              {todo.status === 'in_progress' ? (
                <>
                  <Text color="yellow">-&gt; </Text>
                  <Text color="yellow">{getCheckbox(todo.status)}</Text>
                  <Text> </Text>
                  <Text color="yellow">{todo.task}</Text>
                </>
              ) : (
                <>
                  <Text>   </Text>
                  <Text color={todo.status === 'completed' ? 'green' : 'white'}>
                    {getCheckbox(todo.status)}
                  </Text>
                  <Text> </Text>
                  <Text color={todo.status === 'completed' ? 'green' : 'white'} dimColor={todo.status === 'completed'}>
                    {todo.task}
                  </Text>
                </>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};
