/** Complete serialized SystemOne request limit; authority and action are never truncated. */
export const MAX_PERMISSION_REVIEW_BYTES = 64 * 1024;

/** Allow-only operating point selected against held-out authorization cases. */
export const PERMISSION_ALLOW_THRESHOLD = 0.95;
