/**
 * useToolState - Track tool call state and updates
 *
 * This hook subscribes to activity events for a specific tool call and maintains
 * its current status, output, and error state. It's the primary way components
 * should track individual tool execution.
 */

import { useState, useCallback } from 'react';
import { ActivityEventType, ToolStatus } from '../../types/index.js';
import { useActivityEvent } from './useActivityEvent.js';

/**
 * Tool state returned by useToolState
 */
export interface ToolState {
  /** Current execution status */
  status: ToolStatus;

  /** Accumulated output from the tool */
  output: string;

  /** Error message if status is 'error' */
  error: string | null;

  /** Duration in milliseconds (if completed) */
  duration: number | null;
}

/**
 * Track the state of a specific tool call
 *
 * Subscribes to relevant activity events and maintains the current state.
 * Useful for displaying tool execution progress and results.
 *
 * @param toolCallId - The unique ID of the tool call to track
 * @returns Current tool state
 *
 * @example
 * ```tsx
 * const toolState = useToolState(toolCall.id);
 *
 * return (
 *   <Box flexDirection="column">
 *     <Text>Status: {toolState.status}</Text>
 *     {toolState.output && <Text>{toolState.output}</Text>}
 *     {toolState.error && <Text color="red">{toolState.error}</Text>}
 *   </Box>
 * );
 * ```
 */
export const useToolState = (toolCallId: string): ToolState => {
  const [status, setStatus] = useState<ToolStatus>('pending');
  const [output, setOutput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);

  // Handle tool call start
  useActivityEvent(
    ActivityEventType.TOOL_CALL_START,
    useCallback(
      (event) => {
        if (event.id === toolCallId) {
          setStatus('executing');
          setStartTime(event.timestamp);
          setOutput('');
          setError(null);
          setDuration(null);
        }
      },
      [toolCallId]
    ),
    [toolCallId]
  );

  // Handle output chunks
  useActivityEvent(
    ActivityEventType.TOOL_OUTPUT_CHUNK,
    useCallback(
      (event) => {
        if (event.id === toolCallId) {
          setOutput((prev) => prev + (event.data.chunk || ''));
        }
      },
      [toolCallId]
    ),
    [toolCallId]
  );

  // Handle tool call completion
  useActivityEvent(
    ActivityEventType.TOOL_CALL_END,
    useCallback(
      (event) => {
        if (event.id === toolCallId) {
          const isSuccess = event.data.success !== false;
          setStatus(isSuccess ? 'success' : 'error');

          if (!isSuccess && event.data.error) {
            setError(event.data.error);
          }

          // Calculate duration
          if (startTime) {
            setDuration(event.timestamp - startTime);
          }
        }
      },
      [toolCallId, startTime]
    ),
    [toolCallId, startTime]
  );

  // Handle errors
  useActivityEvent(
    ActivityEventType.ERROR,
    useCallback(
      (event) => {
        if (event.id === toolCallId) {
          setStatus('error');
          setError(event.data.error || 'Unknown error');

          // Calculate duration
          if (startTime) {
            setDuration(event.timestamp - startTime);
          }
        }
      },
      [toolCallId, startTime]
    ),
    [toolCallId, startTime]
  );

  return {
    status,
    output,
    error,
    duration,
  };
};
