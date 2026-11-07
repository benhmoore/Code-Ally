/** Payload contracts for terminal commands that have not moved to the shared event map. */
import {
  ActivityEventType as E,
  type ActivityEvent,
  type ActivityEventData,
  type Config,
  type FormRequest,
  type Message,
} from '@shared/index.js';
import type { RewindOptions } from '@services/UndoCoordinator.js';
import type {
  PermissionRequestWithId,
  ModelSelectRequest,
  MessageSelectRequest,
  PromptAddRequest,
  UndoFileListRequest,
  LibraryClearConfirmRequest,
} from '../useModalState.js';
import type { PlanApprovalRequest } from '../../components/PlanApprovalPrompt.js';

interface ActivityDomainPayloads {
  [E.SYSTEM_PROMPT_DISPLAY]: { agentType?: string; systemPrompt?: string };
  [E.AGENT_START]: { isSpecializedAgent?: boolean; agentName?: string };
  [E.AGENT_END]: { isSpecializedAgent?: boolean; agentName?: string };
  [E.PERMISSION_REQUEST]: PermissionRequestWithId;
  [E.PERMISSION_RESPONSE]: { requestId?: string };
  [E.PLAN_APPROVAL_REQUEST]: PlanApprovalRequest;
  [E.TOOL_FORM_REQUEST]: FormRequest;
  [E.TOOL_FORM_RESPONSE]: { requestId?: string };
  [E.TOOL_FORM_CANCEL]: { requestId?: string };
  [E.MODEL_SELECT_REQUEST]: ModelSelectRequest;
  [E.MODEL_SELECT_RESPONSE]: { requestId?: string; modelName?: string; modelType?: 'ally' | 'service' };
  [E.CONFIG_UPDATED]: Partial<Config>;
  [E.AGENT_WIZARD_REQUEST]: { initialDescription?: string };
  [E.AGENT_WIZARD_COMPLETE]: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    tools?: string[];
    model?: string;
  };
  [E.AGENT_USE_REQUEST]: { agentName?: string; taskPrompt?: string };
  [E.REWIND_REQUEST]: { requestId: string };
  [E.REWIND_RESPONSE]: { selectedIndex?: number; cancelled?: boolean; options?: RewindOptions };
  [E.UNDO_FILE_LIST_REQUEST]: Pick<UndoFileListRequest, 'requestId' | 'fileList'>;
  [E.UNDO_FILE_SELECTED]: { patchNumber: number; filePath: string };
  [E.UNDO_CONFIRM]: { requestId: string };
  [E.SESSION_SELECT_REQUEST]: { requestId: string };
  [E.SESSION_SELECT_RESPONSE]: { sessionId?: string; cancelled?: boolean };
  [E.LIBRARY_SELECT_RESPONSE]: { promptId?: string; cancelled?: boolean };
  [E.PROMPT_MESSAGE_SELECT_REQUEST]: MessageSelectRequest;
  [E.PROMPT_MESSAGE_SELECT_RESPONSE]: { selectedMessage?: Message; cancelled?: boolean };
  [E.PROMPT_ADD_REQUEST]: Partial<PromptAddRequest> & { requestId: string };
  [E.LIBRARY_CLEAR_CONFIRM_REQUEST]: Omit<LibraryClearConfirmRequest, 'selectedIndex'> & { selectedIndex?: number };
  [E.LIBRARY_CLEAR_CONFIRM_RESPONSE]: { confirmed?: boolean; cancelled?: boolean };
  [E.PROMPT_ADD_RESPONSE]: { promptId?: string; title?: string; content?: string; tags?: string; cancelled?: boolean };
}

export type DomainActivityEvent<T extends E> = Omit<ActivityEvent<T>, 'data'> & {
  data: T extends keyof ActivityDomainPayloads ? ActivityDomainPayloads[T] : ActivityEventData<T>;
};
