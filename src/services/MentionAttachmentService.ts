/**
 * MentionAttachmentService - Owns the orchestration behind `@file` / `@dir` mentions
 *
 * When the user references a path in their input, the UI attaches that content to
 * the conversation *before* the message is sent to the model: a `read` call for
 * file mentions, a `tree` call for directory mentions. Each attachment has to
 * mirror a model-issued tool call so the transcript stays a valid
 * assistant(tool_calls) -> tool sequence, emit the tool-lifecycle events the
 * terminal renders, and close itself out even when execution fails or throws.
 *
 * That orchestration lives here rather than in the `useInputHandlers` React
 * hook, where it cannot be tested without mounting React. The hook parses
 * mentions, calls this service and renders the messages it hands back; it
 * performs no tool execution, no tool-result construction, no tool-lifecycle
 * event emission and no conversation-history mutation of its own.
 *
 * This is deliberately a *sibling* of {@link UserShortcutService} rather than a
 * method on it. Shortcuts (`!`, `#`) are terminal actions - the user asked for
 * something to happen and nothing is sent to the model. Mentions are context
 * attachment - they are a prelude to the user's message and must report whether
 * that message may still be sent. Different lifecycle, different return
 * contract, different collaborators (mentions need the todo promoter, shortcuts
 * need the filesystem).
 */

import { ActivityStream } from './ActivityStream.js';
import { ToolManager } from '../tools/ToolManager.js';
import { ActivityEventType, Message, ToolResult } from '../types/index.js';
import { createStructuredError } from '../utils/errorUtils.js';
import { createToolResultMessage } from '../llm/FunctionCalling.js';
import { resolveDisplayContent } from '../utils/toolResultContent.js';

/**
 * The slice of Agent this service needs.
 *
 * Passed per call rather than constructor-injected, because the active agent is
 * swapped at runtime when the user enters a background agent's view.
 */
export interface MentionAgent {
  addMessage(message: Message): void;
  resetToolCallActivity?(): void;
  getToolAbortSignal?(): AbortSignal | undefined;
  getAgentName?(): string | undefined;
  getInstanceId?(): string;
  getScopedRegistry?(): unknown;
}

/**
 * Sink for user-facing chat messages produced while attaching a mention.
 *
 * Called in display order, so an error explaining a failed attachment lands
 * after the tool call it belongs to rather than before it.
 */
export type MentionMessageSink = (message: Message) => void;

/**
 * The slice of TodoManager used to auto-promote the first pending todo when the
 * user attaches files (see {@link MentionAttachmentService.attachFiles}).
 */
export interface MentionTodoPromoter {
  getInProgressTodo?(): unknown;
  getNextPendingTodo?(): { id: string } | null | undefined;
  getTodos(): Array<{ id: string; status: string }>;
  setTodos(todos: Array<{ id: string; status: string }>): void;
}

/**
 * Outcome of an attachment attempt.
 *
 * `attached` - the mention was resolved (successfully or with a tool-level
 * error that was recorded in history); the caller may continue and send the
 * user's message.
 * `aborted`  - the attachment could not be performed at all; the caller must
 * stop and not send the user's message.
 */
export type MentionOutcome = 'attached' | 'aborted';

/** Per-mention-kind configuration for the shared attachment routine. */
interface AttachmentSpec {
  /** Tool to invoke (`read` for files, `tree` for directories). */
  toolName: string;
  /** Message shown when the tool is not registered. */
  missingToolMessage: string;
  /** Arguments mirrored into the assistant `tool_calls` entry and the START event. */
  displayArguments: Record<string, unknown>;
  /** Full arguments passed to `ToolManager.executeTool()`. */
  executeArguments: Record<string, unknown>;
  /** Include the tool's `hideOutput` flag in the TOOL_CALL_START event payload. */
  includeHideOutput?: boolean;
  /** Stream the resolved display content as an output chunk on success. */
  streamOutputChunk?: boolean;
  /** Attach per-call status/result metadata to the tool-result message. */
  attachResultMetadata?: boolean;
  /** Called before execution, after the tool call has been opened. */
  beforeExecute?: () => void;
  /** Prefix for the chat error message shown when execution throws. */
  throwMessagePrefix: string;
}

