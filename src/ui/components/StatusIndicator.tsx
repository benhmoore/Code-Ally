/**
 * StatusIndicator - Real-time status display while model is working
 *
 * Shows:
 * [Mascot] [Current task description] (elapsed time)
 *  → Next: [Next task]
 */

import React, { useEffect, useState, useRef } from 'react';
import { Box, Text } from 'ink';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { TodoManager } from '../../services/TodoManager.js';
import { IdleMessageGenerator } from '../../services/IdleMessageGenerator.js';
import { ChickAnimation } from './ChickAnimation.js';
import { formatElapsed } from '../utils/timeUtils.js';

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

  // Generate idle message on startup
  useEffect(() => {
    try {
      const registry = ServiceRegistry.getInstance();
      const idleMessageGenerator = registry.get<IdleMessageGenerator>('idle_message_generator');
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (idleMessageGenerator) {
        // Extract last user and assistant messages
        const userMessages = (recentMessages as any[]).filter((m: any) => m.role === 'user');
        const assistantMessages = (recentMessages as any[]).filter((m: any) => m.role === 'assistant');
        const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : undefined;
        const lastAssistantMessage = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1].content : undefined;

        // Gather context for idle message generation
        const context: any = {
          cwd: process.cwd(),
          currentTime: new Date(),
          todos: todoManager ? todoManager.getTodos() : [],
          lastUserMessage,
          lastAssistantMessage,
        };

        // Trigger background generation with context on startup
        idleMessageGenerator.generateMessageBackground(recentMessages as any, context);

        // Poll for updates every second
        const pollInterval = setInterval(() => {
          const message = idleMessageGenerator.getCurrentMessage();
          // Only update if message is not the default "Idle"
          if (message !== 'Idle') {
            setIdleMessage(message);
          }
        }, 1000);

        return () => clearInterval(pollInterval);
      }
    } catch (error) {
      // Silently handle errors
    }

    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

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
        const todoManager = registry.get<TodoManager>('todo_manager');

        if (idleMessageGenerator) {
          // Extract last user and assistant messages
          const userMessages = (recentMessages as any[]).filter((m: any) => m.role === 'user');
          const assistantMessages = (recentMessages as any[]).filter((m: any) => m.role === 'assistant');
          const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : undefined;
          const lastAssistantMessage = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1].content : undefined;

          // Gather context for idle message generation
          const context: any = {
            cwd: process.cwd(),
            currentTime: new Date(),
            todos: todoManager ? todoManager.getTodos() : [],
            lastUserMessage,
            lastAssistantMessage,
          };

          // Trigger background generation with context
          idleMessageGenerator.generateMessageBackground(recentMessages as any, context);

          // Note: Polling is already set up by the startup effect
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

  // Show compaction status if compacting (overrides todo display)
  if (isCompacting) {
    return (
      <Box>
        <ChickAnimation color="cyan" speed={4000} />
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
      {/* Status line - always show mascot */}
      <Box>
        <ChickAnimation color="yellow" speed={4000} />
        <Text> </Text>
        {isProcessing || isCompacting ? (
          <>
            <Text>{allTodos.length === 0 ? 'Thinking...' : currentTask || 'Processing...'}</Text>
            <Text dimColor> (ctrl+c to interrupt) </Text>
            <Text dimColor>[{formatElapsed(elapsed)}]</Text>
          </>
        ) : (
          <Text color="yellow">{idleMessage}</Text>
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
                  <Text color="yellow">→ </Text>
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
