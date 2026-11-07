/** Observe detached activity handlers and gate publication from superseded work. */
import { ActivityEventType } from '@shared/index.js';
import { logger } from '@services/Logger.js';
import { useActivityEvent } from '../useActivityEvent.js';
import type { DomainActivityEvent } from './ActivityDomainEvents.js';
import type { ActivityRequestScope } from './ActivityRequestScope.js';

// Only explicit terminal intents supersede pending UI work. Completion/status
// events from ongoing tools must not accidentally cancel an unrelated request.
const admissionEvents: ReadonlySet<ActivityEventType> = new Set([
  ActivityEventType.PERMISSION_REQUEST,
  ActivityEventType.PERMISSION_RESPONSE,
  ActivityEventType.PLAN_APPROVAL_REQUEST,
  ActivityEventType.PLAN_APPROVAL_RESPONSE,
  ActivityEventType.TOOL_FORM_REQUEST,
  ActivityEventType.TOOL_FORM_RESPONSE,
  ActivityEventType.TOOL_FORM_CANCEL,
  ActivityEventType.MODEL_SELECT_REQUEST,
  ActivityEventType.MODEL_SELECT_RESPONSE,
  ActivityEventType.SETUP_WIZARD_REQUEST,
  ActivityEventType.SETUP_WIZARD_COMPLETE,
  ActivityEventType.SETUP_WIZARD_SKIP,
  ActivityEventType.PROJECT_WIZARD_REQUEST,
  ActivityEventType.PROJECT_WIZARD_COMPLETE,
  ActivityEventType.PROJECT_WIZARD_SKIP,
  ActivityEventType.AGENT_WIZARD_REQUEST,
  ActivityEventType.AGENT_WIZARD_COMPLETE,
  ActivityEventType.AGENT_WIZARD_SKIP,
  ActivityEventType.AGENT_USE_REQUEST,
  ActivityEventType.CONFIG_UPDATED,
  ActivityEventType.REWIND_REQUEST,
  ActivityEventType.REWIND_RESPONSE,
  ActivityEventType.UNDO_FILE_LIST_REQUEST,
  ActivityEventType.UNDO_FILE_SELECTED,
  ActivityEventType.UNDO_FILE_BACK,
  ActivityEventType.UNDO_CONFIRM,
  ActivityEventType.UNDO_CANCELLED,
  ActivityEventType.SESSION_SELECT_REQUEST,
  ActivityEventType.SESSION_SELECT_RESPONSE,
  ActivityEventType.LIBRARY_SELECT_REQUEST,
  ActivityEventType.LIBRARY_SELECT_RESPONSE,
  ActivityEventType.PROMPT_MESSAGE_SELECT_REQUEST,
  ActivityEventType.PROMPT_MESSAGE_SELECT_RESPONSE,
  ActivityEventType.PROMPT_ADD_REQUEST,
  ActivityEventType.PROMPT_ADD_RESPONSE,
  ActivityEventType.LIBRARY_CLEAR_CONFIRM_REQUEST,
  ActivityEventType.LIBRARY_CLEAR_CONFIRM_RESPONSE,
  ActivityEventType.USER_INTERRUPT_INITIATED,
  ActivityEventType.CONVERSATION_CLEAR,
  ActivityEventType.AGENT_SWITCHED,
]);

export function useDomainActivityEvent<T extends ActivityEventType>(
  type: T,
  handler: (event: DomainActivityEvent<T>, isCurrent: () => boolean) => void | Promise<void>,
  scope: ActivityRequestScope
): void {
  useActivityEvent(type, event => {
    if (admissionEvents.has(type)) scope.invalidate();
    const isCurrent = scope.capture();
    try {
      // Legacy command producers share the broad activity bus; this domain owns their contracts.
      const completion = handler(event as DomainActivityEvent<T>, isCurrent);
      if (completion) void completion.catch(error => logger.error(`[Activity:${type}]`, error));
    } catch (error) {
      logger.error(`[Activity:${type}]`, error);
    }
  });
}
