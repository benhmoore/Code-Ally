/**
 * CancellableService - Interface for services that perform background LLM operations
 *
 * Services implementing this interface can be cleanly cancelled when the main agent
 * needs exclusive access to the model client.
 */
export interface CancellableService {
  /**
   * Cancel any ongoing background operations
   *
   * This is called before the main agent starts processing to ensure background
   * tasks don't compete for resources. Services will naturally retry when conditions
   * allow (e.g., when queue is low, when idle again).
   */
  cancel(): void;
}
