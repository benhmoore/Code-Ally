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
import { getGitBranch } from '../../utils/gitUtils.js';
import { logger } from '../../services/Logger.js';
import * as os from 'os';
import * as path from 'path';

interface StatusIndicatorProps {
  /** Whether the agent is currently processing */
  isProcessing: boolean;
  /** Whether the conversation is being compacted */
  isCompacting?: boolean;
  /** Whether a user interrupt is in progress */
  isCancelling?: boolean;
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

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ isProcessing, isCompacting, isCancelling = false, recentMessages = [] }) => {
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  const [_startTime, setStartTime] = useState<number>(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  // Initialize idle message from queue or fallback to generic greeting
  const [idleMessage, setIdleMessage] = useState<string>(() => {
    try {
      const registry = ServiceRegistry.getInstance();
      const idleMessageGenerator = registry.get<IdleMessageGenerator>('idle_message_generator');
      if (idleMessageGenerator) {
        const queueSize = idleMessageGenerator.getQueueSize();
        // If queue has more than just the default 'Idle' message, use it
        if (queueSize > 0) {
          const message = idleMessageGenerator.getCurrentMessage();
          if (message !== 'Idle') {
            const queue = idleMessageGenerator.getQueue();
            const queuePreview = queue.slice(0, 10).map((msg, i) => `${i + 1}. ${msg}`).join('\n  ');
            logger.debug(`[MASCOT] Loaded message from queue on startup (${queueSize} messages available): "${message}"\n  Queue:\n  ${queuePreview}`);
            return message;
          }
        }
      }
    } catch {
      // Fall through to generic greeting
    }

    // Fallback to random generic greeting
    const greeting = GREETING_MESSAGES[Math.floor(Math.random() * GREETING_MESSAGES.length)] || "Ready to help!";
    logger.debug(`[MASCOT] Using generic greeting (queue empty): "${greeting}"`);
    return greeting;
  });

  // Use ref to track previous task for comparison without triggering effect re-runs
  const previousTaskRef = useRef<string | null>(null);
  const wasProcessingRef = useRef<boolean>(isProcessing);
  const hasStartedRef = useRef<boolean>(false);
  const sessionStartTimeRef = useRef<number>(Date.now());

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
    let fastPollInterval: NodeJS.Timeout | null = null;
    let normalPollInterval: NodeJS.Timeout | null = null;

    const initIdleMessages = async () => {
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

          // Get git branch if available
          const gitBranch = getGitBranch() || undefined;

          // Get home directory name
          const homeDir = os.homedir();
          const homeDirectory = path.basename(homeDir);

          // Calculate session duration
          const sessionDuration = Math.floor((Date.now() - sessionStartTimeRef.current) / 1000);

          // Get session count and sessions created today
          const sessionManager = registry.get<any>('session_manager');
          let sessionCount = 0;
          let sessionsToday = 0;
          if (sessionManager && typeof sessionManager.getSessionsInfo === 'function') {
            try {
              const sessions = await sessionManager.getSessionsInfo();
              sessionCount = sessions.length;

              // Count sessions created today
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              const todayTimestamp = today.getTime();

              sessionsToday = sessions.filter((s: any) => {
                const sessionDate = new Date(s.last_modified);
                sessionDate.setHours(0, 0, 0, 0);
                return sessionDate.getTime() === todayTimestamp;
              }).length;
            } catch {
              // Silently handle errors
            }
          }

          // Gather context for idle message generation
          const context: any = {
            cwd: process.cwd(),
            currentTime: new Date(),
            todos: todoManager ? todoManager.getTodos() : [],
            lastUserMessage,
            lastAssistantMessage,
            messageCount: recentMessages.length,
            sessionDuration,
            gitBranch,
            homeDirectory,
            sessionCount,
            sessionsToday,
          };

          // Check if we need immediate generation
          const needsImmediate = idleMessageGenerator.getQueueSize() <= 1;

          // Trigger background generation with context on startup
          idleMessageGenerator.generateMessageBackground(recentMessages as any, context, needsImmediate);

          // If we triggered immediate generation, poll frequently until first message arrives
          if (needsImmediate) {
            fastPollInterval = setInterval(() => {
              try {
                const registry = ServiceRegistry.getInstance();
                const idleMessageGenerator = registry.get<IdleMessageGenerator>('idle_message_generator');
                if (idleMessageGenerator) {
                  const message = idleMessageGenerator.getCurrentMessage();
                  const queueSize = idleMessageGenerator.getQueueSize();

                  // Update immediately when first non-default message is available
                  if (message !== 'Idle') {
                    const queue = idleMessageGenerator.getQueue();
                    const queuePreview = queue.slice(0, 10).map((msg, i) => `${i + 1}. ${msg}`).join('\n  ');
                    logger.debug(`[MASCOT] Displaying message from queue (${queueSize} messages available): "${message}"\n  Queue:\n  ${queuePreview}`);
                    setIdleMessage(message);
                    // Stop fast polling once we have a real message
                    if (fastPollInterval) {
                      clearInterval(fastPollInterval);
                      fastPollInterval = null;
                    }
                  }
                }
              } catch {
                // Silently handle errors
              }
            }, 1000); // Poll every second until first message arrives
          }
        }
      } catch (error) {
        // Silently handle errors
      }
    };

    // Start async initialization
    initIdleMessages();

    // Normal polling - cycle through queue every minute
    normalPollInterval = setInterval(() => {
      try {
        const registry = ServiceRegistry.getInstance();
        const idleMessageGenerator = registry.get<IdleMessageGenerator>('idle_message_generator');
        if (idleMessageGenerator) {
          // Move to next message in queue
          idleMessageGenerator.nextMessage();

          const message = idleMessageGenerator.getCurrentMessage();
          const queueSize = idleMessageGenerator.getQueueSize();

          // Only update if message is not the default "Idle"
          if (message !== 'Idle') {
            const queue = idleMessageGenerator.getQueue();
            const queuePreview = queue.slice(0, 10).map((msg, i) => `${i + 1}. ${msg}`).join('\n  ');
            logger.debug(`[MASCOT] Cycling to next message (${queueSize} messages in queue): "${message}"\n  Queue:\n  ${queuePreview}`);
            setIdleMessage(message);
          }
        }
      } catch {
        // Silently handle errors
      }
    }, 60000); // Cycle every 60 seconds

    return () => {
      if (fastPollInterval) clearInterval(fastPollInterval);
      if (normalPollInterval) clearInterval(normalPollInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

  // Continuous idle message generation - generate new message every minute when idle
  useEffect(() => {
    // Only run when completely idle (not processing, not compacting, and has started at least once)
    if (isProcessing || isCompacting || !hasStartedRef.current) {
      return;
    }

    // Helper function to generate idle message with fresh context
    const generateIdleMessage = async () => {
      try {
        const registry = ServiceRegistry.getInstance();
        const idleMessageGenerator = registry.get<IdleMessageGenerator>('idle_message_generator');
        const todoManager = registry.get<TodoManager>('todo_manager');
        const sessionManager = registry.get<any>('session_manager');

        if (idleMessageGenerator) {
          // Extract last user and assistant messages
          const userMessages = (recentMessages as any[]).filter((m: any) => m.role === 'user');
          const assistantMessages = (recentMessages as any[]).filter((m: any) => m.role === 'assistant');
          const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1].content : undefined;
          const lastAssistantMessage = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1].content : undefined;

          // Get git branch if available
          const gitBranch = getGitBranch() || undefined;

          // Get home directory name
          const homeDir = os.homedir();
          const homeDirectory = path.basename(homeDir);

          // Calculate session duration
          const sessionDuration = Math.floor((Date.now() - sessionStartTimeRef.current) / 1000);

          // Get session count and sessions created today
          let sessionCount = 0;
          let sessionsToday = 0;
          if (sessionManager && typeof sessionManager.getSessionsInfo === 'function') {
            try {
              const sessions = await sessionManager.getSessionsInfo();
              sessionCount = sessions.length;

              // Count sessions created today
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              const todayTimestamp = today.getTime();

              sessionsToday = sessions.filter((s: any) => {
                const sessionDate = new Date(s.last_modified);
                sessionDate.setHours(0, 0, 0, 0);
                return sessionDate.getTime() === todayTimestamp;
              }).length;
            } catch {
              // Silently handle errors
            }
          }

          // Gather context for idle message generation
          const context: any = {
            cwd: process.cwd(),
            currentTime: new Date(),
            todos: todoManager ? todoManager.getTodos() : [],
            lastUserMessage,
            lastAssistantMessage,
            messageCount: recentMessages.length,
            sessionDuration,
            gitBranch,
            homeDirectory,
            sessionCount,
            sessionsToday,
          };

          // Trigger background generation with context
          idleMessageGenerator.generateMessageBackground(recentMessages as any, context);
        }
      } catch (error) {
        // Silently handle errors
      }
    };

    // Generate immediately when becoming idle
    generateIdleMessage();

    // Then generate every 60 seconds while idle
    const continuousInterval = setInterval(() => {
      generateIdleMessage();
    }, 60000); // 60 seconds

    return () => clearInterval(continuousInterval);
  }, [isProcessing, isCompacting, recentMessages]);

  // Track processing state changes to mark when processing has started
  useEffect(() => {
    wasProcessingRef.current = isProcessing;

    // Mark that processing has started at least once
    if (isProcessing) {
      hasStartedRef.current = true;
    }
  }, [isProcessing]);

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

  // Show cancelling status if cancelling (highest priority)
  if (isCancelling) {
    return (
      <Box>
        <ChickAnimation color="red" speed={2000} />
        <Text> </Text>
        <Text color="red">Cancelling...</Text>
      </Box>
    );
  }

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
