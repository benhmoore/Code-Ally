import React from 'react';
import { Text } from 'ink';
import type { ConversationViewSnapshot } from '@services/ConversationViewStore.js';
import { CONTEXT_THRESHOLDS } from '@config/toolDefaults.js';
import { UI_COLORS } from '../constants/colors.js';
import { useConversationSelector, type ConversationSource } from '../hooks/useConversationSelector.js';

const rate = (view: ConversationViewSnapshot) => view.generationRate;
const context = (view: ConversationViewSnapshot) => view.contextUsage;

/** Metrics update independently of the input controller and transcript. */
export const ConversationMetrics = React.memo(function ConversationMetrics({ source, kind }: {
  source: ConversationSource; kind: 'rate' | 'context';
}) {
  const value = useConversationSelector(source, kind === 'rate' ? rate : context);
  if (kind === 'rate') return value !== undefined && value > 0
    ? <Text> · ~{value < 10 ? value.toFixed(1) : Math.round(value)} tok/s</Text> : null;
  if (value === undefined || value <= CONTEXT_THRESHOLDS.VISIBILITY) return null;
  return <Text> · <Text color={value >= CONTEXT_THRESHOLDS.WARNING ? UI_COLORS.ERROR
    : value >= CONTEXT_THRESHOLDS.NORMAL ? UI_COLORS.WARNING : undefined}>
    {CONTEXT_THRESHOLDS.MAX_PERCENT - value}% context left
  </Text></Text>;
});
