/**
 * useModalState - Manage all modal and selector state
 *
 * Architecture
 * ------------
 * The single source of truth is a STACK of discriminated-union modal entries
 * (see `ModalEntry` and `modalReducer`). At most one *exclusive* modal can be
 * open at a time, with two deliberate *layered* exceptions:
 *   - `rewindOptions` layers on top of `rewind`
 *   - `undo` layers on top of `undoFileList`
 *
 * Because every "open" routes through the reducer (which replaces the stack for
 * exclusive modals), it is structurally impossible for two unrelated modals to
 * be set at once. That eliminates the class of bug where closing the visible
 * modal revealed a stale lower-priority one. Per-modal transient sub-state
 * (selection index, instruction text, queues, form values) lives *inside* its
 * stack entry, so closing a modal is guaranteed to clean up its sub-state, and
 * queue head changes reset the head's sub-state automatically.
 *
 * The reducer is a pure function and is unit-tested in isolation
 * (useModalState.reducer.test.ts). The hook below is a thin facade that derives
 * the historical flat API (`permissionRequest`, `setModelSelectRequest`, …) from
 * the stack, so existing consumers (App, useActivitySubscriptions, InputPrompt)
 * need no changes.
 *
 * Modals managed: permission prompts, model selector, setup/project/agent
 * wizards, rewind selector + options, undo prompt + file list, session selector,
 * prompt library selector, message selector, prompt add wizard, library clear
 * confirmation, plan approval, and tool form wizard.
 */

import { useReducer, useState, useCallback } from 'react';
import { ModelOption } from '../components/ModelSelector.js';
import { PermissionRequest } from '../components/PermissionPrompt.js';
import type { PlanApprovalRequest } from '../components/PlanApprovalPrompt.js';
import type { SessionInfo, Message, PromptInfo, FormRequest } from '@shared/index.js';
import type { FileChangeStats } from '../components/RewindOptionsSelector.js';
import type { UndoPreview } from '@services/PatchManager.js';

/**
 * Permission request with ID
 */
export interface PermissionRequestWithId extends PermissionRequest {
  requestId: string;
}

/**
 * Model select request
 */
export interface ModelSelectRequest {
  requestId: string;
  models: ModelOption[];
  currentModel?: string;
  modelType?: 'ally' | 'service';
  typeName?: string;
}

/**
 * Agent wizard data
 */
export interface AgentWizardData {
  initialDescription?: string;
}

/**
 * Rewind request
 */
export interface RewindRequest {
  requestId: string;
  userMessagesCount: number;
  selectedIndex: number;
}

/**
 * Rewind options request
 */
export interface RewindOptionsRequest {
  selectedIndex: number;
  targetMessage: Message;
  fileChanges: FileChangeStats;
  previewData?: UndoPreview[];
}

/**
 * Undo request
 */
export interface UndoRequest {
  requestId: string;
  count: number;
  patches: any[];
  previewData: any[];
}

/**
 * Undo file list request
 */
export interface UndoFileListRequest {
  requestId: string;
  fileList: any[];
  selectedIndex: number;
}

/**
 * Session select request
 */
export interface SessionSelectRequest {
  requestId: string;
  sessions: SessionInfo[];
  selectedIndex: number;
}

/**
 * Library select request
 */
export interface LibrarySelectRequest {
  requestId: string;
  prompts: PromptInfo[];
  selectedIndex: number;
}

/**
 * Message select request (for prompt creation from previous messages)
 */
export interface MessageSelectRequest {
  requestId: string;
  messages: Message[];
  selectedIndex: number;
}

/**
 * Prompt add request (wizard for creating/editing prompts)
 */
export interface PromptAddRequest {
  requestId: string;
  promptId?: string; // If present, this is an edit operation
  title: string;
  content: string;
  tags: string;
  focusedField: 'title' | 'content' | 'tags';
}

/**
 * Library clear confirmation request
 */
export interface LibraryClearConfirmRequest {
  requestId: string;
  promptCount: number;
  selectedIndex: number;
}

// ===========================================================================
// Modal stack model (internal source of truth)
// ===========================================================================

/**
 * A single open modal. Each entry owns its transient UI sub-state so that
 * closing the modal (removing the entry) cleans it up by construction.
 */
