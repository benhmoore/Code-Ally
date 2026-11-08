/** Compact, event-driven activity line for the live UI region. */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { TodoItem } from '@services/TodoManager.js';
import { ActivityEventType, ToolCallState } from '@shared/index.js';
import { ProgressIndicator } from './ProgressIndicator.js';
import { FreshnessLabel } from './FreshnessLabel.js';
import { formatElapsed } from '../utils/timeUtils.js';
import { setTerminalProgress, clearTerminalProgress } from '@utils/terminal.js';
import { UI_DELAYS } from '@config/constants.js';
import { UI_COLORS } from '../constants/colors.js';
import type { ActivityStream } from '@services/ActivityStream.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { truncateAnsiToWidth, visibleLength } from '@utils/terminalText.js';

interface StatusIndicatorProps {
  isProcessing: boolean;
  isCompacting?: boolean;
  isCancelling?: boolean;
  activeToolCalls?: ToolCallState[];
  awaitingHuman?: 'approval' | 'input';
  activityStream?: ActivityStream;
  hideTodos?: boolean;
}

/** Only the selected conversation's own executing tools describe its work.
 * Nested child calls and background fleet activity never imply foreground waiting. */
const isOwnCall = (call: ToolCallState, parentId?: string) => !call.parentId || call.parentId === parentId;

export function foregroundWorkLabel(toolCalls: ToolCallState[], parentId?: string): string | undefined {
  const executing = toolCalls.filter(call => isOwnCall(call, parentId) && call.status === 'executing');
  const wait = executing.find(call => call.toolName === 'wait');
  if (wait) {
    const ids: unknown = wait.arguments?.task_ids;
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === 'string' && id.startsWith('agent-'))
      ? ids.length === 1
        ? 'Waiting for agent'
        : 'Waiting for agents'
      : 'Waiting';
  }
  return executing.length > 0 ? 'Running tools' : undefined;
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
  awaitingHuman,
  activityStream: selectedActivityStream,
  hideTodos = false,
}) => {
  const ownParentId = selectedActivityStream?.getParentId();
  const active = isProcessing || isCompacting || isCancelling;
  const width = useContentWidth();
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
    () =>
      !awaitingHuman &&
      waitingForOutputRef.current &&
      !toolCallsRef.current.some(call => isOwnCall(call, ownParentId) && call.status === 'executing')
        ? Date.now() - lastOutputAtRef.current
        : null,
    [awaitingHuman, ownParentId]
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
      const activityStream = selectedActivityStream ?? registry.get('activity_stream');
      if (hideTodos) {
        setTodos([]);
        return undefined;
      }
      const refresh = () => setTodos(todoManager?.getTodos() ?? []);
      refresh();
      return activityStream?.subscribe(ActivityEventType.TODO_UPDATE, refresh);
    } catch {
      return undefined;
    }
  }, [hideTodos, selectedActivityStream]);

  // Distinguish "request is out, backend has sent nothing back" from "tokens are
  // arriving". Prefill on a large prompt can run for minutes with an identical
  // spinner otherwise, which reads as a hang. Events without a parentId are the
  // main agent's; a delegated agent's request must not change this row, which is
  // already describing the delegation.
  useEffect(() => {
    try {
      const activityStream = selectedActivityStream ?? ServiceRegistry.getInstance().get('activity_stream');
      if (!activityStream) return undefined;
      const accepts = (event: { parentId?: string }) =>
        !event.parentId || event.parentId === activityStream.getParentId();

      const unsubscribes = [
        activityStream.subscribe(ActivityEventType.MODEL_REQUEST_START, event => {
          if (!accepts(event)) return;
          setAwaitingModel(true);
          waitingForOutputRef.current = true;
        }),
        activityStream.subscribe(ActivityEventType.MODEL_REQUEST_END, event => {
          if (!accepts(event)) return;
          setAwaitingModel(false);
          waitingForOutputRef.current = false;
        }),
        activityStream.subscribe(ActivityEventType.MODEL_STREAM_RESET, event => {
          if (!accepts(event)) return;
          setAwaitingModel(true);
          waitingForOutputRef.current = true;
        }),
        ...[ActivityEventType.ASSISTANT_CHUNK, ActivityEventType.THOUGHT_CHUNK].map(eventType =>
          activityStream.subscribe(eventType, event => {
            // Synthetic status events carry no chunk; only real output counts.
            const chunk = (event.data as { chunk?: unknown } | undefined)?.chunk;
            if (accepts(event) && typeof chunk === 'string' && chunk.length > 0) {
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
  }, [selectedActivityStream]);

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
        if (!isOwnCall(call, ownParentId) || call.status !== 'executing' || call.executionStartTime === undefined)
          return false;
        return now - call.executionStartTime >= UI_DELAYS.TOOL_DURATION_DISPLAY_THRESHOLD;
      });
      if (longRunning) setTerminalProgress(0, 'indeterminate');
      else clearTerminalProgress();
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [isProcessing, isCompacting, ownParentId]);

  useEffect(() => () => clearTerminalProgress(), []);

  const completedCount = todos.filter(todo => todo.status === 'completed').length;
  const todoProgress = todos.length > 0 ? `${completedCount}/${todos.length}` : null;
  const workLabel = foregroundWorkLabel(activeToolCalls, ownParentId);
  const label = isCancelling
    ? 'Cancelling'
    : isCompacting
      ? 'Compacting conversation'
      : awaitingHuman === 'approval'
        ? 'Awaiting approval'
        : awaitingHuman === 'input'
          ? 'Awaiting input'
          : (workLabel ?? 'Thinking');

  // A grey hollow circle flashing on and off while the request is out with
  // nothing back; the yellow arc means output is actually arriving.
  const showBlink = awaitingModel && !workLabel && !awaitingHuman && !isCancelling && !isCompacting;
  const suffix = `${todoProgress ? ` · ${todoProgress}` : ''} · ${formatElapsed(elapsedSeconds)} · esc interrupt`;
  // One padding cell, one indicator and FreshnessLabel's leading space form
  // the same label gutter as the idle shell row. Metadata never pushes it out.
  const labelWidth = Math.max(1, width - 3 - visibleLength(suffix));
  const visibleLabel = truncateAnsiToWidth(label.replace(/\s+/g, ' '), labelWidth, '…');

  if (!active) return null;

  return (
    <Box paddingLeft={1} width={width}>
      <ProgressIndicator
        type={showBlink ? 'blink' : 'arc'}
        color={isCancelling ? UI_COLORS.ERROR : showBlink ? UI_COLORS.TEXT_DIM : UI_COLORS.PRIMARY}
      />
      <FreshnessLabel
        text={visibleLabel}
        getSilenceMs={getSilenceMs}
        color={isCancelling ? UI_COLORS.ERROR : undefined}
        dimmed={showBlink}
      />
      <Text dimColor>{suffix}</Text>
    </Box>
  );
};
