/**
 * StatusIndicator - Real-time status display while model is working
 *
 * Shows:
 * [Mascot] [Current task description] (elapsed time)
 *  → Next: [Next task]
 */

import React, { useEffect, useState, useRef } from 'react';
import { Box, Text } from 'ink';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { TodoManager, TodoItem } from '@services/TodoManager.js';
import { IdleMessageGenerator } from '@services/IdleMessageGenerator.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ActivityEventType, ToolCallState } from '@shared/index.js';
import { ChickAnimation } from './ChickAnimation.js';
import { ProgressIndicator } from './ProgressIndicator.js';
import { formatElapsed } from '../utils/timeUtils.js';
import { logger } from '@services/Logger.js';
import { getAgentType, getAgentDisplayName } from '@utils/agentTypeUtils.js';
import { setTerminalProgress, clearTerminalProgress } from '@utils/terminal.js';
import { ANIMATION_TIMING, POLLING_INTERVALS, BUFFER_SIZES, UI_DELAYS } from '@config/constants.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '../constants/colors.js';
import { MarkdownText } from './MarkdownText.js';

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
  /** Active tool calls for detecting agent discussions */
  activeToolCalls?: ToolCallState[];
  /** Active sub-agents (specialized agents currently running) */
  activeSubAgents?: string[];
}

/**
 * Helper function to detect active agent invocations and extract display name
 * Returns agent name if any agent tool is currently executing, null otherwise
 *
 * Handles both:
 * - prompt-agent: Background consultation (extracts agent_id, looks up in pool)
 * - agent: Direct invocation (extracts agent_type from arguments)
 *
 * This shows "Working with [AgentName]..." for any agent execution.
 */
