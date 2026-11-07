/** Loading and recoverable failures shared by saved-content pickers. */
import React from 'react';
import { Text } from 'ink';
import { InteractiveSurface } from './InteractiveSurface.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { selectorText } from '../utils/formatters.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { Clickable } from './Clickable.js';

export type SelectorLoadState = { kind: 'loading' } | { kind: 'error'; message: string };

export function SelectorLoadStatus({
  title,
  state,
  onRetry,
}: {
  title: string;
  state: SelectorLoadState;
  onRetry?: () => void;
}) {
  const width = Math.max(1, useContentWidth() - 2);
  const retry = state.kind === 'error' && onRetry;
  return (
    <InteractiveSurface
      title={title}
      footer={
        <KeyboardHintFooter
          hints={
            retry
              ? [
                  { key: 'r', label: 'retry' },
                  { key: 'esc', label: 'close' },
                ]
              : [{ key: 'esc', label: 'close' }]
          }
        />
      }
    >
      {state.kind === 'loading' ? (
        <Text dimColor>Loading…</Text>
      ) : (
        <>
          <Text>Unable to load this list.</Text>
          <Text dimColor wrap="truncate-end">
            {selectorText(state.message, width)}
          </Text>
          {retry && (
            <Clickable onPress={onRetry}>
              <Text>Retry</Text>
            </Clickable>
          )}
        </>
      )}
    </InteractiveSurface>
  );
}
