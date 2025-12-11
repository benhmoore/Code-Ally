/**
 * FormManager - Handles interactive form requests for tool execution
 *
 * Manages form request/response flows for tools that require user input:
 * - Event-driven form display via ActivityStream
 * - No timeout (forms stay open until user submits or cancels)
 * - Form cancellation handling
 *
 * Usage Pattern:
 * 1. Tool calls formManager.requestForm() with schema
 * 2. FormManager emits TOOL_FORM_REQUEST event
 * 3. UI displays form and waits for user interaction
 * 4. User submits form -> UI emits TOOL_FORM_RESPONSE event
 * 5. User cancels form -> UI emits TOOL_FORM_CANCEL event
 * 6. FormManager resolves/rejects the Promise
 */

import { ActivityStream } from './ActivityStream.js';
import {
  ActivityEvent,
  ActivityEventType,
  FormSchema,
} from '../types/index.js';
import { logger } from './Logger.js';

/**
 * Error thrown when user cancels a form
 */
export class FormCancelledError extends Error {
  constructor(toolName: string) {
    super(`Form cancelled for tool: ${toolName}`);
    this.name = 'FormCancelledError';
  }
}

/**
 * FormManager class
 *
 * Core responsibilities:
 * 1. Request forms from users via ActivityStream events
 * 2. Track pending form requests
 * 3. Handle form responses (submit/cancel)
 * 4. Provide form data to tools when user submits
 */
export class FormManager {
  /**
   * Activity stream for event-based form requests
   */
  private activityStream: ActivityStream;

  /**
   * Pending form requests waiting for response
   * Maps requestId -> {resolve, reject, toolName}
   */
  private pendingForms: Map<
    string,
    {
      resolve: (data: Record<string, any>) => void;
      reject: (error: Error) => void;
      toolName: string;
    }
  > = new Map();

  constructor(activityStream: ActivityStream) {
    this.activityStream = activityStream;

    // Subscribe to form response events
    this.activityStream.subscribe(
      ActivityEventType.TOOL_FORM_RESPONSE,
      this.handleFormResponse.bind(this)
    );
    this.activityStream.subscribe(
      ActivityEventType.TOOL_FORM_CANCEL,
      this.handleFormCancel.bind(this)
    );
  }

  /**
   * Request a form from the user and wait for their response.
   * Returns the form data when user submits.
   * Throws FormCancelledError if user cancels.
   *
   * @param toolName - Name of the tool requesting the form
   * @param schema - Form schema defining fields and validation
   * @param initialValues - Optional initial values for form fields
   * @param callId - Optional tool call ID for context
   * @returns Promise that resolves with form data or rejects on cancel
   */
  async requestForm(
    toolName: string,
    schema: FormSchema,
    initialValues?: Record<string, any>,
    callId?: string
  ): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      // Generate unique ID for form request: form_{timestamp}_{7-char-random} (base-36, skip '0.' prefix)
      const requestId = `form_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      // Store pending form (no timeout per design decision)
      this.pendingForms.set(requestId, { resolve, reject, toolName });
      logger.debug(`[FORM_MANAGER] Form requested: ${requestId} for tool "${toolName}" (${schema.fields.length} fields)`);

      // Emit form request event
      this.activityStream.emit({
        id: requestId,
        type: ActivityEventType.TOOL_FORM_REQUEST,
        timestamp: Date.now(),
        data: {
          requestId,
          toolName,
          schema,
          initialValues,
          callId,
        },
      });
    });
  }

  /**
   * Handle form response from UI (user submitted form)
   */
  private handleFormResponse(event: ActivityEvent): void {
    const { requestId, data } = event.data;
    const pending = this.pendingForms.get(requestId);
    if (pending) {
      this.pendingForms.delete(requestId);
      logger.debug(`[FORM_MANAGER] Form submitted: ${requestId} for tool "${pending.toolName}"`);
      pending.resolve(data);
    } else {
      logger.debug(`[FORM_MANAGER] Form response for unknown request: ${requestId}`);
    }
  }

  /**
   * Handle form cancellation from UI (user cancelled form)
   */
  private handleFormCancel(event: ActivityEvent): void {
    const { requestId } = event.data;
    const pending = this.pendingForms.get(requestId);
    if (pending) {
      this.pendingForms.delete(requestId);
      logger.debug(`[FORM_MANAGER] Form cancelled: ${requestId} for tool "${pending.toolName}"`);
      pending.reject(new FormCancelledError(pending.toolName));
    } else {
      logger.debug(`[FORM_MANAGER] Form cancel for unknown request: ${requestId}`);
    }
  }

  /**
   * Check if there are any pending form requests
   */
  hasPendingForms(): boolean {
    return this.pendingForms.size > 0;
  }

  /**
   * Cancel all pending forms (e.g., on shutdown)
   */
  cancelAllPending(): void {
    if (this.pendingForms.size > 0) {
      logger.debug(`[FORM_MANAGER] Cancelling ${this.pendingForms.size} pending form(s)`);
    }
    for (const [, pending] of this.pendingForms) {
      pending.reject(new FormCancelledError(pending.toolName));
    }
    this.pendingForms.clear();
  }
}
