import { MAX_PERMISSION_REVIEW_BYTES } from './PermissionReviewLimits.js';
import type { Message } from '../types/index.js';
import type { SemanticCheckpointStateV1 } from '../agent/compaction/types.js';
import { isActualUserMessage } from '../utils/messagePersistence.js';

/** Exact human authority only. Oversize or incomplete archives require human review. */
export function permissionTask(
  transcript: readonly Message[],
  checkpoint?: SemanticCheckpointStateV1,
  limit = MAX_PERMISSION_REVIEW_BYTES,
): string | undefined {
  if (checkpoint && !checkpoint.userDirections) return undefined;
  const parts: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  const append = (text: string, ids: readonly string[]): boolean => {
    if (ids.length && ids.every(id => seen.has(id))) return true;
    for (const id of ids) seen.add(id);
    if (!text.trim()) return true;
    length += text.length + (parts.length ? 1 : 0);
    if (length > limit) return false;
    parts.push(text);
    return true;
  };
  for (const direction of checkpoint?.userDirections ?? []) {
    if (!append(direction.text, direction.sourceMessageIds)) return undefined;
  }
  for (const message of transcript) {
    if (!isActualUserMessage(message)) continue;
    if (!append(message.metadata?.submittedContent ?? message.content, message.id ? [message.id] : [])) return undefined;
  }
  return parts.length ? parts.join('\n') : undefined;
}
