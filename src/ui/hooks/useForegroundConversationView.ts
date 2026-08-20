import { useEffect, useState } from 'react';
import type { Agent } from '@agent/Agent.js';
import type { Message, ToolCallState } from '@shared/index.js';
import { ActivityEventType } from '@shared/index.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { reconstructToolCallsFromMessages } from './useSessionResume.js';
import { appendBoundedText } from '../utils/boundedText.js';

export interface ForegroundConversationView {
  messages: Message[];
  activeToolCalls: ToolCallState[];
  streamingContent?: string;
  isThinking: boolean;
  isCompacting: boolean;
}

const snapshot = (agent: Agent): Pick<ForegroundConversationView, 'messages' | 'activeToolCalls'> => {
  const messages = agent.getMessages().filter((message) => message.role !== 'system');
  return {
    messages,
    activeToolCalls: reconstructToolCallsFromMessages(messages, ServiceRegistry.getInstance()),
  };
};

/**
 * Own the transient render state for an entered child conversation.
 *
 * Root conversation state must remain untouched while a child is viewed. The
 * child has its own scoped activity stream, so this hook snapshots its durable
 * messages and layers live assistant chunks on top without subscribing the root
 * AppContext to child lifecycle events.
 */
export function useForegroundConversationView(
  activeAgentId: string,
  foregroundAgent: Agent,
): ForegroundConversationView | null {
  const [view, setView] = useState<ForegroundConversationView | null>(null);

  useEffect(() => {
    if (activeAgentId === 'main') {
      setView(null);
      return;
    }

    const refresh = () => {
      const next = snapshot(foregroundAgent);
      setView((current) => ({
        ...next,
        streamingContent: current?.streamingContent,
        isThinking: foregroundAgent.isProcessing(),
        isCompacting: current?.isCompacting ?? false,
      }));
    };

    setView({ ...snapshot(foregroundAgent), isThinking: foregroundAgent.isProcessing(), isCompacting: false });

    const stream = foregroundAgent.getActivityStream?.();
    if (!stream) return;

    const unsubs = [
      stream.subscribe(ActivityEventType.MODEL_REQUEST_START, () => {
        setView((current) => current ? { ...current, isThinking: true } : current);
      }),
      stream.subscribe(ActivityEventType.COMPACTION_START, () => {
        setView((current) => current ? { ...current, isCompacting: true } : current);
      }),
      stream.subscribe(ActivityEventType.COMPACTION_COMPLETE, () => {
        refresh();
        setView((current) => current ? { ...current, isCompacting: false } : current);
      }),
      stream.subscribe(ActivityEventType.ASSISTANT_CHUNK, (event) => {
        const chunk = event.data?.chunk || '';
        if (!chunk) return;
        setView((current) => current ? {
          ...current,
          streamingContent: appendBoundedText(current.streamingContent ?? '', chunk, 4 * 1024 * 1024),
          isThinking: true,
        } : current);
      }),
      stream.subscribe(ActivityEventType.TOOL_CALL_START, () => setTimeout(refresh, 0)),
      stream.subscribe(ActivityEventType.TOOL_CALL_END, () => setTimeout(refresh, 0)),
      stream.subscribe(ActivityEventType.ASSISTANT_MESSAGE_COMPLETE, () => {
        setView({ ...snapshot(foregroundAgent), isThinking: foregroundAgent.isProcessing(), isCompacting: false });
      }),
      stream.subscribe(ActivityEventType.AGENT_END, () => {
        setView({ ...snapshot(foregroundAgent), isThinking: false, isCompacting: false });
      }),
    ];

    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, [activeAgentId, foregroundAgent]);

  return view;
}
