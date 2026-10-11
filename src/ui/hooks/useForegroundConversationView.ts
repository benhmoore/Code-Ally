import { useSyncExternalStore } from 'react';
import type { Agent } from '@agent/Agent.js';
import type { ConversationViewSnapshot } from '@services/ConversationViewStore.js';

export interface ForegroundConversationView extends ConversationViewSnapshot {
  agentId: string;
}

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export function useForegroundConversationView(
  activeAgentId: string,
  foregroundAgent: Agent | null,
): ForegroundConversationView | null {
  const store = foregroundAgent?.getConversationView();
  const snapshot = useSyncExternalStore(store?.subscribe ?? emptySubscribe, store?.getSnapshot ?? emptySnapshot);
  return snapshot ? { ...snapshot, agentId: activeAgentId } : null;
}
