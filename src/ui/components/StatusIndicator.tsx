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
import { TodoManager, TodoItem } from '../../services/TodoManager.js';
import { IdleMessageGenerator } from '../../services/IdleMessageGenerator.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ActivityEventType } from '../../types/index.js';
import { ChickAnimation } from './ChickAnimation.js';
import { formatElapsed } from '../utils/timeUtils.js';
import { getGitBranch } from '../../utils/gitUtils.js';
import { logger } from '../../services/Logger.js';
import * as os from 'os';
import * as path from 'path';
import { ANIMATION_TIMING, POLLING_INTERVALS, BUFFER_SIZES } from '../../config/constants.js';

interface StatusIndicatorProps {
  /** Whether the agent is currently processing */
  isProcessing: boolean;
  /** Whether the conversation is being compacted */
  isCompacting?: boolean;
  /** Whether a user interrupt is in progress */
  isCancelling?: boolean;
  /** Recent messages for context-aware idle messages */
  recentMessages?: Array<{ role: string; content: string }>;
  /** Whether session has finished loading */
  sessionLoaded?: boolean;
  /** Whether we're resuming a session (don't generate new messages) */
  isResuming?: boolean;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ isProcessing, isCompacting, isCancelling = false, recentMessages = [], sessionLoaded = true, isResuming = false }) => {
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  const [_startTime, setStartTime] = useState<number>(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  // Initialize idle message - start with thinking animation
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
            const queuePreview = queue.slice(0, BUFFER_SIZES.DEFAULT_LIST_PREVIEW).map((msg, i) => `${i + 1}. ${msg}`).join('\n  ');
            logger.debug(`[MASCOT] Loaded message from queue on startup (${queueSize} messages available): "${message}"\n  Queue:\n  ${queuePreview}`);
            return message;
          }
        }
      }
    } catch {
      // Fall through to thinking animation
    }

    // Start with thinking animation while messages generate
    return '.';
  });

  // Thinking animation state
  const [thinkingDots, setThinkingDots] = useState<number>(1);

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

  const [allTodos, setAllTodos] = useState<TodoItem[]>([]);

  // Animate thinking dots while waiting for messages
  useEffect(() => {
    // Only animate if showing thinking animation
    if (idleMessage === '.' || idleMessage === '..' || idleMessage === '...') {
      const interval = setInterval(() => {
        setThinkingDots(prev => (prev % 3) + 1);
        setIdleMessage('.'.repeat((thinkingDots % 3) + 1));
      }, ANIMATION_TIMING.THINKING_SPEED);

      return () => clearInterval(interval);
    }
    return undefined;
  }, [idleMessage, thinkingDots]);

  // Generate idle message on startup
  useEffect(() => {
    // Don't generate if session hasn't loaded yet
    if (!sessionLoaded) return;

    // Check if we're resuming and have cached messages
    if (isResuming) {
      try {
        const registry = ServiceRegistry.getInstance();
        const idleMessageGenerator = registry.get<IdleMessageGenerator>('idle_message_generator');
        if (idleMessageGenerator) {
          const queueSize = idleMessageGenerator.getQueueSize();
          const message = idleMessageGenerator.getCurrentMessage();

          // If we have real cached messages, use them
          if (queueSize > 0 && message !== 'Idle' && message !== '.' && message !== '..' && message !== '...') {
            setIdleMessage(message);
            logger.debug(`[MASCOT] Displaying cached message on resume: "${message}"`);
            return; // Don't generate
          }

          // If resuming but no cached messages (old session), show static message
          // Don't generate new ones to avoid model client conflicts
          logger.debug(`[MASCOT] Resuming but no cached messages found, showing static message`);
          setIdleMessage('Ready to help!');
        }
      } catch {
        // Silently handle errors
      }
      return; // Don't generate when resuming
    }

    let fastPollInterval: NodeJS.Timeout | null = null;
    let normalPollInterval: NodeJS.Timeout | null = null;

    const initIdleMessages = async () => {
      try {
        const registry = ServiceRegistry.getInstance();
        const idleMessageGenerator = registry.get<IdleMessageGenerator>('idle_message_generator');
        const todoManager = registry.get<TodoManager>('todo_manager');

        if (idleMessageGenerator) {
          // Get git branch if available
          const gitBranch = getGitBranch() || undefined;

          // Get home directory name
          const homeDir = os.homedir();
          const homeDirectory = path.basename(homeDir);

          // Get session manager
          const sessionManager = registry.get<any>('session_manager');

          // Get or detect project context
          const projectContextDetector = registry.get<any>('project_context_detector');
          let projectContext = undefined;

          if (projectContextDetector) {
            try {
              // Try to load cached context from session first
              const cachedContext = await sessionManager?.getProjectContext();

              if (cachedContext && !projectContextDetector.isStale(cachedContext)) {
                // Use cached context if not stale
                projectContext = cachedContext;
                projectContextDetector.setCached(cachedContext);
              } else {
                // Detect new context if stale or missing
                projectContext = await projectContextDetector.detect();
              }
            } catch {
              // Silently handle errors
            }
          }

          // Gather context for idle message generation
          // Filter out proposed todos (drafts awaiting acceptance)
          const context: any = {
            cwd: process.cwd(),
            todos: todoManager ? todoManager.getTodos().filter(t => t.status !== 'proposed') : [],
            gitBranch,
            homeDirectory,
            projectContext,
          };

          // Check if we need immediate generation
          const needsImmediate = idleMessageGenerator.getQueueSize() <= 1;

          // Trigger background generation with context on startup
          idleMessageGenerator.generateMessageBackground(recentMessages as any, context, needsImmediate);

          // If we triggered immediate generation, poll frequently until first message arrives
          if (needsImmediate) {
            logger.debug(`[MASCOT] Setting up fast polling (needsImmediate=${needsImmediate}, queueSize=${idleMessageGenerator.getQueueSize()})`);
            fastPollInterval = setInterval(() => {
              try {
                const registry = ServiceRegistry.getInstance();
                const idleMessageGenerator = registry.get<IdleMessageGenerator>('idle_message_generator');
                if (idleMessageGenerator) {
                  const message = idleMessageGenerator.getCurrentMessage();
                  const queueSize = idleMessageGenerator.getQueueSize();

                  logger.debug(`[MASCOT] Fast polling check - message: "${message}", queueSize: ${queueSize}`);

                  // Update immediately when first non-default message is available
                  if (message !== 'Idle' && message !== '.' && message !== '..' && message !== '...') {
                    const queue = idleMessageGenerator.getQueue();
                    const queuePreview = queue.slice(0, BUFFER_SIZES.DEFAULT_LIST_PREVIEW).map((msg, i) => `${i + 1}. ${msg}`).join('\n  ');
                    logger.debug(`[MASCOT] Displaying message from queue (${queueSize} messages available): "${message}"\n  Queue:\n  ${queuePreview}`);
                    setIdleMessage(message);
                    // Stop fast polling once we have a real message
                    if (fastPollInterval) {
                      clearInterval(fastPollInterval);
                      fastPollInterval = null;
                    }
                  }
                }
              } catch (err) {
                logger.debug(`[MASCOT] Fast polling error: ${err}`);
              }
            }, POLLING_INTERVALS.STATUS_FAST);
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
            const queuePreview = queue.slice(0, BUFFER_SIZES.DEFAULT_LIST_PREVIEW).map((msg, i) => `${i + 1}. ${msg}`).join('\n  ');
            logger.debug(`[MASCOT] Cycling to next message (${queueSize} messages in queue): "${message}"\n  Queue:\n  ${queuePreview}`);
            setIdleMessage(message);
          }
        }
      } catch {
        // Silently handle errors
      }
    }, POLLING_INTERVALS.STATUS_POLLING);

    return () => {
      if (fastPollInterval) clearInterval(fastPollInterval);
      if (normalPollInterval) clearInterval(normalPollInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionLoaded, isResuming]); // Run when session loads

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

        if (idleMessageGenerator) {
          // Get git branch if available
          const gitBranch = getGitBranch() || undefined;

          // Get home directory name
          const homeDir = os.homedir();
          const homeDirectory = path.basename(homeDir);

          // Get cached project context
          const projectContextDetector = registry.get<any>('project_context_detector');
          const projectContext = projectContextDetector?.getCached();

          // Gather context for idle message generation
          // Filter out proposed todos (drafts awaiting acceptance)
          const context: any = {
            cwd: process.cwd(),
            todos: todoManager ? todoManager.getTodos().filter(t => t.status !== 'proposed') : [],
            gitBranch,
            homeDirectory,
            projectContext,
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

    // Then generate continuously while idle
    const continuousInterval = setInterval(() => {
      generateIdleMessage();
    }, POLLING_INTERVALS.STATUS_POLLING);

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

  // Subscribe to TODO_UPDATE events for immediate todo display updates
  useEffect(() => {
    try {
      const registry = ServiceRegistry.getInstance();
      const activityStream = registry.get<ActivityStream>('activity_stream');
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (activityStream && todoManager) {
        // Update todos immediately when TODO_UPDATE event fires
        const handleTodoUpdate = () => {
          try {
            const todos = todoManager.getTodos();
            setAllTodos([...todos].reverse());

            // Update current task if in progress
            const inProgress = todoManager.getInProgressTodo();
            const newTask = inProgress?.activeForm || null;

            // Reset timer when task changes (only when processing)
            if (isProcessing && newTask && previousTaskRef.current !== newTask) {
              setStartTime(Date.now());
              setElapsedSeconds(0);
              previousTaskRef.current = newTask;
            }

            setCurrentTask(newTask);
          } catch (error) {
            // Silently handle errors
          }
        };

        // Subscribe to TODO_UPDATE events
        const unsubscribe = activityStream.subscribe(ActivityEventType.TODO_UPDATE, handleTodoUpdate);

        return unsubscribe;
      }
    } catch (error) {
      // Silently handle errors
    }
    return undefined;
  }, [isProcessing]);

  // Update task status and elapsed time every second (polling fallback)
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
          // Include proposed todos (they'll be displayed greyed out)
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

    // Update regularly (fallback for edge cases)
    const interval = setInterval(updateTodos, ANIMATION_TIMING.TODO_UPDATE);

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
    if (status === 'proposed') return '◯'; // Empty circle for proposed
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
            <Text dimColor> (esc to interrupt) </Text>
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
            <Box key={index} flexDirection="column">
              {/* Parent todo */}
              <Box>
                {/* Arrow for in-progress task */}
                {todo.status === 'in_progress' ? (
                  <>
                    <Text color="yellow">→ </Text>
                    <Text color="yellow">{getCheckbox(todo.status)}</Text>
                    <Text> </Text>
                    <Text color="yellow">{todo.task}</Text>
                  </>
                ) : todo.status === 'proposed' ? (
                  <>
                    <Text>   </Text>
                    <Text color="gray" dimColor>
                      {getCheckbox(todo.status)}
                    </Text>
                    <Text> </Text>
                    <Text color="gray" dimColor>
                      {todo.task}
                    </Text>
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

              {/* Subtasks with indentation */}
              {todo.subtasks && todo.subtasks.length > 0 && (
                <Box flexDirection="column" marginLeft={6}>
                  {todo.subtasks.map((subtask, subIndex) => (
                    <Box key={subIndex}>
                      {subtask.status === 'in_progress' ? (
                        <>
                          <Text color="yellow">↳ → </Text>
                          <Text color="yellow">{getCheckbox(subtask.status)}</Text>
                          <Text> </Text>
                          <Text color="yellow">{subtask.task}</Text>
                        </>
                      ) : subtask.status === 'proposed' ? (
                        <>
                          <Text color="gray" dimColor>↳   </Text>
                          <Text color="gray" dimColor>
                            {getCheckbox(subtask.status)}
                          </Text>
                          <Text> </Text>
                          <Text color="gray" dimColor>
                            {subtask.task}
                          </Text>
                        </>
                      ) : (
                        <>
                          <Text color={subtask.status === 'completed' ? 'green' : 'white'} dimColor={subtask.status === 'completed'}>↳   </Text>
                          <Text color={subtask.status === 'completed' ? 'green' : 'white'}>
                            {getCheckbox(subtask.status)}
                          </Text>
                          <Text> </Text>
                          <Text color={subtask.status === 'completed' ? 'green' : 'white'} dimColor={subtask.status === 'completed'}>
                            {subtask.task}
                          </Text>
                        </>
                      )}
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};
