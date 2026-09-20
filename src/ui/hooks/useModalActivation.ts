/**
 * useModalActivation - The one place a modal's choice becomes an event.
 *
 * Every selector answers its request on the ActivityStream. The keyboard
 * cascade in InputPrompt (Enter and Escape) and a pointer click on an option
 * row both run these handlers, so a click is a selection followed by exactly
 * what Enter does, with nothing duplicated between the two input paths.
 */

import { useMemo, useRef } from 'react';
import type { ActivityStream } from '@services/ActivityStream.js';
import { ActivityEventType, type ActivityEvent } from '@shared/index.js';
import { PermissionChoice } from '@agent/TrustManager.js';
import type { ModalState } from './useModalState.js';

/** A modal that is answered by choosing one option or cancelling. */
export interface ModalChoice {
  /** Answer with the option at `index`. */
  activate: (index: number) => void;
  /** Dismiss without choosing; repeated cancels of one request are ignored. */
  cancel: () => void;
}

export interface ModalActivation {
  model: ModalChoice;
  session: ModalChoice;
  message: ModalChoice & { createNew: () => void };
  library: ModalChoice;
  rewind: ModalChoice;
  libraryClearConfirm: ModalChoice;
  undoFileList: ModalChoice;
  undo: ModalChoice;
  planApproval: ModalChoice;
  permission: ModalChoice;
}

type ModalRequests = Pick<
  ModalState,
  | 'modelSelectRequest'
  | 'sessionSelectRequest'
  | 'messageSelectRequest'
  | 'librarySelectRequest'
  | 'rewindRequest'
  | 'libraryClearConfirmRequest'
  | 'undoFileListRequest'
  | 'undoRequest'
  | 'planApprovalRequest'
  | 'planApprovalFeedbackText'
  | 'permissionRequest'
  | 'permissionInstructText'
>;

export interface ModalActivationDeps {
  activityStream?: ActivityStream;
  modal: ModalRequests;
  /** Rewind's Enter opens the options step instead of answering the request. */
  onRewindSelect: (index: number) => void;
  /** The permission "Tell the assistant…" option submits its text as an interjection. */
  onPermissionInstruct: (text: string) => void;
}

/** INSTRUCT options are dynamic strings like "Tell Assistant what to do instead..." */
export function isInstructOption(option: unknown): boolean {
  return typeof option === 'string' && option.startsWith('Tell ') && option.endsWith('...');
}

