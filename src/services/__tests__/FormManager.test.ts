/**
 * FormManager Tests
 *
 * Strategic test coverage for the interactive form request/response system.
 * Tests focus on the event-driven architecture, promise lifecycle,
 * and error handling.
 *
 * Key scenarios covered:
 * - Form request emission and promise creation
 * - Form response handling (submit/cancel)
 * - Multiple pending forms management
 * - FormCancelledError semantics
 * - Edge cases and error conditions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FormManager, FormCancelledError } from '../FormManager.js';
import { ActivityStream } from '../ActivityStream.js';
import { ActivityEventType, FormSchema } from '../../types/index.js';

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Create a test form schema
 */
function createFormSchema(fields: number = 2): FormSchema {
  const fieldDefs = [];
  for (let i = 0; i < fields; i++) {
    fieldDefs.push({
      name: `field${i}`,
      label: `Field ${i}`,
      type: 'text' as const,
      required: i === 0, // First field required
    });
  }
  return { fields: fieldDefs };
}

/**
 * Simulate UI submitting a form response
 */
function simulateFormSubmit(
  activityStream: ActivityStream,
  requestId: string,
  data: Record<string, any>
): void {
  activityStream.emit({
    id: `response-${requestId}`,
    type: ActivityEventType.TOOL_FORM_RESPONSE,
    timestamp: Date.now(),
    data: { requestId, data },
  });
}

/**
 * Simulate UI cancelling a form
 */
function simulateFormCancel(
  activityStream: ActivityStream,
  requestId: string
): void {
  activityStream.emit({
    id: `cancel-${requestId}`,
    type: ActivityEventType.TOOL_FORM_CANCEL,
    timestamp: Date.now(),
    data: { requestId },
  });
}

// ============================================================================
// TESTS
// ============================================================================

