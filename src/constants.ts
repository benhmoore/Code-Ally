/**
 * Global constants for Code Ally
 */

/**
 * Maximum number of tools allowed in a single batch call
 *
 * This limit prevents resource exhaustion and ensures reasonable
 * response times. If more tools are needed, split into multiple batches.
 */
export const MAX_BATCH_SIZE = 5;
