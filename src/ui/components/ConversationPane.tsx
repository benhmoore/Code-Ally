import React from 'react';
import { Box } from 'ink';
import type { ConversationViewSnapshot } from '@services/ConversationViewStore.js';
import { ConversationView } from './ConversationView.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { useConversationSelector, type ConversationSource, shallowEqual } from '../hooks/useConversationSelector.js';

const selectTranscript = (view: ConversationViewSnapshot) => ({
  messages: view.messages, activeToolCalls: view.activeToolCalls,
  streamingContent: view.streamingContent, isThinking: view.isThinking,
  compactionNotices: view.compactionNotices, statusMessages: view.statusMessages,
});
type Props = Omit<React.ComponentProps<typeof ConversationView>, keyof ReturnType<typeof selectTranscript>> & {
  source: ConversationSource;
};

/** Streaming updates stop at this boundary; application controls do not subscribe to text. */
export const ConversationPane = React.memo(function ConversationPane({ source, ...props }: Props) {
  const view = useConversationSelector(source, selectTranscript, shallowEqual);
  const width = useContentWidth();
  return <Box width={width}>
    <ErrorBoundary label="ConversationView" resetKey={props.staticRemountKey}>
      <ConversationView {...props} {...view}/>
    </ErrorBoundary>
  </Box>;
});
