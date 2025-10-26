/**
 * ProgressIndicator Component
 *
 * Displays animated spinners for different tool types and operations.
 * Supports multiple spinner styles and customizable text.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { AnimationTicker } from '../../services/AnimationTicker.js';
import { TEXT_LIMITS } from '../../config/constants.js';

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
  const [, forceUpdate] = useState({});
  const spinner = SPINNERS[type];
  const ticker = AnimationTicker.getInstance();

  useEffect(() => {
    // Subscribe to global animation ticker
    const unsubscribe = ticker.subscribe(() => {
      forceUpdate({});
    });

    return unsubscribe;
  }, [ticker]);

  // Calculate frame based on global ticker
  const frame = ticker.getFrame() % spinner.length;

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
  const ticker = AnimationTicker.getInstance();
  const [, forceUpdate] = useState({});

  useEffect(() => {
    if (!startTime) return;

    // Subscribe to global ticker for time updates
    const unsubscribe = ticker.subscribe(() => {
      forceUpdate({});
    });

    return unsubscribe;
  }, [startTime, ticker]);

  // Calculate elapsed from global ticker
  const elapsed = startTime ? Math.floor((ticker.getCurrentTime() - startTime) / 1000) : 0;

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
  const ticker = AnimationTicker.getInstance();
  const [, forceUpdate] = useState({});

  useEffect(() => {
    if (!startTime) return;

    // Subscribe to global ticker for time updates
    const unsubscribe = ticker.subscribe(() => {
      forceUpdate({});
    });

    return unsubscribe;
  }, [startTime, ticker]);

  // Calculate elapsed from global ticker
  const elapsed = startTime ? Math.floor((ticker.getCurrentTime() - startTime) / 1000) : 0;

  return (
    <Box>
      <ProgressIndicator type="dots2" color="cyan" />
      {modelName && (
        <Text dimColor color="yellow">
          {' '}
          {modelName.slice(0, TEXT_LIMITS.MODEL_NAME_DISPLAY_MAX)}
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
  const ticker = AnimationTicker.getInstance();
  const [, forceUpdate] = useState({});

  useEffect(() => {
    if (!startTime) return;

    // Subscribe to global ticker for time updates
    const unsubscribe = ticker.subscribe(() => {
      forceUpdate({});
    });

    return unsubscribe;
  }, [startTime, ticker]);

  // Calculate elapsed from global ticker
  const elapsed = startTime ? Math.floor((ticker.getCurrentTime() - startTime) / 1000) : 0;

  // Truncate description if too long
  const truncatedDesc =
    description && description.length > TEXT_LIMITS.DESCRIPTION_MAX ? description.slice(0, TEXT_LIMITS.DESCRIPTION_MAX - 3) + '...' : description;

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
