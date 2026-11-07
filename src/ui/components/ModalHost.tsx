/** Render the top modal with one status boundary and one keyboard owner. */
import React from 'react';
import { Box } from 'ink';
import { ActivityEventType } from '@shared/index.js';
import type { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { useModalActivation, type ModalChoice } from '../hooks/useModalActivation.js';
import type { ModalState } from '../hooks/useModalState.js';
import { useRewindPreview } from '../hooks/useRewindPreview.js';
import { ModalKeyboardInput } from './ModalKeyboardInput.js';
import { SetupWizardView } from './SetupWizardView.js';
import { ProjectWizardView } from './ProjectWizardView.js';
import { AgentWizardView } from './AgentWizardView.js';
import { SessionSelector } from './SessionSelector.js';
import { PromptLibrarySelector } from './PromptLibrarySelector.js';
import { MessageSelector } from './MessageSelector.js';
import { PromptAddWizard } from './PromptAddWizard.js';
import { ModelSelector } from './ModelSelector.js';
import { RewindSelector } from './RewindSelector.js';
import { RewindOptionsSelector } from './RewindOptionsSelector.js';
import { UndoFileList } from './UndoFileList.js';
import { UndoPrompt } from './UndoPrompt.js';
import { LibraryClearConfirmation } from './LibraryClearConfirmation.js';
import { ToolFormWizard } from './ToolFormWizard.js';
import { PlanApprovalPrompt } from './PlanApprovalPrompt.js';
import { PermissionPrompt } from './PermissionPrompt.js';

interface ModalHostProps {
  modal: ModalState;
  activityStream: ActivityStream;
  status: React.ReactNode;
  children: React.ReactNode;
  onPermissionInstruct: (text: string) => void;
  reportError: (message: string) => void;
}

type Selection = NonNullable<React.ComponentProps<typeof ModalKeyboardInput>['selection']>;
interface Presentation { content: React.ReactNode; selection?: Selection }

const press = (navigate: (index: number) => void, choice: ModalChoice) => (index: number) => {
  navigate(index);
  choice.activate(index);
};
function select(content: React.ReactNode, count: number, selectedIndex: number,
  navigate: (index: number) => void, choice: ModalChoice, createNew?: () => void): Presentation {
  return { content, selection: { count, selectedIndex, navigate, activate: choice.activate, cancel: choice.cancel, createNew } };
}

/** Wizards own their editors; choice dialogs share selection input without an editor. */
export function ModalHost({ modal, activityStream, status, children, onPermissionInstruct, reportError }: ModalHostProps) {
  const rewind = useRewindPreview(modal.rewindRequest, ServiceRegistry.getInstance().get('patch_manager') ?? undefined, modal.setRewindOptionsRequest, reportError);
  const activation = useModalActivation({ activityStream, modal, onRewindSelect: rewind.select, onPermissionInstruct });
  const entry = modal.activeModal;
  if (!entry) return children;
  const emit = (type: ActivityEventType, data: Record<string, unknown> = {}, id = `${type}_${Date.now()}`) => {
    try { activityStream.emit({ id, type, timestamp: Date.now(), data }); }
    catch (error) { reportError(`Unable to answer dialog: ${String(error)}`); }
  };
  const presentation = (): Presentation => {
    switch (entry.kind) {
      case 'setupWizard':
        return { content: <SetupWizardView onComplete={() => emit(ActivityEventType.SETUP_WIZARD_COMPLETE)} onSkip={() => emit(ActivityEventType.SETUP_WIZARD_SKIP)}/> };
      case 'projectWizard':
        return { content: <ProjectWizardView onComplete={() => emit(ActivityEventType.PROJECT_WIZARD_COMPLETE)} onSkip={() => emit(ActivityEventType.PROJECT_WIZARD_SKIP)}/> };
      case 'agentWizard':
        return { content: <AgentWizardView initialDescription={modal.agentWizardData.initialDescription}
          onComplete={data => emit(ActivityEventType.AGENT_WIZARD_COMPLETE, data)} onCancel={() => emit(ActivityEventType.AGENT_WIZARD_SKIP)}/> };
      case 'session': {
        const navigate = (selectedIndex: number) => modal.setSessionSelectRequest({ ...entry.request, selectedIndex });
        return select(<SessionSelector {...entry.request} visible onOptionPress={press(navigate, activation.session)}/>,
          entry.request.sessions.length, entry.request.selectedIndex, navigate, activation.session);
      }
      case 'library': {
        const navigate = (selectedIndex: number) => modal.setLibrarySelectRequest({ ...entry.request, selectedIndex });
        return select(<PromptLibrarySelector {...entry.request} visible onOptionPress={press(navigate, activation.library)}/>,
          entry.request.prompts.length, entry.request.selectedIndex, navigate, activation.library);
      }
      case 'message': {
        const navigate = (selectedIndex: number) => modal.setMessageSelectRequest({ ...entry.request, selectedIndex });
        return select(<MessageSelector {...entry.request} visible onOptionPress={press(navigate, activation.message)}/>,
          entry.request.messages.length, entry.request.selectedIndex, navigate, activation.message, activation.message.createNew);
      }
      case 'promptAdd': {
        const request = entry.request;
        return { content: <PromptAddWizard {...request}
          onFieldChange={(field, value) => modal.setPromptAddRequest({ ...request, [field]: value })}
          onFieldFocus={focusedField => modal.setPromptAddRequest({ ...request, focusedField })}
          onSubmit={() => {
            if (!request.title.trim() || !request.content.trim()) return;
            emit(ActivityEventType.PROMPT_ADD_RESPONSE, { requestId: request.requestId, promptId: request.promptId,
              title: request.title.trim(), content: request.content.trim(), tags: request.tags.trim(), cancelled: false });
          }}
          onCancel={() => emit(ActivityEventType.PROMPT_ADD_RESPONSE, { requestId: request.requestId, cancelled: true })}/> };
      }
      case 'model':
        return select(<ModelSelector {...entry.request} selectedIndex={entry.selectedIndex} visible loading={entry.loading}
          onOptionPress={press(modal.setModelSelectedIndex, activation.model)}/>, entry.request.models.length,
        entry.selectedIndex, modal.setModelSelectedIndex, activation.model);
      case 'rewindOptions':
        return { content: <RewindOptionsSelector {...entry.request} visible onConfirm={choice => {
          if (choice === 'cancel') { modal.setRewindOptionsRequest(undefined); return; }
          if (modal.rewindRequest) emit(ActivityEventType.REWIND_RESPONSE, {
            requestId: modal.rewindRequest.requestId, selectedIndex: entry.request.selectedIndex,
            cancelled: false, options: { restoreFiles: choice === 'conversation-and-files' },
          });
          modal.setRewindOptionsRequest(undefined);
          modal.setRewindRequest(undefined);
        }}/> };
      case 'rewind': {
        const navigate = (selectedIndex: number) => modal.setRewindRequest({ ...entry.request, selectedIndex });
        return select(<RewindSelector messages={entry.request.targets ?? []} selectedIndex={entry.request.selectedIndex}
          visible patches={rewind.patches} onOptionPress={press(navigate, activation.rewind)}/>,
        entry.request.targets?.length ?? 0, entry.request.selectedIndex, navigate, activation.rewind);
      }
      case 'undoFileList': {
        const navigate = (selectedIndex: number) => modal.setUndoFileListRequest({ ...entry.request, selectedIndex });
        return select(<UndoFileList request={entry.request} visible onOptionPress={press(navigate, activation.undoFileList)}/>,
          entry.request.fileList.length, entry.request.selectedIndex, navigate, activation.undoFileList);
      }
      case 'libraryClearConfirm': {
        const navigate = (selectedIndex: number) => modal.setLibraryClearConfirmRequest({ ...entry.request, selectedIndex });
        return select(<LibraryClearConfirmation promptCount={entry.request.promptCount} selectedIndex={entry.request.selectedIndex}
          visible onOptionPress={press(navigate, activation.libraryClearConfirm)}/>,
        2, entry.request.selectedIndex, navigate, activation.libraryClearConfirm);
      }
      case 'undo':
        return select(<UndoPrompt request={entry.request} selectedIndex={entry.selectedIndex} visible
          onOptionPress={press(modal.setUndoSelectedIndex, activation.undo)}/>,
        2, entry.selectedIndex, modal.setUndoSelectedIndex, activation.undo);
      case 'toolForm': {
        const request = entry.queue[0];
        if (!request) return { content: null };
        return { content: <ToolFormWizard request={request} fieldIndex={entry.fieldIndex} values={entry.values}
          errors={entry.errors} queueLength={entry.queue.length} onFieldIndexChange={modal.setToolFormFieldIndex}
          onValueChange={modal.setToolFormValue} onErrorChange={modal.setToolFormError}
          onComplete={data => emit(ActivityEventType.TOOL_FORM_RESPONSE, { requestId: request.requestId, callId: request.callId, data })}
          onCancel={() => emit(ActivityEventType.TOOL_FORM_CANCEL, { requestId: request.requestId, callId: request.callId, toolName: request.toolName })}/> };
      }
      case 'planApproval':
        return select(<PlanApprovalPrompt request={entry.request} selectedIndex={entry.selectedIndex} feedbackText={entry.feedbackText}
          onFeedbackTextChange={modal.setPlanApprovalFeedbackText} cursorPosition={entry.cursorPosition}
          onCursorChange={modal.setPlanApprovalCursorPosition} onOptionPress={press(modal.setPlanApprovalSelectedIndex, activation.planApproval)}/>,
        3, entry.selectedIndex, modal.setPlanApprovalSelectedIndex, activation.planApproval);
      case 'permission': {
        const request = entry.queue[0];
        if (!request) return { content: null };
        return select(<PermissionPrompt request={request} selectedIndex={entry.selectedIndex} visible autoAllowMode={modal.autoAllowMode}
          instructText={entry.instructText} onInstructTextChange={modal.setPermissionInstructText} cursorPosition={entry.cursorPosition}
          onCursorChange={modal.setPermissionCursorPosition} queueLength={entry.queue.length}
          onOptionPress={press(modal.setPermissionSelectedIndex, activation.permission)}/>,
        request.options.length, entry.selectedIndex, modal.setPermissionSelectedIndex, activation.permission);
      }
    }
  };
  const view = presentation();
  return <Box marginTop={1} flexDirection="column">
    {status}
    {view.content}
    <ModalKeyboardInput selection={view.selection}
      onToggleAutoAllow={entry.kind === 'permission' ? () => modal.setAutoAllowMode(!modal.autoAllowMode) : undefined}/>
  </Box>;
}
