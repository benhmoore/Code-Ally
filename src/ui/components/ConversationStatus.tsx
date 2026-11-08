import React from 'react';
import type { ConversationViewSnapshot } from '@services/ConversationViewStore.js';
import { StatusIndicator } from './StatusIndicator.js';
import { useConversationSelector, shallowEqual, type ConversationSource } from '../hooks/useConversationSelector.js';

const selectStatus = (view: ConversationViewSnapshot) => ({
  isProcessing: view.isThinking, isCompacting: view.isCompacting, activeToolCalls: view.activeToolCalls,
});
type Props = Omit<React.ComponentProps<typeof StatusIndicator>, keyof ReturnType<typeof selectStatus>> & {
  source: ConversationSource;
  /** Stable session identity; changing it resets presentation-only timing. */
  ownerId?: string;
};
export const ConversationStatus = React.memo(function ConversationStatus({ source, ownerId, ...props }: Props) {
  const status = useConversationSelector(source, selectStatus, shallowEqual);
  return <StatusIndicator key={ownerId} {...props} {...status}/>;
});
