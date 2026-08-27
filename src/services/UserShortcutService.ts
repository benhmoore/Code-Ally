/**
 * UserShortcutService - Owns the application logic behind user input shortcuts
 *
 * The terminal UI exposes two shortcuts that are handled entirely on the client,
 * without a model round-trip:
 *
 *   `!<command>` - run a shell command as the user
 *   `#<text>`    - append a line to the project instructions file
 *
 * Both live here rather than inline in the `useInputHandlers` React hook.
 * Inline they cannot be tested without mounting React, and the bash shortcut
 * reaches `BashTool.execute()` directly - bypassing ToolManager argument
 * validation, duplicate detection and tool/agent visibility enforcement.
 *
 * This service owns that orchestration. The hook parses the input, calls the
 * service and renders the messages it hands back; the hook performs no
 * filesystem access, no tool execution, no tool-lifecycle event emission and no
 * conversation-history mutation of its own.
 */

import nodeFs from 'fs';
import path from 'path';
import { ActivityStream } from './ActivityStream.js';
import { ToolManager } from '../tools/ToolManager.js';
import { logger } from './Logger.js';
import { ActivityEventType, Message, ToolResult } from '../types/index.js';
import { createStructuredError } from '../utils/errorUtils.js';
import { createToolResultMessage } from '../llm/FunctionCalling.js';
import {
  getProjectInstructionsFile,
  resolveProjectInstructionFiles,
} from '../config/paths.js';

/**
 * The slice of Agent this service needs.
 *
 * Passed per call rather than constructor-injected, because the active agent is
 * swapped at runtime when the user enters a background agent's view.
 */
export interface ShortcutAgent {
  addMessage(message: Message): void;
  getToolAbortSignal?(): AbortSignal | undefined;
  getAgentName?(): string | undefined;
  getInstanceId?(): string;
  getScopedRegistry?(): unknown;
}

/**
 * Filesystem surface used by the memory shortcut (injectable for tests).
 */
export interface ShortcutFileSystem {
  existsSync(filePath: string): boolean;
  readFileSync(filePath: string, encoding: 'utf-8'): string;
  writeFileSync(filePath: string, data: string, encoding: 'utf-8'): void;
}

/**
 * Sink for user-facing chat messages produced by a shortcut.
 *
 * Called in display order as the shortcut progresses, so the user's echoed
 * input appears before the tool call it started.
 */
export type ShortcutMessageSink = (message: Message) => void;

export interface UserShortcutServiceDeps {
  fs?: ShortcutFileSystem;
  cwd?: () => string;
}

export class UserShortcutService {
  private readonly fs: ShortcutFileSystem;
  private readonly cwd: () => string;

  constructor(
    private readonly toolManager: ToolManager | null,
    private readonly activityStream: ActivityStream,
    deps: UserShortcutServiceDeps = {}
  ) {
    this.fs = deps.fs ?? (nodeFs as unknown as ShortcutFileSystem);
    this.cwd = deps.cwd ?? (() => process.cwd());
  }