export type ModalEntry =
  | {
      kind: 'permission';
      queue: PermissionRequestWithId[];
      selectedIndex: number;
      instructText: string;
      cursorPosition: number;
    }
  | { kind: 'model'; request: ModelSelectRequest; selectedIndex: number; loading: boolean }
  | { kind: 'setupWizard' }
  | { kind: 'projectWizard' }
  | { kind: 'agentWizard' }
  | { kind: 'session'; request: SessionSelectRequest }
  | { kind: 'library'; request: LibrarySelectRequest }
  | { kind: 'message'; request: MessageSelectRequest }
  | { kind: 'promptAdd'; request: PromptAddRequest }
  | { kind: 'libraryClearConfirm'; request: LibraryClearConfirmRequest }
  | { kind: 'rewind'; request: RewindRequest }
  | { kind: 'rewindOptions'; request: RewindOptionsRequest }
  | { kind: 'undoFileList'; request: UndoFileListRequest }
  | { kind: 'undo'; request: UndoRequest; selectedIndex: number }
  | {
      kind: 'planApproval';
      request: PlanApprovalRequest;
      selectedIndex: number;
      feedbackText: string;
      cursorPosition: number;
    }
  | {
      kind: 'toolForm';
      queue: FormRequest[];
      fieldIndex: number;
      values: Record<string, any>;
      errors: Record<string, string>;
    };

export type ModalKind = ModalEntry['kind'];

/** Modal kinds dismissed on user interrupt (tied to in-flight agent work). */
const TRANSIENT_KINDS: ReadonlySet<ModalKind> = new Set<ModalKind>(['permission', 'toolForm', 'planApproval']);

/**
 * Reducer actions. Generic structural ops cover the exclusive/layered modals;
 * the permission and tool-form queues get dedicated ops because their head's
 * sub-state must reset when the head changes.
 */
export type ModalAction =
  // Generic stack operations
  | { type: 'openExclusive'; entry: ModalEntry } // replace the whole stack with this one modal
  | { type: 'upsert'; entry: ModalEntry } // update in place if open (keeping layers), else open exclusively
  | { type: 'pushLayer'; entry: ModalEntry } // ensure a single instance of this kind sits on top, keeping the rest
  | { type: 'close'; kind: ModalKind } // remove every entry of this kind
  | { type: 'patch'; kind: ModalKind; patch: Record<string, unknown> } // shallow-merge into the entry of this kind
  // Permission queue
  | { type: 'permission/add'; request: PermissionRequestWithId }
  | { type: 'permission/remove'; requestId: string }
  | { type: 'permission/popHead' }
  // Tool-form queue
  | { type: 'toolForm/add'; request: FormRequest }
  | { type: 'toolForm/remove'; requestId: string }
  | { type: 'toolForm/setValue'; field: string; value: any }
  | { type: 'toolForm/setError'; field: string; error: string | null }
  // Bulk
  | { type: 'clearTransient' };

const findEntry = <K extends ModalKind>(stack: ModalEntry[], kind: K): Extract<ModalEntry, { kind: K }> | undefined =>
  stack.find(e => e.kind === kind) as Extract<ModalEntry, { kind: K }> | undefined;

/**
 * Pure modal-stack reducer. Exported for unit testing.
 */
