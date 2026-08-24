import type { Agent } from '../agent/Agent.js';
import type { ActivityStream } from './ActivityStream.js';

export type ConversationRouteKind = 'primary' | 'child';

/**
 * Complete, immutable address for one interactive conversation.
 *
 * Consumers must use the collaborators carried by the route instead of
 * consulting process-global "current agent" state. That keeps routing stable
 * for the duration of an input operation even if the user navigates elsewhere.
 */
export interface ConversationRoute {
  readonly id: string;
  readonly kind: ConversationRouteKind;
  readonly agent: Agent;
  readonly activityStream: ActivityStream;
  /** Live ownership check evaluated at submission time, not render time. */
  readonly isAvailable: () => boolean;
}