  /**
   * Run a user-typed `!<command>` shortcut.
   *
   * Execution goes through `ToolManager.executeTool()` - the same entry point
   * the UI's file/directory mention paths use - so the command inherits schema
   * validation, duplicate detection, tool/agent binding checks and the tool
   * execution context. `isUserInitiated` is set because the command came
   * directly from the user rather than from the model.
   */
  async runBashShortcut(
    command: string,
    agent: ShortcutAgent,
    addUiMessage: ShortcutMessageSink
  ): Promise<void> {
    if (!this.toolManager) {
      addUiMessage({ role: 'assistant', content: 'Error: Tool manager not available' });
      return;
    }

    const bashTool = this.toolManager.getTool('bash');
    if (!bashTool) {
      addUiMessage({ role: 'assistant', content: 'Error: Bash tool not available' });
      return;
    }

    const args = { command, description: 'Execute user command' };
    // Unique tool call ID: bash-{timestamp}-{7-char-random} (base-36, skip '0.' prefix)
    const toolCallId = `bash-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    // Mirror the shape of a model-issued tool call in the conversation history so
    // the transcript stays a valid user -> assistant(tool_calls) -> tool sequence.
    agent.addMessage({ role: 'user', content: command });
    agent.addMessage({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: { name: 'bash', arguments: { command } },
        },
      ],
    } as Message);

    addUiMessage({ role: 'user', content: command });

    this.activityStream.emit({
      id: toolCallId,
      type: ActivityEventType.TOOL_CALL_START,
      timestamp: Date.now(),
      data: {
        toolName: 'bash',
        arguments: { command },
        visibleInChat: bashTool.visibleInChat ?? true,
        isTransparent: bashTool.isTransparentWrapper || false,
      },
    });

    try {
      this.activityStream.emit({
        id: toolCallId,
        type: ActivityEventType.TOOL_EXECUTION_START,
        timestamp: Date.now(),
        data: {},
      });

      const result = await this.toolManager.executeTool(
        'bash',
        args,
        toolCallId,
        false, // isRetry
        agent.getToolAbortSignal?.(),
        true, // isUserInitiated - the user typed this command themselves
        false, // isContextFile
        agent.getAgentName?.(),
        {
          registryScope: agent.getScopedRegistry?.(),
          agentId: agent.getInstanceId?.(),
          agentName: agent.getAgentName?.(),
        } as any
      );

      this.emitToolCallEnd(toolCallId, bashTool, result);

      // Canonical wire builder - strips display-only fields so the model never sees them.
      agent.addMessage(
        createToolResultMessage(
          toolCallId,
          'bash',
          result,
          !result.success,
          result.success ? undefined : result.error_type
        ) as Message
      );

      // The tool call display already shows the result; no extra chat message.
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const errorResult = createStructuredError(message, 'system_error', 'bash', args);

      // Always close out the tool call so the UI does not hang on a started call,
      // and keep the agent's history a valid tool_calls/tool pair.
      this.emitToolCallEnd(toolCallId, bashTool, errorResult);
      agent.addMessage(
        createToolResultMessage(toolCallId, 'bash', errorResult, true, 'system_error') as Message
      );

      addUiMessage({
        role: 'assistant',
        content: `Error executing bash command: ${message}`,
        metadata: { isError: true },
      });
    }
  }

  /**
   * Handle a user-typed `#<text>` shortcut by appending a bullet to the project
   * instructions file that is actually ingested (ALLY.md > CLAUDE.md > AGENTS.md),
   * defaulting to the native ALLY.md when none exist yet.
   */
  saveMemoryShortcut(content: string, rawInput: string, addUiMessage: ShortcutMessageSink): void {
    try {
      const instructionsPath =
        resolveProjectInstructionFiles(this.cwd()).at(-1) ?? getProjectInstructionsFile(this.cwd());
      const fileName = path.basename(instructionsPath);

      const existingContent = this.fs.existsSync(instructionsPath)
        ? this.fs.readFileSync(instructionsPath, 'utf-8')
        : '';

      const newLine = `- ${content}\n`;
      const newContent = existingContent ? existingContent.trimEnd() + '\n' + newLine : newLine;

      this.fs.writeFileSync(instructionsPath, newContent, 'utf-8');

      logger.debug(`[USER_SHORTCUT] Memory saved to ${fileName}:`, content);

      addUiMessage({ role: 'user', content: rawInput });
      addUiMessage({ role: 'assistant', content: `Memory saved to ${fileName}` });
    } catch (error) {
      addUiMessage({
        role: 'assistant',
        content: `Error saving memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
        metadata: { isError: true },
      });
    }
  }

  private emitToolCallEnd(
    toolCallId: string,
    tool: { visibleInChat?: boolean; isTransparentWrapper?: boolean; shouldCollapse?: boolean },
    result: ToolResult
  ): void {
    this.activityStream.emit({
      id: toolCallId,
      type: ActivityEventType.TOOL_CALL_END,
      timestamp: Date.now(),
      data: {
        toolName: 'bash',
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
