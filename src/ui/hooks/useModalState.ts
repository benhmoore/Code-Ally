/**
 * useModalState - Manage all modal and selector state
 *
 * This hook consolidates state management for all modals and selectors in the app:
 * - Permission prompts
 * - Model selectors
 * - Config viewer
 * - Setup wizard
 * - Project wizard
 * - Agent wizard
 * - Plugin config
 * - Rewind selector
 * - Undo prompts
 * - Session selector
 * - Library selector
 */

import { useState } from 'react';
import { ModelOption } from '../components/ModelSelector.js';
import { PermissionRequest } from '../components/PermissionPrompt.js';
import type { SessionInfo, Message, PromptInfo } from '@shared/index.js';
import type { FileChangeStats } from '../components/RewindOptionsSelector.js';

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
 * Plugin config request
 */
export interface PluginConfigRequest {
  pluginName: string;
  pluginPath: string;
  schema: any;
  existingConfig?: any;
  author?: string;
  description?: string;
  version?: string;
  tools?: any[];
  agents?: any[];
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

/**
 * All modal state
 */
export interface ModalState {
  // Permission prompt
  permissionRequest?: PermissionRequestWithId;
  permissionSelectedIndex: number;
  setPermissionRequest: (request?: PermissionRequestWithId) => void;
  setPermissionSelectedIndex: (index: number) => void;

  // Model selector
  modelSelectRequest?: ModelSelectRequest;
  modelSelectedIndex: number;
  setModelSelectRequest: (request?: ModelSelectRequest) => void;
  setModelSelectedIndex: (index: number) => void;

  // Config viewer
  configViewerOpen: boolean;
  setConfigViewerOpen: (open: boolean) => void;

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

  // Plugin config
  pluginConfigRequest?: PluginConfigRequest;
  setPluginConfigRequest: (request?: PluginConfigRequest) => void;

  // Rewind selector
  rewindRequest?: RewindRequest;
  setRewindRequest: (request?: RewindRequest) => void;

  // Rewind options selector
  rewindOptionsRequest?: RewindOptionsRequest;
  setRewindOptionsRequest: (request?: RewindOptionsRequest) => void;

  // Input prefill (from rewind)
  inputPrefillText?: string;
  setInputPrefillText: (text?: string) => void;

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

  // Input buffer (preserve across modal renders)
  inputBuffer: string;
  setInputBuffer: (buffer: string) => void;

  // Exit confirmation (Ctrl+C on empty buffer)
  isWaitingForExitConfirmation: boolean;
  setIsWaitingForExitConfirmation: (waiting: boolean) => void;
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
  // Permission prompt
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequestWithId | undefined>(undefined);
  const [permissionSelectedIndex, setPermissionSelectedIndex] = useState(0);

  // Model selector
  const [modelSelectRequest, setModelSelectRequest] = useState<ModelSelectRequest | undefined>(undefined);
  const [modelSelectedIndex, setModelSelectedIndex] = useState(0);

  // Config viewer
  const [configViewerOpen, setConfigViewerOpen] = useState(false);

  // Setup wizard
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);

  // Project wizard
  const [projectWizardOpen, setProjectWizardOpen] = useState(false);

  // Agent wizard
  const [agentWizardOpen, setAgentWizardOpen] = useState(false);
  const [agentWizardData, setAgentWizardData] = useState<AgentWizardData>({});

  // Plugin config
  const [pluginConfigRequest, setPluginConfigRequest] = useState<PluginConfigRequest | undefined>(undefined);

  // Rewind selector
  const [rewindRequest, setRewindRequest] = useState<RewindRequest | undefined>(undefined);
  const [rewindOptionsRequest, setRewindOptionsRequest] = useState<RewindOptionsRequest | undefined>(undefined);
  const [inputPrefillText, setInputPrefillText] = useState<string | undefined>(undefined);

  // Undo prompt
  const [undoRequest, setUndoRequest] = useState<UndoRequest | undefined>(undefined);
  const [undoSelectedIndex, setUndoSelectedIndex] = useState(0);

  // Undo file list
  const [undoFileListRequest, setUndoFileListRequest] = useState<UndoFileListRequest | undefined>(undefined);

  // Session selector
  const [sessionSelectRequest, setSessionSelectRequest] = useState<SessionSelectRequest | undefined>(undefined);

  // Library selector
  const [librarySelectRequest, setLibrarySelectRequest] = useState<LibrarySelectRequest | undefined>(undefined);

  // Message selector (for prompt creation)
  const [messageSelectRequest, setMessageSelectRequest] = useState<MessageSelectRequest | undefined>(undefined);

  // Prompt add wizard
  const [promptAddRequest, setPromptAddRequest] = useState<PromptAddRequest | undefined>(undefined);

  // Library clear confirmation
  const [libraryClearConfirmRequest, setLibraryClearConfirmRequest] = useState<LibraryClearConfirmRequest | undefined>(undefined);

  // Input buffer
  const [inputBuffer, setInputBuffer] = useState<string>('');

  // Exit confirmation
  const [isWaitingForExitConfirmation, setIsWaitingForExitConfirmation] = useState(false);

  return {
    // Permission prompt
    permissionRequest,
    permissionSelectedIndex,
    setPermissionRequest,
    setPermissionSelectedIndex,

    // Model selector
    modelSelectRequest,
    modelSelectedIndex,
    setModelSelectRequest,
    setModelSelectedIndex,

    // Config viewer
    configViewerOpen,
    setConfigViewerOpen,

    // Setup wizard
    setupWizardOpen,
    setSetupWizardOpen,

    // Project wizard
    projectWizardOpen,
    setProjectWizardOpen,

    // Agent wizard
    agentWizardOpen,
    agentWizardData,
    setAgentWizardOpen,
    setAgentWizardData,

    // Plugin config
    pluginConfigRequest,
    setPluginConfigRequest,

    // Rewind selector
    rewindRequest,
    setRewindRequest,

    // Rewind options selector
    rewindOptionsRequest,
    setRewindOptionsRequest,

    // Input prefill
    inputPrefillText,
    setInputPrefillText,

    // Undo prompt
    undoRequest,
    undoSelectedIndex,
    setUndoRequest,
    setUndoSelectedIndex,

    // Undo file list
    undoFileListRequest,
    setUndoFileListRequest,

    // Session selector
    sessionSelectRequest,
    setSessionSelectRequest,

    // Library selector
    librarySelectRequest,
    setLibrarySelectRequest,

    // Message selector
    messageSelectRequest,
    setMessageSelectRequest,

    // Prompt add wizard
    promptAddRequest,
    setPromptAddRequest,

    // Library clear confirmation
    libraryClearConfirmRequest,
    setLibraryClearConfirmRequest,

    // Input buffer
    inputBuffer,
    setInputBuffer,

    // Exit confirmation
    isWaitingForExitConfirmation,
    setIsWaitingForExitConfirmation,
  };
};