export function modalReducer(stack: ModalEntry[], action: ModalAction): ModalEntry[] {
  switch (action.type) {
    case 'openExclusive':
      return [action.entry];

    case 'upsert':
      return stack.some(e => e.kind === action.entry.kind)
        ? stack.map(e => (e.kind === action.entry.kind ? action.entry : e))
        : [action.entry];

    case 'pushLayer':
      return [...stack.filter(e => e.kind !== action.entry.kind), action.entry];

    case 'close':
      return stack.filter(e => e.kind !== action.kind);

    case 'patch':
      return stack.map(e => (e.kind === action.kind ? ({ ...e, ...action.patch } as ModalEntry) : e));

    case 'permission/add': {
      const existing = findEntry(stack, 'permission');
      if (existing) {
        return stack.map(e =>
          e.kind === 'permission' ? { ...e, queue: [...e.queue, action.request] } : e
        );
      }
      return [
        { kind: 'permission', queue: [action.request], selectedIndex: 0, instructText: '', cursorPosition: 0 },
      ];
    }

    case 'permission/remove': {
      const existing = findEntry(stack, 'permission');
      if (!existing) return stack;
      const wasHead = existing.queue[0]?.requestId === action.requestId;
      const queue = existing.queue.filter(r => r.requestId !== action.requestId);
      if (queue.length === 0) return stack.filter(e => e.kind !== 'permission');
      // If the head changed, reset the head's transient sub-state so values
      // don't bleed from the previously-answered request into the next one.
      return stack.map(e =>
        e.kind === 'permission'
          ? { ...e, queue, ...(wasHead ? { selectedIndex: 0, instructText: '', cursorPosition: 0 } : {}) }
          : e
      );
    }

    case 'permission/popHead': {
      const existing = findEntry(stack, 'permission');
      if (!existing) return stack;
      const queue = existing.queue.slice(1);
      if (queue.length === 0) return stack.filter(e => e.kind !== 'permission');
      return stack.map(e =>
        e.kind === 'permission' ? { ...e, queue, selectedIndex: 0, instructText: '', cursorPosition: 0 } : e
      );
    }

    case 'toolForm/add': {
      const existing = findEntry(stack, 'toolForm');
      if (existing) {
        // Append behind the active form; do NOT disturb the visible head's state.
        return stack.map(e => (e.kind === 'toolForm' ? { ...e, queue: [...e.queue, action.request] } : e));
      }
      return [
        {
          kind: 'toolForm',
          queue: [action.request],
          fieldIndex: 0,
          values: action.request.initialValues || {},
          errors: {},
        },
      ];
    }

    case 'toolForm/remove': {
      const existing = findEntry(stack, 'toolForm');
      if (!existing) return stack;
      const wasHead = existing.queue[0]?.requestId === action.requestId;
      const queue = existing.queue.filter(r => r.requestId !== action.requestId);
      if (queue.length === 0) return stack.filter(e => e.kind !== 'toolForm');
      // If the head advanced, seed the new head's field state from its defaults.
      return stack.map(e =>
        e.kind === 'toolForm'
          ? { ...e, queue, ...(wasHead ? { values: queue[0]!.initialValues || {}, fieldIndex: 0, errors: {} } : {}) }
          : e
      );
    }

    case 'toolForm/setValue':
      return stack.map(e => {
        if (e.kind !== 'toolForm') return e;
        const errors = { ...e.errors };
        delete errors[action.field]; // clear any error for the field being edited
        return { ...e, values: { ...e.values, [action.field]: action.value }, errors };
      });

    case 'toolForm/setError':
      return stack.map(e => {
        if (e.kind !== 'toolForm') return e;
        const errors = { ...e.errors };
        if (action.error === null) delete errors[action.field];
        else errors[action.field] = action.error;
        return { ...e, errors };
      });

    case 'clearTransient':
      return stack
        .filter(e => !TRANSIENT_KINDS.has(e.kind))
        .map(e => (e.kind === 'model' ? { ...e, loading: false } : e));

    default:
      return stack;
  }
}

// Stable empty references so derived getters don't churn identity each render.
const EMPTY_FORM_QUEUE: FormRequest[] = [];
const EMPTY_VALUES: Record<string, any> = {};
const EMPTY_ERRORS: Record<string, string> = {};

/**
 * All modal state
 */
export interface ModalState {
  // Permission prompt (queue-based: permissionRequest is first in queue)
  permissionRequest?: PermissionRequestWithId;
  permissionRequestQueueLength: number;
  permissionSelectedIndex: number;
  permissionInstructText: string;
  permissionCursorPosition: number;
  setPermissionRequest: (request?: PermissionRequestWithId) => void;
  addPermissionRequest: (request: PermissionRequestWithId) => void;
  removePermissionRequest: (requestId: string) => void;
  setPermissionSelectedIndex: (index: number) => void;
  setPermissionInstructText: (text: string) => void;
  setPermissionCursorPosition: (position: number) => void;

  // Auto-allow mode
  autoAllowMode: boolean;
  setAutoAllowMode: (enabled: boolean) => void;

  // Model selector
  modelSelectRequest?: ModelSelectRequest;
  modelSelectedIndex: number;
  modelSelectLoading: boolean;
  setModelSelectRequest: (request?: ModelSelectRequest) => void;
  setModelSelectedIndex: (index: number) => void;
  setModelSelectLoading: (loading: boolean) => void;

