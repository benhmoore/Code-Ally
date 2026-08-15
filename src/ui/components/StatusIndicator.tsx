/** Compact, event-driven activity line for the live UI region. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { TodoManager, TodoItem, getActiveForm } from '@services/TodoManager.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ActivityEventType, ToolCallState } from '@shared/index.js';
import { ProgressIndicator } from './ProgressIndicator.js';
import { formatElapsed } from '../utils/timeUtils.js';
import { getAgentType, getAgentDisplayName } from '@utils/agentTypeUtils.js';
import { setTerminalProgress, clearTerminalProgress } from '@utils/terminal.js';
import { UI_DELAYS } from '@config/constants.js';
import { UI_COLORS } from '../constants/colors.js';

interface StatusIndicatorProps {
  isProcessing: boolean;
  isCompacting?: boolean;
  isCancelling?: boolean;
  activeToolCalls?: ToolCallState[];
  activeSubAgents?: string[];
}

function getActiveAgentName(toolCalls: ToolCallState[]): string | null {
  const ask = toolCalls.find(call => call.status === 'executing' && call.toolName === 'agent-ask');
  if (ask) {
    const id = ask.arguments?.agent_id;
    if (typeof id !== 'string') return 'Assistant';
    try {
      const pool = ServiceRegistry.getInstance().get<any>('agent_pool');
      const metadata = pool?.getAgentMetadata(id);
      return metadata ? getAgentDisplayName(getAgentType(metadata)) : 'Assistant';
    } catch {
      return 'Assistant';
    }
  }

  const direct = toolCalls.find(call => call.status === 'executing' && call.toolName === 'agent');
  const type = direct?.arguments?.agent_type;
  return typeof type === 'string' ? getAgentDisplayName(type) : direct ? 'Agent' : null;
}

/**
 * Layout invariants:
 * - idle renders nothing;
 * - active work occupies exactly one row;
 * - the full todo list is never duplicated into the shell;
 * - elapsed time updates at a calm five-second cadence.
 */
export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  isProcessing,
  isCompacting = false,
  isCancelling = false,
  activeToolCalls = [],
  activeSubAgents = [],
}) => {
  const active = isProcessing || isCompacting || isCancelling;
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const toolCallsRef = useRef(activeToolCalls);

  toolCallsRef.current = activeToolCalls;

  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    setStartedAt(now);
    setElapsedSeconds(0);
  }, [active, isCompacting, isCancelling]);

  useEffect(() => {
    if (!active) return undefined;
    const update = () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, [active, startedAt]);

  useEffect(() => {
    try {
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');
      const activityStream = registry.get<ActivityStream>('activity_stream');
      const refresh = () => setTodos(todoManager?.getTodos() ?? []);
      refresh();
      return activityStream?.subscribe(ActivityEventType.TODO_UPDATE, refresh);
    } catch {
      return undefined;
    }
  }, []);

  // Terminal-tab progress is external to the Ink frame. Polling here does not
  // cause React renders and only emits when the long-running state changes.
  useEffect(() => {
    if (!(isProcessing || isCompacting)) {
      clearTerminalProgress();
      return undefined;
    }
    const update = () => {
      const now = Date.now();
      const longRunning = toolCallsRef.current.some(call => {
        if (call.status !== 'executing') return false;
        return now - (call.executionStartTime || call.startTime) >= UI_DELAYS.TOOL_DURATION_DISPLAY_THRESHOLD;
      });
      if (longRunning) setTerminalProgress(0, 'indeterminate');
      else clearTerminalProgress();
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [isProcessing, isCompacting]);

  useEffect(() => () => clearTerminalProgress(), []);

  const activeAgent = getActiveAgentName(activeToolCalls);
  const currentTodo = todos.find(todo => todo.status === 'in_progress');
  const completedCount = todos.filter(todo => todo.status === 'completed').length;
  const todoProgress = todos.length > 0 ? `${completedCount}/${todos.length}` : null;

  const label = useMemo(() => {
    if (isCancelling) return 'Cancelling';
    if (isCompacting) return 'Compacting conversation';
    if (currentTodo) return getActiveForm(currentTodo.task);
    if (activeAgent) return `Working with ${activeAgent}`;
    if (activeSubAgents.length > 0) {
      return `Working with ${activeSubAgents.map(getAgentDisplayName).join(', ')}`;
    }
    return 'Thinking';
  }, [isCancelling, isCompacting, currentTodo, activeAgent, activeSubAgents]);

  if (!active) return null;

  return (
    <Box paddingLeft={1}>
      <ProgressIndicator type="arc" color={isCancelling ? UI_COLORS.ERROR : UI_COLORS.PRIMARY} />
      <Text color={isCancelling ? UI_COLORS.ERROR : undefined}> {label}</Text>
      {todoProgress && <Text dimColor> · {todoProgress}</Text>}
      <Text dimColor> · {formatElapsed(elapsedSeconds)} · esc interrupt</Text>
    </Box>
  );
};