const getActiveAgentName = (toolCalls: ToolCallState[]): string | null => {
  // Check for prompt-agent tool first
  const activeAskAgentTool = toolCalls.find(tc =>
    tc.status === 'executing' && tc.toolName === 'prompt-agent'
  );

  if (activeAskAgentTool) {
    // Extract agent_id from arguments
    const agentId = activeAskAgentTool.arguments?.agent_id;
    if (!agentId || typeof agentId !== 'string') {
      return 'Assistant'; // Fallback if no agent_id
    }

    // Look up agent metadata from pool to determine type
    try {
      const registry = ServiceRegistry.getInstance();
      const agentPoolService = registry.get<any>('agent_pool');

      if (!agentPoolService) {
        return 'Assistant'; // Fallback if pool not available
      }

      const metadata = agentPoolService.getAgentMetadata(agentId);
      if (!metadata) {
        return 'Assistant'; // Fallback if metadata not found
      }

      // Use centralized utility to determine agent type and get display name
      const agentType = getAgentType(metadata);
      return getAgentDisplayName(agentType);
    } catch (error) {
      // Silently handle errors and return fallback
      return 'Assistant';
    }
  }

  // Check for direct agent tool invocation (exclude background agents)
  const activeAgentTool = toolCalls.find(tc =>
    tc.status === 'executing' &&
    tc.toolName === 'agent' &&
    tc.arguments?.run_in_background !== true // Skip background agents
  );

  if (activeAgentTool) {
    // Extract agent_type from arguments
    const agentType = activeAgentTool.arguments?.agent_type;
    if (!agentType || typeof agentType !== 'string') {
      return 'Agent'; // Fallback if no agent_type
    }

    // Get display name for this agent type
    return getAgentDisplayName(agentType);
  }

  // Check for explore/plan tools (exclude background)
  const activeDelegationTool = toolCalls.find(tc =>
    tc.status === 'executing' &&
    (tc.toolName === 'explore' || tc.toolName === 'plan') &&
    tc.arguments?.run_in_background !== true
  );

  if (activeDelegationTool) {
    return getAgentDisplayName(activeDelegationTool.toolName);
  }

  return null;
};

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ isProcessing, isCompacting, isCancelling = false, recentMessages = [], sessionLoaded = true, isResuming = false, activeToolCalls = [], activeSubAgents = [] }) => {
  const [currentTask, setCurrentTask] = useState<string | null>(null);
  const [_startTime, setStartTime] = useState<number>(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  // State for interjection indicator
  const [showInterjectionIndicator, setShowInterjectionIndicator] = useState<boolean>(false);
  const interjectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
        // Start with empty message while messages generate
        return '';
      } else {
        // No idle message generator - use static message
        return 'Idle';
      }
    } catch {
      // Fall back to static idle message on error
      return 'Idle';
    }
  });

  // Use ref to track previous task for comparison without triggering effect re-runs
  const previousTaskRef = useRef<string | null>(null);
  const wasProcessingRef = useRef<boolean>(isProcessing);
  const hasStartedRef = useRef<boolean>(false);
  const recentMessagesRef = useRef(recentMessages);

  // Keep recentMessages ref up to date
  useEffect(() => {
    recentMessagesRef.current = recentMessages;
  }, [recentMessages]);

  // Reset timer when processing or compacting starts
  useEffect(() => {
    if (isProcessing || isCompacting) {
      setStartTime(Date.now());
      setElapsedSeconds(0);
    }
  }, [isProcessing, isCompacting]);

  const [allTodos, setAllTodos] = useState<TodoItem[]>([]);

  // Display idle messages on startup (rotation only - generation handled by IdleTaskCoordinator)
  useEffect(() => {
    // Don't display if session hasn't loaded yet
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
          if (queueSize > 0 && message !== 'Idle') {
            setIdleMessage(message);
            logger.debug(`[MASCOT] Displaying cached message on resume: "${message}"`);
            return;
          }

          // If resuming but no cached messages (old session), show static message
          logger.debug(`[MASCOT] Resuming but no cached messages found, showing static message`);
          setIdleMessage('Ready to help!');
        } else {
          // No idle message generator - use static message
          setIdleMessage('Idle');
        }
      } catch {
        // Silently handle errors
      }
      return;
    }

    // Check if idle message generator exists before setting up rotation
    const registry = ServiceRegistry.getInstance();
    const idleMessageGenerator = registry.get<IdleMessageGenerator>('idle_message_generator');

    if (!idleMessageGenerator) {
      // No generator - set static idle message and skip rotation
      setIdleMessage('Idle');
      return;
    }

    // Rotation polling - cycle through queue every 2 seconds
    const rotationInterval = setInterval(() => {
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
      clearInterval(rotationInterval);
    };
  }, [sessionLoaded, isResuming]); // Run when session loads


  // Track processing state changes to mark when processing has started
  useEffect(() => {
    wasProcessingRef.current = isProcessing;

    // Mark that processing has started at least once
    if (isProcessing) {
      hasStartedRef.current = true;
    }
  }, [isProcessing]);

  // Manage terminal tab progress bar (OSC 9;4)
  // Shows indeterminate progress only during long-running tool calls
  useEffect(() => {
    // Check if any tool call has been executing beyond the display threshold
    const checkLongRunningToolCalls = () => {
      const now = Date.now();
      const hasLongRunningTool = activeToolCalls.some(tc => {
        if (tc.status !== 'executing') return false;
        const startTime = tc.executionStartTime || tc.startTime;
        return (now - startTime) >= UI_DELAYS.TOOL_DURATION_DISPLAY_THRESHOLD;
      });

      if (hasLongRunningTool) {
        setTerminalProgress(0, 'indeterminate');
      } else {
        clearTerminalProgress();
      }
    };

    // Initial check
    checkLongRunningToolCalls();

    // Check every second while processing
    const interval = (isProcessing || isCompacting)
      ? setInterval(checkLongRunningToolCalls, 1000)
      : undefined;

    // Cleanup on unmount or when deps change
    return () => {
      if (interval) clearInterval(interval);
      clearTerminalProgress();
    };
  }, [isProcessing, isCompacting, activeToolCalls]);

  // Subscribe to TODO_UPDATE events for immediate todo display updates
  useEffect(() => {
    try {
      const registry = ServiceRegistry.getInstance();
      const activityStream = registry.get<ActivityStream>('activity_stream');
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (activityStream && todoManager) {
        // Update todos immediately when TODO_UPDATE event fires
        const handleTodoUpdate = async () => {
          try {
            const todos = todoManager.getTodos();
            setAllTodos([...todos].reverse());

            // Update current task if in progress
            const inProgress = todoManager.getInProgressTodo();
            const { getActiveForm } = await import('../../services/TodoManager.js');
            const newTask = inProgress ? getActiveForm(inProgress.task) : null;

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

  // Subscribe to USER_INTERJECTION events to show acknowledgment indicator
  useEffect(() => {
    try {
      const registry = ServiceRegistry.getInstance();
      const activityStream = registry.get<ActivityStream>('activity_stream');

      if (activityStream) {
        const handleUserInterjection = () => {
          // Clear any existing timeout
          if (interjectionTimeoutRef.current) {
            clearTimeout(interjectionTimeoutRef.current);
          }

          // Show the indicator
          setShowInterjectionIndicator(true);

          // Auto-dismiss after 5 seconds
          interjectionTimeoutRef.current = setTimeout(() => {
            setShowInterjectionIndicator(false);
            interjectionTimeoutRef.current = null;
          }, 5000);
        };

        // Subscribe to USER_INTERJECTION events
        const unsubscribe = activityStream.subscribe(
          ActivityEventType.USER_INTERJECTION,
          handleUserInterjection
        );

        // Cleanup on unmount
        return () => {
          unsubscribe();
          if (interjectionTimeoutRef.current) {
            clearTimeout(interjectionTimeoutRef.current);
          }
        };
      }
    } catch (error) {
      // Silently handle errors
    }
    return undefined;
  }, []);

  // Update task status and elapsed time every second (polling fallback)
  useEffect(() => {
    // Function to update todo status
    const updateTodos = async () => {
      try {
        const registry = ServiceRegistry.getInstance();
        const todoManager = registry.get<TodoManager>('todo_manager');

        if (todoManager) {
          const inProgress = todoManager.getInProgressTodo();
          const { getActiveForm } = await import('../../services/TodoManager.js');
          const newTask = inProgress ? getActiveForm(inProgress.task) : null;

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

  // Detect if we're working with an agent (prompt-agent or direct agent tool)
  const activeAgentName = getActiveAgentName(activeToolCalls);

  // Show cancelling status if cancelling (highest priority)
  if (isCancelling) {
    return (
      <Box paddingLeft={2}>
        <ProgressIndicator type="arc" color={UI_COLORS.ERROR} />
        <Text> </Text>
        <Text color={UI_COLORS.ERROR}>Cancelling</Text>
      </Box>
    );
  }

  // Show compaction status if compacting (overrides todo display)
  if (isCompacting) {
    return (
      <Box paddingLeft={2}>
        <ProgressIndicator type="arc" color={UI_COLORS.PRIMARY} />
        <Text> </Text>
        <Text color={UI_COLORS.PRIMARY}>Compacting conversation</Text>
        <Text dimColor> ({formatElapsed(elapsed)})</Text>
      </Box>
    );
  }

  // Get checkbox symbol based on status
  const getCheckbox = (status: string): string => {
    if (status === 'completed') return UI_SYMBOLS.TODO.CHECKED;
    if (status === 'in_progress') return UI_SYMBOLS.TODO.UNCHECKED;
    if (status === 'proposed') return UI_SYMBOLS.TODO.PROPOSED;
    return UI_SYMBOLS.TODO.UNCHECKED;
  };

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {/* Status line */}
      <Box>
        {/* Interjection acknowledgment indicator (prepended to left) */}
        {showInterjectionIndicator && (
          <>
            <Text color={UI_COLORS.PRIMARY}>Interjection received</Text>
            <Text> · </Text>
          </>
        )}

        {/* Show mascot only when idle */}
        {!(isProcessing || isCompacting) && (
          <>
            <ChickAnimation color={UI_COLORS.PRIMARY} speed={4000} />
            <Text> </Text>
          </>
        )}
        {isProcessing || isCompacting ? (
          <>
            <ProgressIndicator
              type={activeAgentName ? 'dots' : 'arc'}
              color={UI_COLORS.PRIMARY}
            />
            <Text> </Text>
            {activeAgentName || activeSubAgents.length > 0 ? (
              <>
                <Text>Working with </Text>
                <Text color={UI_COLORS.PRIMARY} bold>
                  {activeAgentName || activeSubAgents.map(getAgentDisplayName).join(', ')}
                </Text>
                {activeSubAgents.length > 1 && (
                  <Text dimColor> ({activeSubAgents.length} agents)</Text>
                )}
                <Text>...</Text>
              </>
            ) : (
              <Text>
                {allTodos.length === 0 ? 'Thinking' : currentTask || 'Processing'}
              </Text>
            )}
            <Text dimColor> (esc to interrupt · {formatElapsed(elapsed)})</Text>
          </>
        ) : (
          <Box>
            <MarkdownText content={idleMessage} />
          </Box>
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
                    <Text color={UI_COLORS.PRIMARY}>→ </Text>
                    <Text color={UI_COLORS.PRIMARY}>{getCheckbox(todo.status)}</Text>
                    <Text> </Text>
                    <Text color={UI_COLORS.PRIMARY}>{todo.task}</Text>
                  </>
                ) : (
                  <>
                    <Text>   </Text>
                    <Text color={todo.status === 'completed' ? UI_COLORS.TEXT_DEFAULT : UI_COLORS.TEXT_DEFAULT}>
                      {getCheckbox(todo.status)}
                    </Text>
                    <Text> </Text>
                    <Text color={todo.status === 'completed' ? UI_COLORS.TEXT_DEFAULT : UI_COLORS.TEXT_DEFAULT} dimColor={todo.status === 'completed'}>
                      {todo.task}
                    </Text>
                  </>
                )}
              </Box>

              {/* Subtasks removed in simplified todo system */}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};