export function useModalActivation(deps: ModalActivationDeps): ModalActivation {
  // Handlers are stable; they read the request that is open when they run.
  const latest = useRef(deps);
  latest.current = deps;
  const lastCancelledId = useRef<string | null>(null);

  return useMemo(() => {
    const emit = (event: ActivityEvent, failure: string): void => {
      try {
        latest.current.activityStream?.emit(event);
      } catch (error) {
        console.error(`[ModalActivation] ${failure}:`, error);
      }
    };
    const now = () => Date.now();

    /** Run `cancel` once per request, however many times Escape is pressed. */
    const once = (requestId: string | undefined, cancel: () => void): void => {
      if (!requestId || lastCancelledId.current === requestId) return;
      lastCancelledId.current = requestId;
      cancel();
    };

    return {
      model: {
        activate: (index) => {
          const request = latest.current.modal.modelSelectRequest;
          const selected = request?.models[index];
          if (!request || !selected) return;
          emit({
            id: `response_${request.requestId}`,
            type: ActivityEventType.MODEL_SELECT_RESPONSE,
            timestamp: now(),
            data: { requestId: request.requestId, modelName: selected.name, modelType: request.modelType },
          }, 'Failed to emit model selection');
        },
        cancel: () => {
          const request = latest.current.modal.modelSelectRequest;
          once(request?.requestId, () => emit({
            id: `response_${request!.requestId}_cancel`,
            type: ActivityEventType.MODEL_SELECT_RESPONSE,
            timestamp: now(),
            data: { requestId: request!.requestId, modelName: null, modelType: request!.modelType },
          }, 'Failed to emit model cancellation'));
        },
      },

      session: {
        activate: (index) => {
          const request = latest.current.modal.sessionSelectRequest;
          const selected = request?.sessions[index];
          if (!request || !selected) return;
          emit({
            id: `response_${request.requestId}`,
            type: ActivityEventType.SESSION_SELECT_RESPONSE,
            timestamp: now(),
            data: { requestId: request.requestId, sessionId: selected.session_id, cancelled: false },
          }, 'Failed to emit session selection');
        },
        cancel: () => {
          const request = latest.current.modal.sessionSelectRequest;
          once(request?.requestId, () => emit({
            id: `response_${request!.requestId}_cancel`,
            type: ActivityEventType.SESSION_SELECT_RESPONSE,
            timestamp: now(),
            data: { requestId: request!.requestId, sessionId: null, cancelled: true },
          }, 'Failed to emit session cancellation'));
        },
      },

      message: {
        activate: (index) => {
          const request = latest.current.modal.messageSelectRequest;
          const selected = request?.messages[index];
          if (!request || !selected) return;
          emit({
            id: `response_${request.requestId}`,
            type: ActivityEventType.PROMPT_MESSAGE_SELECT_RESPONSE,
            timestamp: now(),
            data: { requestId: request.requestId, selectedMessage: selected, cancelled: false },
          }, 'Failed to emit message selection');
        },
        createNew: () => {
          const request = latest.current.modal.messageSelectRequest;
          if (!request) return;
          emit({
            id: `response_${request.requestId}_new`,
            type: ActivityEventType.PROMPT_MESSAGE_SELECT_RESPONSE,
            timestamp: now(),
            data: { requestId: request.requestId, selectedMessage: undefined, cancelled: false },
          }, 'Failed to emit new prompt request');
        },
        cancel: () => {
          const request = latest.current.modal.messageSelectRequest;
          once(request?.requestId, () => emit({
            id: `response_${request!.requestId}_cancel`,
            type: ActivityEventType.PROMPT_MESSAGE_SELECT_RESPONSE,
            timestamp: now(),
            data: { requestId: request!.requestId, cancelled: true },
          }, 'Failed to emit message selection cancellation'));
        },
      },

      library: {
        activate: (index) => {
          const request = latest.current.modal.librarySelectRequest;
          const selected = request?.prompts[index];
          if (!request || !selected) return;
          emit({
            id: `response_${request.requestId}`,
            type: ActivityEventType.LIBRARY_SELECT_RESPONSE,
            timestamp: now(),
            data: { requestId: request.requestId, promptId: selected.id, cancelled: false },
          }, 'Failed to emit library selection');
        },
        cancel: () => {
          const request = latest.current.modal.librarySelectRequest;
          once(request?.requestId, () => emit({
            id: `response_${request!.requestId}_cancel`,
            type: ActivityEventType.LIBRARY_SELECT_RESPONSE,
            timestamp: now(),
            data: { requestId: request!.requestId, cancelled: true },
          }, 'Failed to emit library cancellation'));
        },
      },

      rewind: {
        activate: (index) => {
          if (latest.current.modal.rewindRequest) latest.current.onRewindSelect(index);
        },
        cancel: () => {
          const request = latest.current.modal.rewindRequest;
          once(request?.requestId, () => emit({
            id: `response_${request!.requestId}_cancel`,
            type: ActivityEventType.REWIND_RESPONSE,
            timestamp: now(),
            data: { requestId: request!.requestId, cancelled: true },
          }, 'Failed to emit rewind cancellation'));
        },
      },

      libraryClearConfirm: {
        activate: (index) => {
          const request = latest.current.modal.libraryClearConfirmRequest;
          if (!request) return;
          emit({
            id: `response_${request.requestId}`,
            type: ActivityEventType.LIBRARY_CLEAR_CONFIRM_RESPONSE,
            timestamp: now(),
            data: { requestId: request.requestId, confirmed: index === 0, cancelled: false },
          }, 'Failed to emit library clear confirmation');
        },
        cancel: () => {
          const request = latest.current.modal.libraryClearConfirmRequest;
          once(request?.requestId, () => emit({
            id: `response_${request!.requestId}_cancel`,
            type: ActivityEventType.LIBRARY_CLEAR_CONFIRM_RESPONSE,
            timestamp: now(),
            data: { requestId: request!.requestId, confirmed: false, cancelled: true },
          }, 'Failed to emit library clear cancellation'));
        },
      },

      undoFileList: {
        activate: (index) => {
          const request = latest.current.modal.undoFileListRequest;
          const selected = request?.fileList[index];
          if (!request || !selected) return;
          emit({
            id: `undo_file_selected_${now()}`,
            type: ActivityEventType.UNDO_FILE_SELECTED,
            timestamp: now(),
            data: { requestId: request.requestId, patchNumber: selected.patch_number, filePath: selected.file_path },
          }, 'Failed to emit file selection');
        },
        cancel: () => {
          const request = latest.current.modal.undoFileListRequest;
          once(request?.requestId, () => emit({
            id: `undo_cancelled_${now()}`,
            type: ActivityEventType.UNDO_CANCELLED,
            timestamp: now(),
            data: { requestId: request!.requestId },
          }, 'Failed to emit undo cancellation'));
        },
      },

      undo: {
        activate: (index) => {
          const request = latest.current.modal.undoRequest;
          if (!request) return;
          // 0 = Confirm, 1 = Cancel (back to the file list)
          if (index === 0) {
            emit({
              id: `undo_confirm_${now()}`,
              type: ActivityEventType.UNDO_CONFIRM,
              timestamp: now(),
              data: { requestId: request.requestId },
            }, 'Failed to emit undo response');
          } else {
            emit({
              id: `undo_file_back_${now()}`,
              type: ActivityEventType.UNDO_FILE_BACK,
              timestamp: now(),
              data: { requestId: request.requestId },
            }, 'Failed to emit undo response');
          }
        },
        cancel: () => {
          const request = latest.current.modal.undoRequest;
          once(request?.requestId, () => emit({
            id: `undo_file_back_${now()}`,
            type: ActivityEventType.UNDO_FILE_BACK,
            timestamp: now(),
            data: { requestId: request!.requestId },
          }, 'Failed to emit undo back'));
        },
      },

      planApproval: {
        activate: (index) => {
          const { planApprovalRequest, planApprovalFeedbackText } = latest.current.modal;
          if (!planApprovalRequest) return;
          const respond = (data: Record<string, unknown>) => emit({
            id: `plan_response_${now()}`,
            type: ActivityEventType.PLAN_APPROVAL_RESPONSE,
            timestamp: now(),
            data,
          }, 'Failed to emit plan approval response');
          if (index === 0) {
            respond({ choice: 'approve' });
          } else if (index === 1) {
            respond({ choice: 'approve_clear_context' });
          } else if (index === 2 && planApprovalFeedbackText.trim()) {
            // Empty feedback is not an answer; the option stays selected for typing.
            respond({ choice: 'feedback', feedback: planApprovalFeedbackText });
          }
        },
        cancel: () => {
          if (!latest.current.modal.planApprovalRequest) return;
          emit({
            id: `plan_response_${now()}`,
            type: ActivityEventType.PLAN_APPROVAL_RESPONSE,
            timestamp: now(),
            data: { choice: 'feedback', feedback: 'Plan rejected by user.' },
          }, 'Failed to emit plan rejection');
        },
      },

      permission: {
        activate: (index) => {
          const { permissionRequest, permissionInstructText } = latest.current.modal;
          const choice = permissionRequest?.options[index];
          if (!permissionRequest || !choice) return;
          const respond = (answer: PermissionChoice, suffix = '') => emit({
            id: `response_${permissionRequest.requestId}${suffix}`,
            type: ActivityEventType.PERMISSION_RESPONSE,
            timestamp: now(),
            data: { requestId: permissionRequest.requestId, choice: answer },
          }, 'Failed to emit permission response');
          if (isInstructOption(choice)) {
            // An instruction denies the operation and tells the assistant what to do instead.
            if (!permissionInstructText.trim()) return;
            latest.current.onPermissionInstruct(permissionInstructText);
            respond(PermissionChoice.DENY);
            return;
          }
          respond(choice);
        },
        cancel: () => {
          const request = latest.current.modal.permissionRequest;
          once(request?.requestId, () => emit({
            id: `response_${request!.requestId}_cancel`,
            type: ActivityEventType.PERMISSION_RESPONSE,
            timestamp: now(),
            data: { requestId: request!.requestId, choice: PermissionChoice.DENY },
          }, 'Failed to emit permission denial'));
        },
      },
    };
  }, []);
}
