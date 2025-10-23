/**
 * ReasoningStream - Displays streaming reasoning/thinking tokens
 *
 * Shows the model's internal reasoning as it streams in from reasoning-capable
 * models (like gpt-oss). Renders above the status indicator to provide visibility
 * into the model's thought process without interfering with the main chat.
 */

import React, { useEffect, useState, useRef } from 'react';
import { Box, Text } from 'ink';
import { useActivityEvent } from '../hooks/useActivityEvent.js';
import { ActivityEventType } from '../../types/index.js';

const MAX_DISPLAY_LENGTH = 500; // Limit display to prevent overflow

export const ReasoningStream: React.FC = () => {
  const [reasoning, setReasoning] = useState<string>('');
  const accumulatorRef = useRef<string>('');
  const lastUpdateRef = useRef<number>(0);
  const throttleTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Subscribe to thinking chunk events
  useActivityEvent(ActivityEventType.THOUGHT_CHUNK, (event) => {
    const chunk = event.data?.chunk || '';
    if (!chunk) return;

    accumulatorRef.current += chunk;

    // Throttle updates to prevent UI thrashing (max once per 200ms)
    const now = Date.now();
    if (now - lastUpdateRef.current < 200) {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
      }
      throttleTimerRef.current = setTimeout(() => {
        updateDisplay();
      }, 200);
    } else {
      updateDisplay();
    }
  });

  const updateDisplay = () => {
    lastUpdateRef.current = Date.now();
    const text = accumulatorRef.current;

    // Truncate if too long, showing the most recent content
    const displayText = text.length > MAX_DISPLAY_LENGTH
      ? '...' + text.slice(-(MAX_DISPLAY_LENGTH - 3))
      : text;

    setReasoning(displayText);
  };

  // Clear reasoning when agent finishes (new assistant message arrives)
  useActivityEvent(ActivityEventType.TOOL_CALL_START, () => {
    accumulatorRef.current = '';
    setReasoning('');
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
      }
    };
  }, []);

  // Don't render if no reasoning to show
  if (!reasoning) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor color="gray">
        💭 {reasoning}
      </Text>
    </Box>
  );
};