  // Setup wizard
  setupWizardOpen: boolean;
  setSetupWizardOpen: (open: boolean) => void;

  // Project wizard
  projectWizardOpen: boolean;
  setProjectWizardOpen: (open: boolean) => void;

  // Agent wizard
  agentWizardOpen: boolean;
  agentWizardData: AgentWizardData;
  setAgentWizardOpen: (open: boolean) => void;
  setAgentWizardData: (data: AgentWizardData) => void;

  // Rewind selector
  rewindRequest?: RewindRequest;
  setRewindRequest: (request?: RewindRequest) => void;

  // Rewind options selector
  rewindOptionsRequest?: RewindOptionsRequest;
  setRewindOptionsRequest: (request?: RewindOptionsRequest) => void;

  // Input prefill (from rewind)
  inputPrefillText?: string;
  setInputPrefillText: (text?: string) => void;

  // Prompt prefill tracking (from library)
  promptPrefilled: boolean;
  setPromptPrefilled: (prefilled: boolean) => void;

  // Undo prompt
  undoRequest?: UndoRequest;
  undoSelectedIndex: number;
  setUndoRequest: (request?: UndoRequest) => void;
  setUndoSelectedIndex: (index: number) => void;

  // Undo file list
  undoFileListRequest?: UndoFileListRequest;
  setUndoFileListRequest: (request?: UndoFileListRequest) => void;

  // Session selector
  sessionSelectRequest?: SessionSelectRequest;
  setSessionSelectRequest: (request?: SessionSelectRequest) => void;

  // Library selector
  librarySelectRequest?: LibrarySelectRequest;
  setLibrarySelectRequest: (request?: LibrarySelectRequest) => void;

  // Message selector (for prompt creation)
  messageSelectRequest?: MessageSelectRequest;
  setMessageSelectRequest: (request?: MessageSelectRequest) => void;

  // Prompt add wizard
  promptAddRequest?: PromptAddRequest;
  setPromptAddRequest: (request?: PromptAddRequest) => void;

  // Library clear confirmation
  libraryClearConfirmRequest?: LibraryClearConfirmRequest;
  setLibraryClearConfirmRequest: (request?: LibraryClearConfirmRequest) => void;

  // Plan approval
  planApprovalRequest?: PlanApprovalRequest;
  planApprovalSelectedIndex: number;
  planApprovalFeedbackText: string;
  planApprovalCursorPosition: number;
  setPlanApprovalRequest: (request?: PlanApprovalRequest) => void;
  setPlanApprovalSelectedIndex: (index: number) => void;
  setPlanApprovalFeedbackText: (text: string) => void;
  setPlanApprovalCursorPosition: (position: number) => void;

  // Tool form wizard (queue-based like permission requests)
  toolFormRequest?: FormRequest;
  toolFormQueue: FormRequest[];
  toolFormQueueLength: number;
  toolFormFieldIndex: number;
  toolFormValues: Record<string, any>;
  toolFormErrors: Record<string, string>;
  addToolFormRequest: (request: FormRequest) => void;
  removeToolFormRequest: (requestId: string) => void;
  setToolFormFieldIndex: (index: number) => void;
  setToolFormValue: (field: string, value: any) => void;
  setToolFormError: (field: string, error: string | null) => void;

  // Input buffer (preserve across modal renders)
  inputBuffer: string;
  setInputBuffer: (buffer: string) => void;

  // Background-agent fleet navigation (a focus region, NOT a modal — it
  // coexists with the live prompt). fleetSelectedIndex is 0-based over the
  // selectable list [main, ...backgroundAgents] (0 === the 'main' row).
  fleetFocused: boolean;
  setFleetFocused: (focused: boolean) => void;
  fleetSelectedIndex: number;
  setFleetSelectedIndex: (index: number) => void;

  // Exit confirmation (Ctrl+C on empty buffer)
  isWaitingForExitConfirmation: boolean;
  setIsWaitingForExitConfirmation: (waiting: boolean) => void;

  // Dismiss all agent-driven request modals (permission, tool form, plan
  // approval, model-select loading) — used when the user interrupts the agent.
  clearTransientModals: () => void;
}