/** Shape of the tool metadata this service reads for event payloads. */
interface MentionTool {
  visibleInChat?: boolean;
  isTransparentWrapper?: boolean;
  shouldCollapse?: boolean;
  hideOutput?: boolean;
}

export class MentionAttachmentService {
  constructor(
    private readonly toolManager: ToolManager | null,
    private readonly activityStream: ActivityStream,
    private readonly todoPromoter: MentionTodoPromoter | null = null
  ) {}

  /**
   * Attach mentioned files by running the `read` tool.
   *
   * Also auto-promotes the first pending todo to `in_progress`, which keeps the
   * todo list moving when the user hands the agent new files mid-task.
   */
  async attachFiles(
    filePaths: string[],
    agent: MentionAgent,
    addUiMessage: MentionMessageSink
  ): Promise<MentionOutcome> {
    return this.attach(agent, addUiMessage, {
      toolName: 'read',
      missingToolMessage: 'Error: Read tool not available',
      displayArguments: { file_paths: filePaths },
      executeArguments: { file_paths: filePaths, description: 'Read mentioned files' },
      beforeExecute: () => this.promoteNextTodo(),
      throwMessagePrefix: 'Error reading mentioned files',
    });
  }

  /**
   * Attach mentioned directories by running the `tree` tool.
   */
  async attachDirectories(
    dirPaths: string[],
    agent: MentionAgent,
    addUiMessage: MentionMessageSink
  ): Promise<MentionOutcome> {
    return this.attach(agent, addUiMessage, {
      toolName: 'tree',
      missingToolMessage: 'Error: Tree tool not available',
      displayArguments: { paths: dirPaths },
      executeArguments: { paths: dirPaths, description: 'Show directory structure' },
      includeHideOutput: true,
      streamOutputChunk: true,
      attachResultMetadata: true,
      throwMessagePrefix: 'Error showing directory structure',
    });
  }

