/**
 * ProgressIndicator Component
 *
 * Displays animated spinners for different tool types and operations.
 * Supports multiple spinner styles and customizable text.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

export type SpinnerType = 'default' | 'dots' | 'line' | 'dots2' | 'arc' | 'bounce';

export interface ProgressIndicatorProps {
  /** Type of spinner to display */
  type?: SpinnerType;
  /** Text to display next to the spinner */
  text?: string;
  /** Color for the spinner */
  color?: string;
  /** Whether to dim the text */
  dimText?: boolean;
}

/**
 * Spinner frame definitions
 */
const SPINNERS: Record<SpinnerType, string[]> = {
  default: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  line: ['─', '\\', '|', '/'],
  dots2: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
  arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
  bounce: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
};

/**
 * Frame rates (ms per frame) for different spinner types
 */
const FRAME_RATES: Record<SpinnerType, number> = {
  default: 80,
  dots: 80,
  line: 100,
  dots2: 80,
  arc: 100,
  bounce: 120,
};

/**
 * ProgressIndicator Component
 *
 * Animated spinner with customizable appearance.
 * Automatically cycles through frames at the appropriate rate.
 */
export const ProgressIndicator: React.FC<ProgressIndicatorProps> = ({
  type = 'default',
  text,
  color = 'cyan',
  dimText = false,
}) => {
  const [frame, setFrame] = useState(0);
  const spinner = SPINNERS[type];
  const frameRate = FRAME_RATES[type];

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % spinner.length);
    }, frameRate);

    return () => clearInterval(interval);
  }, [spinner.length, frameRate]);

  return (
    <Box>
      <Text color={color}>{spinner[frame]}</Text>
      {text && (
        <Text color={color} dimColor={dimText}>
          {' '}
          {text}
        </Text>
      )}
    </Box>
  );
};

/**
 * StatusSpinner Component
 *
 * Spinner specifically for status lines with elapsed time display.
 */
export interface StatusSpinnerProps {
  /** Status label to display */
  label: string;
  /** Start time for elapsed time calculation */
  startTime?: number;
  /** Spinner type */
  type?: SpinnerType;
  /** Color */
  color?: string;
}

export const StatusSpinner: React.FC<StatusSpinnerProps> = ({
  label,
  startTime,
  type = 'dots2',
  color = 'cyan',
}) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <Box>
      <ProgressIndicator type={type} color={color} />
      <Text color={color}> {label}</Text>
      {startTime && elapsed > 0 && (
        <Text dimColor color={color}>
          {' '}
          [{elapsed}s]
        </Text>
      )}
    </Box>
  );
};

/**
 * ThinkingIndicator Component
 *
 * Special spinner for displaying "thinking" state with token count.
 */
export interface ThinkingIndicatorProps {
  /** Context label (e.g., "thinking", "generating") */
  context?: string;
  /** Token count */
  tokenCount?: number;
  /** Model name (truncated) */
  modelName?: string;
  /** Start time */
  startTime?: number;
}

export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({
  context = 'thinking',
  tokenCount,
  modelName,
  startTime,
}) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <Box>
      <ProgressIndicator type="dots2" color="cyan" />
      {modelName && (
        <Text dimColor color="yellow">
          {' '}
          {modelName.slice(0, 5)}
        </Text>
      )}
      <Text color="cyan"> {context.charAt(0).toUpperCase() + context.slice(1)}</Text>
      {tokenCount && tokenCount > 0 && (
        <Text dimColor color="green">
          {' '}
          ({tokenCount} tokens)
        </Text>
      )}
      {startTime && elapsed > 0 && (
        <Text dimColor> [{elapsed}s]</Text>
      )}
    </Box>
  );
};

/**
 * ToolExecutionIndicator Component
 *
 * Spinner for tool execution with tool name and description.
 */
export interface ToolExecutionIndicatorProps {
  /** Tool name */
  toolName: string;
  /** Tool description */
  description?: string;
  /** Start time */
  startTime?: number;
}

export const ToolExecutionIndicator: React.FC<ToolExecutionIndicatorProps> = ({
  toolName,
  description,
  startTime,
}) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  // Truncate description if too long
  const truncatedDesc =
    description && description.length > 50 ? description.slice(0, 47) + '...' : description;

  return (
    <Box>
      <ProgressIndicator type="dots" color="yellow" />
      <Text color="yellow"> {toolName}</Text>
      {truncatedDesc && (
        <Text dimColor> {truncatedDesc}</Text>
      )}
      {startTime && elapsed > 0 && (
        <Text dimColor color="cyan">
          {' '}
          [{elapsed}s]
        </Text>
      )}
    </Box>
  );
};
