/** Compact, event-driven activity line for the live UI region. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { TodoItem, getActiveForm } from '@services/TodoManager.js';
import { ActivityEventType, ToolCallState } from '@shared/index.js';
import { ProgressIndicator } from './ProgressIndicator.js';
import { FreshnessLabel } from './FreshnessLabel.js';
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
      const pool = ServiceRegistry.getInstance().get('agent_pool');
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
  const [awaitingModel, setAwaitingModel] = useState(false);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const toolCallsRef = useRef(activeToolCalls);
  const lastOutputAtRef = useRef(Date.now());
  // "Waiting on the model", which starts at the turn, not at the request: prompt
  // assembly sits between the two, and treating that gap as ordinary work
  // flashed a full-strength row for a beat before the wait state took over.
  const waitingForOutputRef = useRef(false);
  const activeRef = useRef(false);

  toolCallsRef.current = activeToolCalls;

  /**
   * Milliseconds since the model last produced anything, or null when freshness
   * says nothing useful — between requests, and while tools are running, where
   * minutes of silence are entirely normal.
   */
  const getSilenceMs = React.useCallback(
    () => (waitingForOutputRef.current ? Date.now() - lastOutputAtRef.current : null),
    []
  );

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
      const todoManager = registry.get('todo_manager');
      const activityStream = registry.get('activity_stream');
      const refresh = () => setTodos(todoManager?.getTodos() ?? []);
      refresh();
      return activityStream?.subscribe(ActivityEventType.TODO_UPDATE, refresh);
    } catch {
      return undefined;
    }
  }, []);

  // Distinguish "request is out, backend has sent nothing back" from "tokens are
  // arriving". Prefill on a large prompt can run for minutes with an identical
  // spinner otherwise, which reads as a hang. Events without a parentId are the
  // main agent's; a delegated agent's request must not change this row, which is
  // already describing the delegation.
  useEffect(() => {
    try {
      const activityStream = ServiceRegistry.getInstance().get('activity_stream');
      if (!activityStream) return undefined;

      const unsubscribes = [
        activityStream.subscribe(ActivityEventType.MODEL_REQUEST_START, (event) => {
          if (event.parentId) return;
          setAwaitingModel(true);
          waitingForOutputRef.current = true;
        }),
        activityStream.subscribe(ActivityEventType.MODEL_REQUEST_END, (event) => {
          if (event.parentId) return;
          setAwaitingModel(false);
          waitingForOutputRef.current = false;
        }),
        ...[ActivityEventType.ASSISTANT_CHUNK, ActivityEventType.THOUGHT_CHUNK].map(eventType =>
          activityStream.subscribe(eventType, (event) => {
            // Synthetic status events carry no chunk; only real output counts.
            const chunk = (event.data as { chunk?: unknown } | undefined)?.chunk;
            if (!event.parentId && typeof chunk === 'string' && chunk.length > 0) {
              setAwaitingModel(false);
              // Refs, not state: this fires per chunk, and the label reads it on
              // the shared animation tick instead of re-rendering the whole row.
              lastOutputAtRef.current = Date.now();
            }
          })
        ),
      ];

      return () => unsubscribes.forEach(unsubscribe => unsubscribe?.());
    } catch {
      return undefined;
    }
  }, []);

  // A turn opens in the waiting state - nothing has been received yet - and a
  // turn that ends between a request's start and its end (interrupt, error) must
  // not leave the row blinking or fading.
  //
  // Adjusted during render rather than in an effect on purpose: an effect runs
  // after the frame it belongs to has already been written, so the first frame
  // of every turn was painted in the live state before the wait state replaced
  // it - the full-white flash. React re-renders before committing instead.
  if (activeRef.current !== active) {
    activeRef.current = active;
    waitingForOutputRef.current = active;
    if (active) {
      // Silence is measured from here, so a long prefill fades the label too.
      lastOutputAtRef.current = Date.now();
    }
    setAwaitingModel(active);
  }

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

  // A grey hollow circle flashing on and off while the request is out with
  // nothing back; the yellow arc means output is actually arriving.
  const showBlink = awaitingModel && !isCancelling && !isCompacting;

  if (!active) return null;

  return (
    <Box paddingLeft={1}>
      <ProgressIndicator
        type={showBlink ? 'blink' : 'arc'}
        color={
          isCancelling ? UI_COLORS.ERROR : showBlink ? UI_COLORS.TEXT_DIM : UI_COLORS.PRIMARY
        }
      />
      <FreshnessLabel
        text={label}
        getSilenceMs={getSilenceMs}
        color={isCancelling ? UI_COLORS.ERROR : undefined}
        dimmed={showBlink}
      />
      {todoProgress && <Text dimColor> · {todoProgress}</Text>}
      <Text dimColor> · {formatElapsed(elapsedSeconds)} · esc interrupt</Text>
    </Box>
  );
};