  /**
   * Shared attachment routine: open a synthetic tool call, execute it through
   * ToolManager, and close it out in every exit path.
   */
  private async attach(
    agent: MentionAgent,
    addUiMessage: MentionMessageSink,
    spec: AttachmentSpec
  ): Promise<MentionOutcome> {
    if (!this.toolManager) {
      addUiMessage({ role: 'assistant', content: 'Error: Tool manager not available' });
      return 'aborted';
    }

    const tool = this.toolManager.getTool(spec.toolName) as MentionTool | undefined;
    if (!tool) {
      addUiMessage({ role: 'assistant', content: spec.missingToolMessage });
      return 'aborted';
    }

    // Unique tool call ID: {tool}-{timestamp}-{7-char-random} (base-36, skip '0.' prefix)
    const toolCallId = `${spec.toolName}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Mirror the shape of a model-issued tool call so the conversation history
    // stays a valid assistant(tool_calls) -> tool sequence. The ID is minted
    // before this message so every later exit path can close the pair.
    agent.addMessage({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: { name: spec.toolName, arguments: spec.displayArguments },
        },
      ],
    } as Message);

    this.activityStream.emit({
      id: toolCallId,
      type: ActivityEventType.TOOL_CALL_START,
      timestamp: Date.now(),
      data: {
        toolName: spec.toolName,
        arguments: spec.displayArguments,
        visibleInChat: tool.visibleInChat ?? true,
        isTransparent: tool.isTransparentWrapper || false,
        ...(spec.includeHideOutput ? { hideOutput: tool.hideOutput || false } : {}),
      },
    });

    // Keep the tool-call watchdog from timing out while this runs.
    agent.resetToolCallActivity?.();

    try {
      spec.beforeExecute?.();

      const result = await this.toolManager.executeTool(
        spec.toolName,
        spec.executeArguments,
        toolCallId,
        false, // isRetry
        agent.getToolAbortSignal?.(),
        true, // isUserInitiated - the user typed this mention themselves
        false, // isContextFile
        agent.getAgentName?.(),
        {
          registryScope: agent.getScopedRegistry?.(),
          agentId: agent.getInstanceId?.(),
          agentName: agent.getAgentName?.(),
        } as never
      );

      if (spec.streamOutputChunk) {
        const displayContent = resolveDisplayContent(result);
        if (result.success && displayContent) {
          this.activityStream.emit({
            id: toolCallId,
            type: ActivityEventType.TOOL_OUTPUT_CHUNK,
            timestamp: Date.now(),
            data: { toolName: spec.toolName, chunk: displayContent },
          });
        }
      }

      this.emitToolCallEnd(toolCallId, spec.toolName, tool, result);

      // Canonical wire builder - strips display-only fields so the model never sees them.
      const toolResultMessage = createToolResultMessage(
        toolCallId,
        spec.toolName,
        result,
        !result.success,
        result.success ? undefined : result.error_type
      ) as Message;

      agent.addMessage(
        spec.attachResultMetadata
          ? { ...toolResultMessage, metadata: this.buildResultMetadata(toolCallId, result) }
          : toolResultMessage
      );

      return 'attached';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const errorResult = createStructuredError(
        message,
        'system_error',
        spec.toolName,
        spec.displayArguments
      );

      // Always close out the tool call so the UI does not hang on a started
      // call, and keep the agent's history a valid tool_calls/tool pair. The
      // result goes through the canonical builder so the model sees a flagged
      // error rather than a bare JSON blob.
      this.emitToolCallEnd(toolCallId, spec.toolName, tool, errorResult);
      agent.addMessage(
        createToolResultMessage(
          toolCallId,
          spec.toolName,
          errorResult,
          true,
          'system_error'
        ) as Message
      );

      addUiMessage({
        role: 'assistant',
        content: `${spec.throwMessagePrefix}: ${message}`,
      });

      return 'aborted';
    }
  }

  /**
   * Promote the first pending todo to `in_progress` when nothing is in flight,
   * so the todo list tracks the work the newly attached files belong to.
   */
  private promoteNextTodo(): void {
    const todoPromoter = this.todoPromoter;
    if (!todoPromoter) return;

    if (todoPromoter.getInProgressTodo?.()) return;

    const nextPending = todoPromoter.getNextPendingTodo?.();
    if (!nextPending) return;

    const todos = todoPromoter.getTodos();
    todoPromoter.setTodos(
      todos.map((todo) => (todo.id === nextPending.id ? { ...todo, status: 'in_progress' } : todo))
    );
  }

  private buildResultMetadata(toolCallId: string, result: ToolResult): Message['metadata'] {
    return {
      tool_status: { [toolCallId]: result.success ? 'success' : 'error' },
      tool_result: {
        [toolCallId]: {
          content: result.content,
          ...(result.display_content !== undefined && { display_content: result.display_content }),
          ...(result.error && { error: result.error }),
          ...(result.error_type !== undefined && { error_type: result.error_type }),
        },
      },
    } as Message['metadata'];
  }

  private emitToolCallEnd(
    toolCallId: string,
    toolName: string,
    tool: MentionTool,
    result: ToolResult
  ): void {
    this.activityStream.emit({
      id: toolCallId,
      type: ActivityEventType.TOOL_CALL_END,
      timestamp: Date.now(),
      data: {
        toolName,
        result,
        success: result.success,
        error: result.success ? undefined : result.error,
        visibleInChat: tool.visibleInChat ?? true,
        isTransparent: tool.isTransparentWrapper || false,
        collapsed: tool.shouldCollapse || false,
      },
    });
  }
}