/**
 * Manage all modal and selector state
 *
 * @returns Modal state and setters
 *
 * @example
 * ```tsx
 * const modal = useModalState();
 *
 * // Show permission prompt
 * modal.setPermissionRequest({
 *   requestId: 'perm_123',
 *   toolName: 'bash',
 *   command: 'rm -rf /',
 * });
 *
 * // Close permission prompt
 * modal.setPermissionRequest(undefined);
 * ```
 */
export const useModalState = (): ModalState => {
  // Single source of truth for which modal(s) are open.
  const [stack, dispatch] = useReducer(modalReducer, [] as ModalEntry[]);

  // Non-modal state that legitimately coexists with any modal.
  const [autoAllowMode, setAutoAllowMode] = useState(false);
  const [agentWizardData, setAgentWizardData] = useState<AgentWizardData>({});
  const [inputPrefillText, setInputPrefillText] = useState<string | undefined>(undefined);
  const [promptPrefilled, setPromptPrefilled] = useState(false);
  const [inputBuffer, setInputBuffer] = useState<string>('');
  const [isWaitingForExitConfirmation, setIsWaitingForExitConfirmation] = useState(false);
  const [fleetFocused, setFleetFocused] = useState(false);
  const [fleetSelectedIndex, setFleetSelectedIndex] = useState(0);

  // --- Derived entries -----------------------------------------------------
  const permission = findEntry(stack, 'permission');
  const model = findEntry(stack, 'model');
  const rewind = findEntry(stack, 'rewind');
  const rewindOptions = findEntry(stack, 'rewindOptions');
  const undo = findEntry(stack, 'undo');
  const undoFileList = findEntry(stack, 'undoFileList');
  const session = findEntry(stack, 'session');
  const library = findEntry(stack, 'library');
  const message = findEntry(stack, 'message');
  const promptAdd = findEntry(stack, 'promptAdd');
  const libraryClearConfirm = findEntry(stack, 'libraryClearConfirm');
  const planApproval = findEntry(stack, 'planApproval');
  const toolForm = findEntry(stack, 'toolForm');

  // --- Facade setters (stable; only dispatch) ------------------------------

  // Permission
  const addPermissionRequest = useCallback(
    (request: PermissionRequestWithId) => dispatch({ type: 'permission/add', request }),
    []
  );
  const removePermissionRequest = useCallback(
    (requestId: string) => dispatch({ type: 'permission/remove', requestId }),
    []
  );
  const setPermissionRequest = useCallback((request?: PermissionRequestWithId) => {
    if (request === undefined) {
      dispatch({ type: 'permission/popHead' });
    } else {
      dispatch({
        type: 'openExclusive',
        entry: { kind: 'permission', queue: [request], selectedIndex: 0, instructText: '', cursorPosition: 0 },
      });
    }
  }, []);
  const setPermissionSelectedIndex = useCallback(
    (index: number) => dispatch({ type: 'patch', kind: 'permission', patch: { selectedIndex: index } }),
    []
  );
  const setPermissionInstructText = useCallback(
    (text: string) => dispatch({ type: 'patch', kind: 'permission', patch: { instructText: text } }),
    []
  );
  const setPermissionCursorPosition = useCallback(
    (position: number) => dispatch({ type: 'patch', kind: 'permission', patch: { cursorPosition: position } }),
    []
  );

  // Model selector
  const setModelSelectRequest = useCallback((request?: ModelSelectRequest) => {
    if (request) {
      dispatch({ type: 'openExclusive', entry: { kind: 'model', request, selectedIndex: 0, loading: false } });
    } else {
      dispatch({ type: 'close', kind: 'model' });
    }
  }, []);
  const setModelSelectedIndex = useCallback(
    (index: number) => dispatch({ type: 'patch', kind: 'model', patch: { selectedIndex: index } }),
    []
  );
  const setModelSelectLoading = useCallback(
    (loading: boolean) => dispatch({ type: 'patch', kind: 'model', patch: { loading } }),
    []
  );

  // Wizards
  const setSetupWizardOpen = useCallback((open: boolean) => {
    dispatch(open ? { type: 'openExclusive', entry: { kind: 'setupWizard' } } : { type: 'close', kind: 'setupWizard' });
  }, []);
  const setProjectWizardOpen = useCallback((open: boolean) => {
    dispatch(
      open ? { type: 'openExclusive', entry: { kind: 'projectWizard' } } : { type: 'close', kind: 'projectWizard' }
    );
  }, []);
  const setAgentWizardOpen = useCallback((open: boolean) => {
    dispatch(open ? { type: 'openExclusive', entry: { kind: 'agentWizard' } } : { type: 'close', kind: 'agentWizard' });
  }, []);

  // Rewind selector (base layer) + options (layered on top)
  const setRewindRequest = useCallback((request?: RewindRequest) => {
    dispatch(request ? { type: 'upsert', entry: { kind: 'rewind', request } } : { type: 'close', kind: 'rewind' });
  }, []);
  const setRewindOptionsRequest = useCallback((request?: RewindOptionsRequest) => {
    dispatch(
      request
        ? { type: 'pushLayer', entry: { kind: 'rewindOptions', request } }
        : { type: 'close', kind: 'rewindOptions' }
    );
  }, []);

  // Undo file list (base layer) + undo prompt (layered on top)
  const setUndoFileListRequest = useCallback((request?: UndoFileListRequest) => {
    dispatch(
      request ? { type: 'upsert', entry: { kind: 'undoFileList', request } } : { type: 'close', kind: 'undoFileList' }
    );
  }, []);
  const setUndoRequest = useCallback((request?: UndoRequest) => {
    dispatch(
      request
        ? { type: 'pushLayer', entry: { kind: 'undo', request, selectedIndex: 0 } }
        : { type: 'close', kind: 'undo' }
    );
  }, []);
  const setUndoSelectedIndex = useCallback(
    (index: number) => dispatch({ type: 'patch', kind: 'undo', patch: { selectedIndex: index } }),
    []
  );

  // Selectors / wizards (exclusive)
  const setSessionSelectRequest = useCallback((request?: SessionSelectRequest) => {
    dispatch(request ? { type: 'upsert', entry: { kind: 'session', request } } : { type: 'close', kind: 'session' });
  }, []);
  const setLibrarySelectRequest = useCallback((request?: LibrarySelectRequest) => {
    dispatch(request ? { type: 'upsert', entry: { kind: 'library', request } } : { type: 'close', kind: 'library' });
  }, []);
  const setMessageSelectRequest = useCallback((request?: MessageSelectRequest) => {
    dispatch(request ? { type: 'upsert', entry: { kind: 'message', request } } : { type: 'close', kind: 'message' });
  }, []);
  const setPromptAddRequest = useCallback((request?: PromptAddRequest) => {
    dispatch(request ? { type: 'upsert', entry: { kind: 'promptAdd', request } } : { type: 'close', kind: 'promptAdd' });
  }, []);
  const setLibraryClearConfirmRequest = useCallback((request?: LibraryClearConfirmRequest) => {
    dispatch(
      request
        ? { type: 'upsert', entry: { kind: 'libraryClearConfirm', request } }
        : { type: 'close', kind: 'libraryClearConfirm' }
    );
  }, []);

  // Plan approval
  const setPlanApprovalRequest = useCallback((request?: PlanApprovalRequest) => {
    dispatch(
      request
        ? {
            type: 'openExclusive',
            entry: { kind: 'planApproval', request, selectedIndex: 0, feedbackText: '', cursorPosition: 0 },
          }
        : { type: 'close', kind: 'planApproval' }
    );
  }, []);
  const setPlanApprovalSelectedIndex = useCallback(
    (index: number) => dispatch({ type: 'patch', kind: 'planApproval', patch: { selectedIndex: index } }),
    []
  );
  const setPlanApprovalFeedbackText = useCallback(
    (text: string) => dispatch({ type: 'patch', kind: 'planApproval', patch: { feedbackText: text } }),
    []
  );
  const setPlanApprovalCursorPosition = useCallback(
    (position: number) => dispatch({ type: 'patch', kind: 'planApproval', patch: { cursorPosition: position } }),
    []
  );

  // Tool form queue
  const addToolFormRequest = useCallback((request: FormRequest) => dispatch({ type: 'toolForm/add', request }), []);
  const removeToolFormRequest = useCallback(
    (requestId: string) => dispatch({ type: 'toolForm/remove', requestId }),
    []
  );
  const setToolFormFieldIndex = useCallback(
    (index: number) => dispatch({ type: 'patch', kind: 'toolForm', patch: { fieldIndex: index } }),
    []
  );
  const setToolFormValue = useCallback(
    (field: string, value: any) => dispatch({ type: 'toolForm/setValue', field, value }),
    []
  );
  const setToolFormError = useCallback(
    (field: string, error: string | null) => dispatch({ type: 'toolForm/setError', field, error }),
    []
  );

  // Bulk
  const clearTransientModals = useCallback(() => dispatch({ type: 'clearTransient' }), []);

  return {
    // Permission prompt
    permissionRequest: permission?.queue[0],
    permissionRequestQueueLength: permission?.queue.length ?? 0,
    permissionSelectedIndex: permission?.selectedIndex ?? 0,
    permissionInstructText: permission?.instructText ?? '',
    permissionCursorPosition: permission?.cursorPosition ?? 0,
    setPermissionRequest,
    addPermissionRequest,
    removePermissionRequest,
    setPermissionSelectedIndex,
    setPermissionInstructText,
    setPermissionCursorPosition,

    // Auto-allow mode
    autoAllowMode,
    setAutoAllowMode,

    // Model selector
    modelSelectRequest: model?.request,
    modelSelectedIndex: model?.selectedIndex ?? 0,
    modelSelectLoading: model?.loading ?? false,
    setModelSelectRequest,
    setModelSelectedIndex,
    setModelSelectLoading,

    // Setup wizard
    setupWizardOpen: !!findEntry(stack, 'setupWizard'),
    setSetupWizardOpen,

    // Project wizard
    projectWizardOpen: !!findEntry(stack, 'projectWizard'),
    setProjectWizardOpen,

    // Agent wizard
    agentWizardOpen: !!findEntry(stack, 'agentWizard'),
    agentWizardData,
    setAgentWizardOpen,
    setAgentWizardData,

    // Rewind selector
    rewindRequest: rewind?.request,
    setRewindRequest,

    // Rewind options selector
    rewindOptionsRequest: rewindOptions?.request,
    setRewindOptionsRequest,

    // Input prefill
    inputPrefillText,
    setInputPrefillText,
    promptPrefilled,
    setPromptPrefilled,

    // Undo prompt
    undoRequest: undo?.request,
    undoSelectedIndex: undo?.selectedIndex ?? 0,
    setUndoRequest,
    setUndoSelectedIndex,

    // Undo file list
    undoFileListRequest: undoFileList?.request,
    setUndoFileListRequest,

    // Session selector
    sessionSelectRequest: session?.request,
    setSessionSelectRequest,

    // Library selector
    librarySelectRequest: library?.request,
    setLibrarySelectRequest,

    // Message selector
    messageSelectRequest: message?.request,
    setMessageSelectRequest,

    // Prompt add wizard
    promptAddRequest: promptAdd?.request,
    setPromptAddRequest,

    // Library clear confirmation
    libraryClearConfirmRequest: libraryClearConfirm?.request,
    setLibraryClearConfirmRequest,

    // Plan approval
    planApprovalRequest: planApproval?.request,
    planApprovalSelectedIndex: planApproval?.selectedIndex ?? 0,
    planApprovalFeedbackText: planApproval?.feedbackText ?? '',
    planApprovalCursorPosition: planApproval?.cursorPosition ?? 0,
    setPlanApprovalRequest,
    setPlanApprovalSelectedIndex,
    setPlanApprovalFeedbackText,
    setPlanApprovalCursorPosition,

    // Tool form wizard
    toolFormRequest: toolForm?.queue[0],
    toolFormQueue: toolForm?.queue ?? EMPTY_FORM_QUEUE,
    toolFormQueueLength: toolForm?.queue.length ?? 0,
    toolFormFieldIndex: toolForm?.fieldIndex ?? 0,
    toolFormValues: toolForm?.values ?? EMPTY_VALUES,
    toolFormErrors: toolForm?.errors ?? EMPTY_ERRORS,
    addToolFormRequest,
    removeToolFormRequest,
    setToolFormFieldIndex,
    setToolFormValue,
    setToolFormError,

    // Input buffer
    inputBuffer,
    setInputBuffer,
    fleetFocused,
    setFleetFocused,
    fleetSelectedIndex,
    setFleetSelectedIndex,

    // Exit confirmation
    isWaitingForExitConfirmation,
    setIsWaitingForExitConfirmation,

    // Bulk cleanup
    clearTransientModals,
  };
};
