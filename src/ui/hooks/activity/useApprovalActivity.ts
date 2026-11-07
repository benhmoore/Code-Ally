/** Terminal activity domain: approval. */
import { ActivityEventType } from '@shared/index.js';
import type { FormRequest } from '@shared/index.js';
import { logger } from '@services/Logger.js';
import { sendTerminalNotification } from '../../../utils/terminal.js';
import type { ActivitySubscriptionContext } from './ActivitySubscriptionContext.js';
import { useDomainActivityEvent } from './useDomainActivityEvent.js';

export function useApprovalActivity({ modal, lifetime }: ActivitySubscriptionContext) {
  useDomainActivityEvent(
    ActivityEventType.PERMISSION_REQUEST,
    event => {
      if (!event.id) {
        throw new Error(`PERMISSION_REQUEST event missing required 'id' field`);
      }

      const {
        requestId,
        toolName,
        path,
        command,
        arguments: args,
        sensitivity,
        options,
        decisionReason,
      } = event.data || {};

      if (!requestId) {
        throw new Error(`PERMISSION_REQUEST event missing required 'requestId' field. ID: ${event.id}`);
      }

      modal.addPermissionRequest({
        requestId,
        toolName,
        path,
        command,
        arguments: args,
        sensitivity,
        options,
        decisionReason,
      });

      // Send terminal bell to notify user of permission prompt
      sendTerminalNotification();
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.PERMISSION_RESPONSE,
    event => {
      const { requestId } = event.data || {};
      if (requestId) {
        modal.removePermissionRequest(requestId);
      } else {
        // Fallback: clear current if no requestId provided
        modal.setPermissionRequest(undefined);
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.PLAN_APPROVAL_REQUEST,
    event => {
      const { planFilePath, planContent } = event.data || {};

      if (!planFilePath || !planContent) {
        logger.warn('[useActivitySubscriptions] Invalid PLAN_APPROVAL_REQUEST: missing required fields');
        return;
      }

      modal.setPlanApprovalRequest({ planFilePath, planContent });
      modal.setPlanApprovalSelectedIndex(0);
      modal.setPlanApprovalFeedbackText('');
      modal.setPlanApprovalCursorPosition(0);
      sendTerminalNotification();
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.PLAN_APPROVAL_RESPONSE,
    () => {
      modal.setPlanApprovalRequest(undefined);
      modal.setPlanApprovalSelectedIndex(0);
      modal.setPlanApprovalFeedbackText('');
      modal.setPlanApprovalCursorPosition(0);
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.TOOL_FORM_REQUEST,
    event => {
      const { requestId, toolName, schema, initialValues, callId } = event.data || {};

      // Validate required fields
      if (!requestId || !toolName || !schema) {
        logger.warn('[useActivitySubscriptions] Invalid TOOL_FORM_REQUEST: missing required fields', {
          hasRequestId: !!requestId,
          hasToolName: !!toolName,
          hasSchema: !!schema,
        });
        return;
      }

      const formRequest: FormRequest = {
        requestId,
        toolName,
        schema,
        initialValues: initialValues || {},
        callId,
      };
      modal.addToolFormRequest(formRequest);
      sendTerminalNotification();
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.TOOL_FORM_RESPONSE,
    event => {
      const { requestId } = event.data;
      if (requestId) {
        modal.removeToolFormRequest(requestId);
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.TOOL_FORM_CANCEL,
    event => {
      const { requestId } = event.data;
      if (requestId) {
        modal.removeToolFormRequest(requestId);
      }
    },
    lifetime
  );
}
