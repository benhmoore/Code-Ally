/**
 * ReasoningStream - Displays streaming reasoning/thinking tokens
 *
 * Shows the model's internal reasoning as it streams in from reasoning-capable
 * models (like gpt-oss). Reserves exactly 2 lines and truncates by sentence
 * boundaries to prevent visual thrashing. Thoughts expire after 5 seconds.
 */

import React, { useEffect, useState, useRef } from 'react';
import { Box, Text } from 'ink';
import { useActivityEvent } from '../hooks/useActivityEvent.js';
import { ActivityEventType } from '../../types/index.js';
import { ANIMATION_TIMING, TEXT_LIMITS } from '../../config/constants.js';

const MAX_LINES = TEXT_LIMITS.REASONING_MAX_LINES;
const THOUGHT_LIFETIME_MS = ANIMATION_TIMING.REASONING_THOUGHT_LIFETIME;
const CHARS_PER_LINE = TEXT_LIMITS.REASONING_CHARS_PER_LINE;

interface TimestampedThought {
  text: string;
  completedAt: number;
}

export const ReasoningStream: React.FC = () => {
  const [reasoning, setReasoning] = useState<string>('');
  const currentThoughtRef = useRef<string>(''); // Current streaming thought
  const thoughtHistoryRef = useRef<TimestampedThought[]>([]); // Previous completed thoughts with timestamps
  const lastUpdateRef = useRef<number>(0);
  const throttleTimerRef = useRef<NodeJS.Timeout | null>(null);
  const cleanupTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isStreamingRef = useRef<boolean>(false);

  // Helper to extract complete sentences from accumulated text
  const extractCompleteSentences = (text: string): { sentences: string[], remainder: string } => {
    // Split on sentence boundaries (. ! ? followed by space or end)
    const sentenceRegex = /[.!?]+(?:\s+|$)/g;
    const matches: { sentence: string, endIndex: number }[] = [];
    let match;

    while ((match = sentenceRegex.exec(text)) !== null) {
      const lastMatch = matches.length > 0 ? matches[matches.length - 1] : undefined;
      const startIndex = lastMatch ? lastMatch.endIndex : 0;
      const sentence = text.slice(startIndex, match.index + match[0].length);
      matches.push({ sentence: sentence.trim(), endIndex: match.index + match[0].length });
    }

    const sentences = matches.map(m => m.sentence).filter(s => s.length > 0);
    const lastMatch = matches.length > 0 ? matches[matches.length - 1] : null;
    const lastEndIndex = lastMatch ? lastMatch.endIndex : 0;
    const remainder = text.slice(lastEndIndex);

    return { sentences, remainder };
  };

  // Subscribe to thinking chunk events
  useActivityEvent(ActivityEventType.THOUGHT_CHUNK, (event) => {
    const chunk = event.data?.chunk || '';
    if (!chunk) return;

    // Mark that we're actively streaming
    if (!isStreamingRef.current) {
      isStreamingRef.current = true;

      // Start cleanup interval if not already running
      if (!cleanupTimerRef.current) {
        cleanupTimerRef.current = setInterval(() => {
          cleanupOldThoughts();
          updateDisplay();

          // Stop cleanup when no thoughts remain and not streaming
          if (thoughtHistoryRef.current.length === 0 && !currentThoughtRef.current && !isStreamingRef.current) {
            if (cleanupTimerRef.current) {
              clearInterval(cleanupTimerRef.current);
              cleanupTimerRef.current = null;
            }
            setReasoning('');
          }
        }, ANIMATION_TIMING.REASONING_CLEANUP_INTERVAL);
      }
    }

    // Accumulate chunks
    currentThoughtRef.current += chunk;

    // Extract complete sentences and move them to history
    const { sentences, remainder } = extractCompleteSentences(currentThoughtRef.current);

    if (sentences.length > 0) {
      const now = Date.now();
      sentences.forEach(sentence => {
        // Only keep thoughts that fit within MAX_LINES
        const sentenceLines = Math.ceil(sentence.length / CHARS_PER_LINE);
        if (sentenceLines <= MAX_LINES) {
          thoughtHistoryRef.current.push({
            text: sentence,
            completedAt: now,
          });
        }
        // If > MAX_LINES, skip it entirely (don't add to history)
      });
      currentThoughtRef.current = remainder;
    }

    // Throttle updates to prevent UI thrashing
    const now = Date.now();
    if (now - lastUpdateRef.current < ANIMATION_TIMING.REASONING_THROTTLE) {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
      }
      throttleTimerRef.current = setTimeout(() => {
        updateDisplay();
      }, ANIMATION_TIMING.REASONING_THROTTLE);
    } else {
      updateDisplay();
    }
  });

  const cleanupOldThoughts = () => {
    const now = Date.now();

    // Remove thoughts older than 5 seconds
    thoughtHistoryRef.current = thoughtHistoryRef.current.filter(
      (thought) => now - thought.completedAt < THOUGHT_LIFETIME_MS
    );
  };

  const updateDisplay = () => {
    lastUpdateRef.current = Date.now();

    // Clean up old/excess thoughts first
    cleanupOldThoughts();

    // Combine all thoughts (history + current)
    const allThoughts = [...thoughtHistoryRef.current.map(t => t.text)];
    if (currentThoughtRef.current) {
      allThoughts.push(currentThoughtRef.current);
    }

    // Join all thoughts
    const fullText = allThoughts.join(' ');

    // Truncate to fit within MAX_LINES by complete sentences
    const maxChars = MAX_LINES * CHARS_PER_LINE;
    let displayText = fullText;

    if (fullText.length > maxChars) {
      // Split into sentences
      const sentenceRegex = /[.!?]+(?:\s+|$)/g;
      const sentences: string[] = [];
      let lastIndex = 0;
      let match;

      while ((match = sentenceRegex.exec(fullText)) !== null) {
        sentences.push(fullText.slice(lastIndex, match.index + match[0].length).trim());
        lastIndex = match.index + match[0].length;
      }

      // Add any remaining text as incomplete sentence
      if (lastIndex < fullText.length) {
        sentences.push(fullText.slice(lastIndex).trim());
      }

      // Keep the most recent complete sentences that fit
      let accumulated = '';
      for (let i = sentences.length - 1; i >= 0; i--) {
        const sentence = sentences[i];
        const testText = sentence + (accumulated ? ' ' + accumulated : '');
        if (testText.length <= maxChars) {
          accumulated = testText;
        } else {
          break;
        }
      }

      if (accumulated) {
        displayText = accumulated;
      } else {
        const lastSentence = sentences[sentences.length - 1];
        displayText = lastSentence ? lastSentence.slice(-maxChars) : '';
      }
    }

    setReasoning(displayText);
  };

  // When agent starts, clear all old thoughts from previous request
  useActivityEvent(ActivityEventType.AGENT_START, () => {
    thoughtHistoryRef.current = [];
    currentThoughtRef.current = '';
    isStreamingRef.current = false;
    setReasoning('');

    if (cleanupTimerRef.current) {
      clearInterval(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
  });

  // When agent finishes, mark streaming as complete
  useActivityEvent(ActivityEventType.AGENT_END, () => {
    isStreamingRef.current = false;

    // Move current thought to history if exists and it fits within MAX_LINES
    if (currentThoughtRef.current) {
      const remainderLines = Math.ceil(currentThoughtRef.current.length / CHARS_PER_LINE);
      if (remainderLines <= MAX_LINES) {
        thoughtHistoryRef.current.push({
          text: currentThoughtRef.current,
          completedAt: Date.now(),
        });
      }
      // If > MAX_LINES, skip it
      currentThoughtRef.current = '';
      updateDisplay();
    }

    // Cleanup timer is already running, it will handle expiration
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
      }
      if (cleanupTimerRef.current) {
        clearInterval(cleanupTimerRef.current);
      }
    };
  }, []);

  // Always render to reserve exactly 2 lines (prevent thrashing)
  return (
    <Box marginBottom={1} minHeight={2}>
      {reasoning && <Text italic color="yellow">{reasoning}</Text>}
      {!reasoning && <Text> </Text>}
    </Box>
  );
};
