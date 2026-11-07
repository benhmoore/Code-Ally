/** Compose independent terminal activity domains around one publication lifetime. */
import type { Agent } from '@agent/Agent.js';
import type { ActivityStream } from '@services/ActivityStream.js';
import type { AppState, AppActions } from '../contexts/AppContext.js';
import type { ModalState } from './useModalState.js';
import { useActivityRequestScope } from './activity/useActivityRequestScope.js';
import { useConversationActivity } from './activity/useConversationActivity.js';
import { useApprovalActivity } from './activity/useApprovalActivity.js';
import { useConfigurationActivity } from './activity/useConfigurationActivity.js';
import { useAgentActivity } from './activity/useAgentActivity.js';
import { useHistoryActivity } from './activity/useHistoryActivity.js';
import { useLibraryActivity } from './activity/useLibraryActivity.js';

export interface ActivitySubscriptionsState {
  isCancelling: boolean;
}

export function useActivitySubscriptions(
  state: AppState,
  actions: AppActions,
  modal: ModalState,
  agent: Agent,
  activityStream: ActivityStream
): ActivitySubscriptionsState {
  const lifetime = useActivityRequestScope(agent, modal.activeModal, state.activeAgentId);
  const context = { state, actions, modal, agent, activityStream, lifetime };
  const conversation = useConversationActivity(context);
  useApprovalActivity(context);
  useConfigurationActivity(context);
  useAgentActivity(context);
  useHistoryActivity(context);
  useLibraryActivity(context);
  return conversation;
}
