/**
 * ProgressIndicator Component
 *
 * Displays animated spinners for different tool types and operations.
 * Supports multiple spinner styles and customizable text.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { AnimationTicker } from '@services/AnimationTicker.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '../constants/colors.js';

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
 * Spinner frame definitions - uses centralized UI_SYMBOLS
 */
const SPINNERS: Record<SpinnerType, readonly string[]> = {
  default: UI_SYMBOLS.SPINNER.DEFAULT,
  dots: UI_SYMBOLS.SPINNER.DOTS,
  line: UI_SYMBOLS.SPINNER.LINE,
  dots2: UI_SYMBOLS.SPINNER.DOTS2,
  arc: UI_SYMBOLS.SPINNER.ARC,
  bounce: UI_SYMBOLS.SPINNER.BOUNCE,
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
  color = UI_COLORS.PRIMARY,
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
