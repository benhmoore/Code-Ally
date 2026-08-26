import type { ActivityStream } from '../services/ActivityStream.js';
import { ActivityEventType } from '../types/index.js';

export interface ModelRetryActivity {
  requestId: string;
  label: string;
  delaySeconds: string;
  attempt: number;
  parentId?: string;
}

/**
 * Publish one provider-neutral retry boundary on the request's scoped stream.
 *
 * A failed streaming attempt may already have emitted transient reasoning or
 * assistant text. Consumers must discard that attempt before the replacement
 * begins; otherwise presentation and loop detection combine unrelated attempts.
 */
export function emitModelRetryActivity(
  activityStream: ActivityStream | undefined,
  activity: ModelRetryActivity,
): void {
  if (!activityStream) return;

  const timestamp = Date.now();
  const eventSuffix = `${activity.requestId}-${activity.attempt}`;
  activityStream.emit({
    id: `model-stream-reset-${eventSuffix}`,
    type: ActivityEventType.MODEL_STREAM_RESET,
    timestamp,
    parentId: activity.parentId,
    data: { reason: activity.label, attempt: activity.attempt },
  });
  activityStream.emit({
    id: `status-model-retry-${eventSuffix}`,
    type: ActivityEventType.STATUS_MESSAGE,
    timestamp,
    parentId: activity.parentId,
    data: { message: `${activity.label}, retrying in ${activity.delaySeconds}s...` },
  });
}
