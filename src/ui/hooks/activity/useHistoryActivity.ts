/** Terminal activity domain: history. */
import { useEffect, useMemo } from 'react';
import { ActivityEventType } from '@shared/index.js';
import { restoreSessionForAgent } from '../useSessionResume.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { UndoCoordinator } from '@services/UndoCoordinator.js';
import { SessionRestoreCoordinator } from '@services/SessionRestoreCoordinator.js';
import type { ActivitySubscriptionContext } from './ActivitySubscriptionContext.js';
import { useDomainActivityEvent } from './useDomainActivityEvent.js';

export function useHistoryActivity({ actions, modal, agent, lifetime }: ActivitySubscriptionContext) {
  const undoCoordinator = useMemo(
    () =>
      new UndoCoordinator({
        getPatchManager: () => ServiceRegistry.getInstance().get('patch_manager'),
        getAgent: () => agent,
        getTodoManager: () => ServiceRegistry.getInstance().get('todo_manager'),
        getTokenManager: () => ServiceRegistry.getInstance().get('token_manager'),
      }),
    [agent]
  );

  const sessionRestoreCoordinator = useMemo(
    () =>
      new SessionRestoreCoordinator({
        getSessionManager: () => ServiceRegistry.getInstance().get('session_manager'),
        getPatchManager: () => ServiceRegistry.getInstance().get('patch_manager'),
      }),
    []
  );

  const setRewindRequest = modal.setRewindRequest;
  useEffect(() => {
    if (modal.rewindRequest && modal.rewindRequest.targets === null) {
      // Derived from the agent's history (the array the rewind truncates), not
      // from the React transcript — the two can disagree, and acting on the
      // wrong one reverts the user's files to the wrong point.
      const selection = undoCoordinator.resolveRewindSelection();

      if (!selection) {
        setRewindRequest(undefined);
        actions.addMessage({
          role: 'assistant',
          content: undoCoordinator.noUserMessagesMessage,
        });
        return;
      }

      setRewindRequest({
        ...modal.rewindRequest,
        targets: selection.targets,
        selectedIndex: selection.selectedIndex,
      });
    }
  }, [modal.rewindRequest, actions, setRewindRequest, undoCoordinator]);

  useDomainActivityEvent(
    ActivityEventType.REWIND_REQUEST,
    event => {
      const { requestId } = event.data;

      const view = agent.getSession().getSnapshot();
      const readiness = undoCoordinator.checkRewindReadiness(view.isThinking, view.activeToolCalls);
      if (!readiness.allowed) {
        actions.addMessage({
          role: 'assistant',
          content: readiness.message ?? '',
        });
        return;
      }

      modal.setRewindRequest({
        requestId,
        targets: null,
        selectedIndex: -1,
      });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.UNDO_FILE_LIST_REQUEST,
    event => {
      const { requestId, fileList } = event.data;

      if (!requestId || !fileList) {
        throw new Error(`UNDO_FILE_LIST_REQUEST event missing required fields. ID: ${event.id}`);
      }

      modal.setUndoFileListRequest({
        requestId,
        fileList,
        selectedIndex: 0,
      });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.UNDO_FILE_SELECTED,
    async (event, isCurrent) => {
      const { patchNumber, filePath } = event.data;

      const outcome = await undoCoordinator.previewPatch(patchNumber, filePath);
      if (!isCurrent()) return;

      if (outcome.status === 'error') {
        actions.addMessage({
          role: 'assistant',
          content: outcome.message,
        });
        return;
      }

      modal.setUndoRequest({
        requestId: undoCoordinator.buildUndoRequestId(outcome.patchNumber),
        count: 1,
        patches: [{ patch_number: outcome.patchNumber, file_path: outcome.filePath }],
        previewData: [outcome.preview],
      });
      modal.setUndoSelectedIndex(0);
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.UNDO_FILE_BACK,
    () => {
      modal.setUndoRequest(undefined);
      modal.setUndoSelectedIndex(0);
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.UNDO_CONFIRM,
    async (event, isCurrent) => {
      const { requestId } = event.data;

      const outcome = await undoCoordinator.applyUndo(requestId);
      if (!isCurrent()) return;

      // The confirm modal is only dismissed once the undo has actually settled,
      // so a rejected undo leaves the prompt up instead of half-closing the flow.
      if (outcome.closeUndoRequest) {
        modal.setUndoRequest(undefined);
        modal.setUndoSelectedIndex(0);
      }

      for (const content of outcome.messages) {
        actions.addMessage({ role: 'assistant', content });
      }

      if (outcome.fileList) {
        if (outcome.fileList.length > 0) {
          modal.setUndoFileListRequest({
            requestId: `undo_${Date.now()}`,
            fileList: outcome.fileList,
            selectedIndex: 0,
          });
        } else {
          modal.setUndoFileListRequest(undefined);
        }
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.UNDO_CANCELLED,
    () => {
      modal.setUndoFileListRequest(undefined);
      modal.setUndoRequest(undefined);
      modal.setUndoSelectedIndex(0);
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.SESSION_SELECT_REQUEST,
    async (event, isCurrent) => {
      const { requestId } = event.data;

      // Both failure modes (no session manager, listing threw) are deliberately
      // silent for the user; the coordinator logs them.
      const outcome = await sessionRestoreCoordinator.listSessions();
      if (!isCurrent()) return;
      if (outcome.status !== 'ok') return;

      modal.setSessionSelectRequest({
        requestId,
        sessions: outcome.sessions,
        selectedIndex: 0,
      });
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.SESSION_SELECT_RESPONSE,
    async (event, isCurrent) => {
      const { sessionId, cancelled } = event.data;

      modal.setSessionSelectRequest(undefined);

      if (!cancelled && sessionId) {
        // The loader closes over the currently foreground agent, so it is passed
        // per call rather than injected once.
        const outcome = await restoreSessionForAgent(sessionRestoreCoordinator, sessionId, agent, actions, isCurrent);
        if (!isCurrent()) return;

        if (outcome.status === 'error') {
          // Surface the failure instead of leaving the UI in an indeterminate
          // state with no feedback about why the session didn't load.
          actions.addMessage({
            role: 'assistant',
            content: outcome.message,
            timestamp: Date.now(),
          });
        }
      }
    },
    lifetime
  );

  useDomainActivityEvent(
    ActivityEventType.REWIND_RESPONSE,
    async (event, isCurrent) => {
      const { selectedIndex, cancelled, options } = event.data;

      modal.setRewindRequest(undefined);

      if (cancelled || selectedIndex === undefined) {
        // Drop the presented targets so a later event-driven rewind can't resolve
        // its index against an abandoned selection.
        undoCoordinator.cancelRewindSelection();
      }

      if (!cancelled && selectedIndex !== undefined) {
        try {
          // Restore files and rewind conversation history (all business logic
          // lives in UndoCoordinator; this handler only repaints the UI).
          const { targetTimestamp, targetMessageContent, restoredFiles, failedRestorations } =
            await undoCoordinator.performRewind(selectedIndex, options);
          if (!isCurrent()) return;

          actions.clearRewindNotices();

          undoCoordinator.clearTodos();

          // UndoCoordinator already replaced the owner's transcript and tools.
          actions.repaintConversationSurface();

          // Update context usage after rewind (same as session resumption)
          const contextUsage = undoCoordinator.refreshContextUsage();
          if (contextUsage !== undefined) {
            actions.setContextUsage(contextUsage);
          }

          // Publish after the surface reset, unless this frontend has unmounted.
          setImmediate(() => {
            // Bail if the component unmounted while the conversation view was clearing.
            if (!isCurrent()) return;

            // Add rewind notice at the target message timestamp (or slightly after if no timestamp)
            // This ensures the notice appears at the rewind point in the timeline, not at the end
            const noticeTimestamp = targetTimestamp ? targetTimestamp + 1 : Date.now();

            actions.addRewindNotice({
              id: `rewind_${Date.now()}`,
              timestamp: noticeTimestamp,
              targetMessageIndex: selectedIndex,
              restoredFiles: restoredFiles.length > 0 ? restoredFiles : undefined,
              failedRestorations: failedRestorations.length > 0 ? failedRestorations : undefined,
            });
          });

          modal.setInputPrefillText(targetMessageContent);
        } catch (error) {
          if (!isCurrent()) return;
          actions.addMessage({
            role: 'assistant',
            content: `Error rewinding conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      }
    },
    lifetime
  );
}