describe('FormManager', () => {
  let activityStream: ActivityStream;
  let formManager: FormManager;

  beforeEach(() => {
    activityStream = new ActivityStream();
    formManager = new FormManager(activityStream);
  });

  afterEach(() => {
    // Clean up any pending forms
    formManager.cancelAllPending();
  });

  describe('FormCancelledError', () => {
    it('should have correct error name and message', () => {
      const error = new FormCancelledError('TestTool');

      expect(error.name).toBe('FormCancelledError');
      expect(error.message).toBe('Form cancelled for tool: TestTool');
      expect(error).toBeInstanceOf(Error);
    });

    it('should be catchable as Error', () => {
      const error = new FormCancelledError('TestTool');

      expect(() => {
        throw error;
      }).toThrow(Error);
    });
  });

  describe('Form Request', () => {
    it('should emit TOOL_FORM_REQUEST event when requesting form', async () => {
      const schema = createFormSchema();
      const emittedEvents: any[] = [];

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        emittedEvents.push(event);
        // Immediately respond to prevent hanging
        simulateFormSubmit(activityStream, event.data.requestId, { field0: 'value' });
      });

      await formManager.requestForm('TestTool', schema);

      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0].type).toBe(ActivityEventType.TOOL_FORM_REQUEST);
      expect(emittedEvents[0].data.toolName).toBe('TestTool');
      expect(emittedEvents[0].data.schema).toBe(schema);
    });

    it('should generate unique request IDs', async () => {
      const schema = createFormSchema();
      const requestIds: string[] = [];

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        requestIds.push(event.data.requestId);
        simulateFormSubmit(activityStream, event.data.requestId, {});
      });

      await formManager.requestForm('Tool1', schema);
      await formManager.requestForm('Tool2', schema);
      await formManager.requestForm('Tool3', schema);

      expect(requestIds.length).toBe(3);
      expect(new Set(requestIds).size).toBe(3); // All unique
      expect(requestIds[0]).toMatch(/^form_\d+_[a-z0-9]+$/);
    });

    it('should include initial values when provided', async () => {
      const schema = createFormSchema();
      const initialValues = { field0: 'preset', field1: 'default' };
      let receivedEvent: any = null;

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        receivedEvent = event;
        simulateFormSubmit(activityStream, event.data.requestId, {});
      });

      await formManager.requestForm('TestTool', schema, initialValues);

      expect(receivedEvent.data.initialValues).toEqual(initialValues);
    });

    it('should include callId when provided', async () => {
      const schema = createFormSchema();
      let receivedEvent: any = null;

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        receivedEvent = event;
        simulateFormSubmit(activityStream, event.data.requestId, {});
      });

      await formManager.requestForm('TestTool', schema, undefined, 'call-123');

      expect(receivedEvent.data.callId).toBe('call-123');
    });
  });

  describe('Form Response Handling', () => {
    it('should resolve with form data when user submits', async () => {
      const schema = createFormSchema();
      const submittedData = { field0: 'value0', field1: 'value1' };

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        simulateFormSubmit(activityStream, event.data.requestId, submittedData);
      });

      const result = await formManager.requestForm('TestTool', schema);

      expect(result).toEqual(submittedData);
    });

    it('should reject with FormCancelledError when user cancels', async () => {
      const schema = createFormSchema();

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        simulateFormCancel(activityStream, event.data.requestId);
      });

      await expect(formManager.requestForm('TestTool', schema)).rejects.toThrow(
        FormCancelledError
      );
    });

    it('should reject with tool name in error message', async () => {
      const schema = createFormSchema();

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        simulateFormCancel(activityStream, event.data.requestId);
      });

      await expect(formManager.requestForm('SpecificTool', schema)).rejects.toThrow(
        'Form cancelled for tool: SpecificTool'
      );
    });

    it('should handle empty form data', async () => {
      const schema = createFormSchema();

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        simulateFormSubmit(activityStream, event.data.requestId, {});
      });

      const result = await formManager.requestForm('TestTool', schema);

      expect(result).toEqual({});
    });
  });

  describe('Pending Forms Management', () => {
    it('should track pending forms', () => {
      const schema = createFormSchema();

      // Start request but don't respond
      const promise = formManager.requestForm('TestTool', schema);

      expect(formManager.hasPendingForms()).toBe(true);

      // Cleanup
      formManager.cancelAllPending();
      promise.catch(() => {}); // Suppress unhandled rejection
    });

    it('should remove form from pending after submit', async () => {
      const schema = createFormSchema();

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        expect(formManager.hasPendingForms()).toBe(true);
        simulateFormSubmit(activityStream, event.data.requestId, {});
      });

      await formManager.requestForm('TestTool', schema);

      expect(formManager.hasPendingForms()).toBe(false);
    });

    it('should remove form from pending after cancel', async () => {
      const schema = createFormSchema();

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        expect(formManager.hasPendingForms()).toBe(true);
        simulateFormCancel(activityStream, event.data.requestId);
      });

      try {
        await formManager.requestForm('TestTool', schema);
      } catch {
        // Expected
      }

      expect(formManager.hasPendingForms()).toBe(false);
    });

    it('should handle multiple concurrent form requests', async () => {
      const schema = createFormSchema();
      const requestIds: string[] = [];

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        requestIds.push(event.data.requestId);
      });

      // Start 3 concurrent requests
      const promise1 = formManager.requestForm('Tool1', schema);
      const promise2 = formManager.requestForm('Tool2', schema);
      const promise3 = formManager.requestForm('Tool3', schema);

      // Wait for events to be emitted
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(formManager.hasPendingForms()).toBe(true);
      expect(requestIds.length).toBe(3);

      // Respond to each
      simulateFormSubmit(activityStream, requestIds[0]!, { tool: 1 });
      simulateFormSubmit(activityStream, requestIds[1]!, { tool: 2 });
      simulateFormSubmit(activityStream, requestIds[2]!, { tool: 3 });

      const results = await Promise.all([promise1, promise2, promise3]);

      expect(results[0]).toEqual({ tool: 1 });
      expect(results[1]).toEqual({ tool: 2 });
      expect(results[2]).toEqual({ tool: 3 });
      expect(formManager.hasPendingForms()).toBe(false);
    });

    it('should cancel all pending forms on cancelAllPending', async () => {
      const schema = createFormSchema();
      const errors: Error[] = [];

      // Start 3 requests without responding
      const promise1 = formManager.requestForm('Tool1', schema).catch(e => errors.push(e));
      const promise2 = formManager.requestForm('Tool2', schema).catch(e => errors.push(e));
      const promise3 = formManager.requestForm('Tool3', schema).catch(e => errors.push(e));

      // Wait for requests to be registered
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(formManager.hasPendingForms()).toBe(true);

      // Cancel all
      formManager.cancelAllPending();

      await Promise.all([promise1, promise2, promise3]);

      expect(errors.length).toBe(3);
      expect(errors.every(e => e instanceof FormCancelledError)).toBe(true);
      expect(formManager.hasPendingForms()).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should ignore response for unknown request ID', () => {
      // Should not throw
      simulateFormSubmit(activityStream, 'nonexistent-id', { data: 'ignored' });
    });

    it('should ignore cancel for unknown request ID', () => {
      // Should not throw
      simulateFormCancel(activityStream, 'nonexistent-id');
    });

    it('should handle cancelAllPending when no forms pending', () => {
      expect(formManager.hasPendingForms()).toBe(false);

      // Should not throw
      formManager.cancelAllPending();

      expect(formManager.hasPendingForms()).toBe(false);
    });

    it('should not process duplicate responses', async () => {
      const schema = createFormSchema();
      let requestId: string = '';

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        requestId = event.data.requestId;
        // Submit once
        simulateFormSubmit(activityStream, requestId, { first: true });
      });

      const result = await formManager.requestForm('TestTool', schema);
      expect(result).toEqual({ first: true });

      // Second response should be ignored (form already removed)
      simulateFormSubmit(activityStream, requestId, { second: true });

      // No error should occur, form is already resolved
      expect(formManager.hasPendingForms()).toBe(false);
    });

    it('should handle form with many fields', async () => {
      const schema = createFormSchema(50);

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        const data: Record<string, any> = {};
        for (let i = 0; i < 50; i++) {
          data[`field${i}`] = `value${i}`;
        }
        simulateFormSubmit(activityStream, event.data.requestId, data);
      });

      const result = await formManager.requestForm('TestTool', schema);

      expect(Object.keys(result).length).toBe(50);
      expect(result.field0).toBe('value0');
      expect(result.field49).toBe('value49');
    });

    it('should handle form data with nested objects', async () => {
      const schema = createFormSchema();
      const complexData = {
        nested: { deeply: { value: 42 } },
        array: [1, 2, 3],
        mixed: { items: ['a', 'b'], count: 2 },
      };

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        simulateFormSubmit(activityStream, event.data.requestId, complexData);
      });

      const result = await formManager.requestForm('TestTool', schema);

      expect(result).toEqual(complexData);
    });
  });

  describe('Integration Patterns', () => {
    it('should support async/await pattern', async () => {
      const schema = createFormSchema();

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        // Simulate user thinking time
        setTimeout(() => {
          simulateFormSubmit(activityStream, event.data.requestId, { value: 'async' });
        }, 10);
      });

      const result = await formManager.requestForm('TestTool', schema);

      expect(result.value).toBe('async');
    });

    it('should support try/catch pattern for cancellation', async () => {
      const schema = createFormSchema();
      let caught = false;

      activityStream.subscribe(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
        simulateFormCancel(activityStream, event.data.requestId);
      });

      try {
        await formManager.requestForm('TestTool', schema);
      } catch (error) {
        if (error instanceof FormCancelledError) {
          caught = true;
        }
      }

      expect(caught).toBe(true);
    });

    it('should work with Promise.race for timeout pattern', async () => {
      const schema = createFormSchema();

      // Don't respond to simulate timeout
      const formPromise = formManager.requestForm('TestTool', schema);
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 50);
      });

      const result = await Promise.race([formPromise, timeoutPromise]);

      expect(result).toBe('timeout');

      // Cleanup
      formManager.cancelAllPending();
    });
  });
});
