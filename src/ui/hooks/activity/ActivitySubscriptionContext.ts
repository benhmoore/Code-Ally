/** Typed terminal services passed to each independent activity domain. */
import type { Agent } from '@agent/Agent.js';
import type { ActivityStream } from '@services/ActivityStream.js';
import type { AppActions, AppState } from '../../contexts/AppContext.js';
import type { ModalState } from '../useModalState.js';
import type { ActivityRequestScope } from './ActivityRequestScope.js';

export interface ActivitySubscriptionContext {
  state: AppState;
  actions: AppActions;
  modal: ModalState;
  agent: Agent;
  activityStream: ActivityStream;
  lifetime: ActivityRequestScope;
}
