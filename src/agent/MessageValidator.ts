/**
 * MessageValidator - Manages validation of LLM responses and retry logic
 *
 * Responsibilities:
 * - Tracks validation attempt count across conversation continuations
 * - Determines when validation failures should trigger retries vs final errors
 * - Provides validation result handling with clear error messages
 * - Maintains validation state throughout a conversation
 *
 * This class extracts validation logic from Agent to maintain separation of concerns
 * and make validation behavior testable and reusable.
 */

import { LLMResponse } from '../llm/ModelClient.js';
import { Message } from '../types/index.js';
import { logger } from '../services/Logger.js';
import { createValidationErrorReminder } from '../utils/messageUtils.js';

/**
 * Result of a validation check
 */
export interface ValidationResult {
  /** Whether validation passed */
  isValid: boolean;
  /** Whether this should trigger a retry */
  shouldRetry: boolean;
  /** Current attempt count */
  attemptCount: number;
  /** Validation error messages (if any) */
  errors?: string[];
}

/**
 * Configuration for MessageValidator
 */
export interface MessageValidatorConfig {
  /** Agent instance ID for logging */
  instanceId?: string;
}

/**
 * Manages message validation state and retry logic
 */
export class MessageValidator {
  /** Current validation attempt count */
  private attemptCount: number = 0;

  /** Agent instance ID for logging */
  private readonly instanceId: string;

  /**
   * Create a new MessageValidator
   *
   * @param config - Validator configuration
   */
  constructor(config: MessageValidatorConfig = {}) {
    this.instanceId = config.instanceId ?? 'unknown';
  }

  /**
   * Validate an LLM response and determine retry behavior
   *
   * This method checks if a response contains validation errors and determines:
   * - Whether the response is valid
   * - Whether a retry should be attempted
   *
   * @param response - LLM response to validate
   * @param isRetry - Whether this is already a retry attempt
   * @returns Validation result with retry logic
   */
  validate(response: LLMResponse, isRetry: boolean = false): ValidationResult {
    // Check if response has validation errors
    const hasValidationError = response.error && response.tool_call_validation_failed;

    if (!hasValidationError) {
      // Valid response - return success
      return {
        isValid: true,
        shouldRetry: false,
        attemptCount: this.attemptCount,
      };
    }

    // Validation failed - only process if not already a retry
    if (isRetry) {
      return {
        isValid: false,
        shouldRetry: false,
        attemptCount: this.attemptCount,
        errors: response.validation_errors,
      };
    }

    // Increment attempt counter
    this.attemptCount++;

    logger.debug(
      `[AGENT_RESPONSE]`,
      this.instanceId,
      `Tool call validation failed - attempt ${this.attemptCount} (will retry indefinitely)`
    );
    logger.debug(`[AGENT_RESPONSE] Validation errors:`, response.validation_errors?.join('; '));

    return {
      isValid: false,
      shouldRetry: true,
      attemptCount: this.attemptCount,
      errors: response.validation_errors,
    };
  }

  /**
   * Create a continuation message for validation retry
   *
   * Generates a system message prompting the LLM to fix validation errors
   * in its previous response.
   *
   * @param errors - Validation error messages
   * @returns Message to add to conversation for retry
   */
  createValidationRetryMessage(errors?: string[]): Message {
    const errorList = errors || ['Unknown validation errors'];
    // PERSIST: false - Ephemeral: One-time signal to retry with valid tool calls
    // Cleaned up after turn since validation errors are turn-specific
    return createValidationErrorReminder(errorList);
  }

  /**
   * Reset validation attempt counter
   *
   * Should be called when:
   * - A successful response (with or without tool calls) is received
   * - A new user message starts a fresh conversation turn
   */
  reset(): void {
    if (this.attemptCount > 0) {
      logger.debug('[AGENT_VALIDATION]', this.instanceId, 'Resetting validation counter from', this.attemptCount);
    }
    this.attemptCount = 0;
  }

  /**
   * Get current attempt count
   *
   * @returns Current number of validation attempts
   */
  getAttemptCount(): number {
    return this.attemptCount;
  }

  /**
   * Log validation attempt for debugging
   *
   * @param errors - Validation error messages
   */
  logAttempt(errors?: string[]): void {
    logger.debug(
      `[CONTINUATION] Gap 3: Tool call validation failed - prodding model to fix (attempt ${this.attemptCount})`
    );
    logger.debug(`[CONTINUATION] Validation errors:`, errors?.join('; '));
  }
}
