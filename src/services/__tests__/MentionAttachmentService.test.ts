/**
 * MentionAttachmentService tests
 *
 * Covers the `@file` and `@dir` mention paths. The invariants
 * that matter to the model are the message sequence and the tool_calls/tool
 * pairing; the invariant that matters to the user is that a started tool call is
 * always closed, including when execution throws.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MentionAttachmentService,
  MentionAgent,
  MentionTodoPromoter,
} from '../MentionAttachmentService.js';
import { ActivityStream } from '../ActivityStream.js';
import { ToolManager } from '@tools/ToolManager.js';
import { ActivityEventType, Message } from '@shared/index.js';

interface Recorder {
  agent: MentionAgent;
  agentMessages: Message[];
  uiMessages: Message[];
  events: any[];
  activityStream: ActivityStream;
  resetCalls: number;
}

function createRecorder(): Recorder {
  const agentMessages: Message[] = [];
  const uiMessages: Message[] = [];
  const events: any[] = [];
  const activityStream = new ActivityStream();
  activityStream.emit = ((event: any) => {
    events.push(event);
  }) as any;

  const rec: Recorder = {
    agentMessages,
    uiMessages,
    events,
    activityStream,
    resetCalls: 0,
    agent: null as unknown as MentionAgent,
  };

  rec.agent = {
    addMessage: (message: Message) => {
      agentMessages.push(message);
    },
    resetToolCallActivity: () => {
      rec.resetCalls += 1;
    },
    getAgentName: () => 'main',
    getInstanceId: () => 'agent-1',
    getToolAbortSignal: () => undefined,
  };

  return rec;
}

function createToolManager(executeTool: any, tool: any = { visibleInChat: true }): ToolManager {
  return {
    getTool: vi.fn().mockReturnValue(tool),
    executeTool,
  } as unknown as ToolManager;
}

const ok = (content: string) => ({ success: true, content, error: '' });

describe('MentionAttachmentService - file mentions', () => {
  let rec: Recorder;

  beforeEach(() => {
    rec = createRecorder();
  });

  it('produces an assistant(tool_calls) -> tool sequence with matching ids', async () => {
    const executeTool = vi.fn().mockResolvedValue(ok('file body'));
    const service = new MentionAttachmentService(createToolManager(executeTool), rec.activityStream);

    const outcome = await service.attachFiles(['a.ts', 'b.ts'], rec.agent, (m) =>
      rec.uiMessages.push(m)
    );

    expect(outcome).toBe('attached');
    expect(rec.agentMessages.map((m) => m.role)).toEqual([
      'assistant', 'tool', 'assistant', 'tool',
    ]);

    const assistant = rec.agentMessages[0] as any;
    expect(assistant.content).toBe('');
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].type).toBe('function');
    expect(assistant.tool_calls[0].function.name).toBe('read');
    expect(assistant.tool_calls[0].function.arguments).toEqual({ file_path: 'a.ts' });

    const toolResult = rec.agentMessages[1] as any;
    expect(toolResult.role).toBe('tool');
    expect(toolResult.name).toBe('read');
    expect(toolResult.tool_call_id).toBe(assistant.tool_calls[0].id);
    expect(toolResult.content).toContain('file body');
    expect(toolResult.is_error).toBeUndefined();

    const secondAssistant = rec.agentMessages[2] as any;
    const secondResult = rec.agentMessages[3] as any;
    expect(secondAssistant.tool_calls[0].function.arguments).toEqual({ file_path: 'b.ts' });
    expect(secondResult.tool_call_id).toBe(secondAssistant.tool_calls[0].id);

    // Nothing extra in chat - the tool call element renders the result
    expect(rec.uiMessages).toEqual([]);
  });

  it('executes through ToolManager.executeTool with isUserInitiated set', async () => {
    const executeTool = vi.fn().mockResolvedValue(ok('x'));
    const service = new MentionAttachmentService(createToolManager(executeTool), rec.activityStream);

    await service.attachFiles(['a.ts'], rec.agent, (m) => rec.uiMessages.push(m));

    expect(executeTool).toHaveBeenCalledTimes(1);
    const call = executeTool.mock.calls[0];
    expect(call[0]).toBe('read');
    expect(call[1]).toEqual({ file_path: 'a.ts', description: 'Read mentioned file' });
    expect(call[2]).toBe((rec.agentMessages[0] as any).tool_calls[0].id);
    expect(call[3]).toBe(false); // isRetry
    expect(call[5]).toBe(true); // isUserInitiated - raises ReadTool's truncation limit
    expect(call[6]).toBe(false); // isContextFile
    expect(call[7]).toBe('main'); // currentAgentName
    expect(call[8]).toMatchObject({ agentId: 'agent-1', agentName: 'main' });

    // The tool-call watchdog is kept alive while the mention resolves
    expect(rec.resetCalls).toBe(1);
  });

  it('emits a matching TOOL_CALL_START / TOOL_CALL_END pair', async () => {
    const executeTool = vi.fn().mockResolvedValue(ok('x'));
    const service = new MentionAttachmentService(createToolManager(executeTool), rec.activityStream);

    await service.attachFiles(['a.ts'], rec.agent, (m) => rec.uiMessages.push(m));

    expect(rec.events.map((e) => e.type)).toEqual([
      ActivityEventType.TOOL_CALL_START,
      ActivityEventType.TOOL_CALL_END,
    ]);
    expect(rec.events[0].id).toBe(rec.events[1].id);
    expect(rec.events[0].id).toBe((rec.agentMessages[0] as any).tool_calls[0].id);
    expect(rec.events[0].data.arguments).toEqual({ file_path: 'a.ts' });
    expect(rec.events[1].data.success).toBe(true);
  });

  it('records a failed tool result as an error but still lets the message be sent', async () => {
    const executeTool = vi.fn().mockResolvedValue({
      success: false,
      content: '',
      error: 'ENOENT: no such file',
      error_type: 'file_not_found',
    });
    const service = new MentionAttachmentService(createToolManager(executeTool), rec.activityStream);

    const outcome = await service.attachFiles(['missing.ts'], rec.agent, (m) =>
      rec.uiMessages.push(m)
    );

    // A tool-level failure is a normal, recorded outcome - the user's message goes through
    expect(outcome).toBe('attached');
    expect(rec.events[1].data.success).toBe(false);
    expect(rec.events[1].data.error).toBe('ENOENT: no such file');

    const toolResult = rec.agentMessages[1] as any;
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain('<error type="file_not_found">');
    expect(toolResult.tool_call_id).toBe((rec.agentMessages[0] as any).tool_calls[0].id);
    expect(rec.uiMessages).toEqual([]);
  });

  it('closes out the tool call and history when execution throws', async () => {
    const executeTool = vi.fn().mockRejectedValue(new Error('boom'));
    const service = new MentionAttachmentService(createToolManager(executeTool), rec.activityStream);

    const outcome = await service.attachFiles(['a.ts'], rec.agent, (m) => rec.uiMessages.push(m));

    expect(outcome).toBe('aborted');

    // TOOL_CALL_END still emitted so the UI does not hang on a started call
    expect(rec.events.map((e) => e.type)).toEqual([
      ActivityEventType.TOOL_CALL_START,
      ActivityEventType.TOOL_CALL_END,
    ]);
    expect(rec.events[1].id).toBe(rec.events[0].id);
    expect(rec.events[1].data.success).toBe(false);
    expect(rec.events[1].data.error).toContain('boom');

    // History keeps a valid tool_calls/tool pair - no dangling assistant tool call
    expect(rec.agentMessages.map((m) => m.role)).toEqual(['assistant', 'tool']);
    const assistant = rec.agentMessages[0] as any;
    const toolResult = rec.agentMessages[1] as any;
    expect(toolResult.tool_call_id).toBe(assistant.tool_calls[0].id);

    // The thrown error reaches the model as a flagged error, not a bare JSON blob
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain(`[Tool Call ID: ${assistant.tool_calls[0].id}]`);
    expect(toolResult.content).toContain('<error type="system_error">');
    expect(toolResult.content).toContain('boom');

    expect(rec.uiMessages).toEqual([
      { role: 'assistant', content: 'Error reading mentioned file: boom' },
    ]);
  });

  it('aborts without touching history when collaborators are missing', async () => {
    const noManager = new MentionAttachmentService(null, rec.activityStream);
    expect(await noManager.attachFiles(['a.ts'], rec.agent, (m) => rec.uiMessages.push(m))).toBe(
      'aborted'
    );
    expect(rec.uiMessages).toEqual([
      { role: 'assistant', content: 'Error: Tool manager not available' },
    ]);

    rec.uiMessages.length = 0;
    const noTool = new MentionAttachmentService(
      createToolManager(vi.fn(), null),
      rec.activityStream
    );
    expect(await noTool.attachFiles(['a.ts'], rec.agent, (m) => rec.uiMessages.push(m))).toBe(
      'aborted'
    );
    expect(rec.uiMessages).toEqual([
      { role: 'assistant', content: 'Error: Read tool not available' },
    ]);

    expect(rec.agentMessages).toEqual([]);
    expect(rec.events).toEqual([]);
  });
});

describe('MentionAttachmentService - todo promotion on file mentions', () => {
  let rec: Recorder;

  beforeEach(() => {
    rec = createRecorder();
  });

  const promoter = (overrides: Partial<MentionTodoPromoter>): MentionTodoPromoter => ({
    getInProgressTodo: () => null,
    getNextPendingTodo: () => null,
    getTodos: () => [],
    setTodos: vi.fn(),
    ...overrides,
  });

  it('promotes the first pending todo when nothing is in progress', async () => {
    const setTodos = vi.fn();
    const todos = [
      { id: 't1', status: 'pending' },
      { id: 't2', status: 'pending' },
    ];
    const service = new MentionAttachmentService(
      createToolManager(vi.fn().mockResolvedValue(ok('x'))),
      rec.activityStream,
      promoter({ getNextPendingTodo: () => ({ id: 't1' }), getTodos: () => todos, setTodos })
    );

    await service.attachFiles(['a.ts'], rec.agent, (m) => rec.uiMessages.push(m));

    expect(setTodos).toHaveBeenCalledWith([
      { id: 't1', status: 'in_progress' },
      { id: 't2', status: 'pending' },
    ]);
  });

  it('leaves todos alone when one is already in progress', async () => {
    const setTodos = vi.fn();
    const service = new MentionAttachmentService(
      createToolManager(vi.fn().mockResolvedValue(ok('x'))),
      rec.activityStream,
      promoter({ getInProgressTodo: () => ({ id: 't1' }), setTodos })
    );

    await service.attachFiles(['a.ts'], rec.agent, (m) => rec.uiMessages.push(m));

    expect(setTodos).not.toHaveBeenCalled();
  });

  it('does not promote todos for directory mentions', async () => {
    const setTodos = vi.fn();
    const service = new MentionAttachmentService(
      createToolManager(vi.fn().mockResolvedValue(ok('x'))),
      rec.activityStream,
      promoter({ getNextPendingTodo: () => ({ id: 't1' }), setTodos })
    );

    await service.attachDirectories(['src'], rec.agent, (m) => rec.uiMessages.push(m));

    expect(setTodos).not.toHaveBeenCalled();
  });
});

describe('MentionAttachmentService - directory mentions', () => {
  let rec: Recorder;

  beforeEach(() => {
    rec = createRecorder();
  });

  it('produces an assistant(tool_calls) -> tool sequence with matching ids', async () => {
    const executeTool = vi.fn().mockResolvedValue(ok('src/\n  index.ts'));
    const service = new MentionAttachmentService(createToolManager(executeTool), rec.activityStream);

    const outcome = await service.attachDirectories(['src', 'test'], rec.agent, (m) =>
      rec.uiMessages.push(m)
    );

    expect(outcome).toBe('attached');
    expect(rec.agentMessages.map((m) => m.role)).toEqual(['assistant', 'tool']);

    const assistant = rec.agentMessages[0] as any;
    expect(assistant.tool_calls[0].function.name).toBe('tree');
    expect(assistant.tool_calls[0].function.arguments).toEqual({ paths: ['src', 'test'] });

    const toolResult = rec.agentMessages[1] as any;
    expect(toolResult.name).toBe('tree');
    expect(toolResult.tool_call_id).toBe(assistant.tool_calls[0].id);

    expect(executeTool.mock.calls[0][1]).toEqual({
      paths: ['src', 'test'],
      description: 'Show directory structure',
    });
    expect(executeTool.mock.calls[0][5]).toBe(true); // isUserInitiated
  });

  it('carries per-call status and result metadata on the tool-result message', async () => {
    const executeTool = vi.fn().mockResolvedValue({
      success: true,
      content: 'model view',
      display_content: 'user view',
      error: '',
    });
    const service = new MentionAttachmentService(createToolManager(executeTool), rec.activityStream);

    await service.attachDirectories(['src'], rec.agent, (m) => rec.uiMessages.push(m));

    const toolResult = rec.agentMessages[1] as any;
    const callId = (rec.agentMessages[0] as any).tool_calls[0].id;
    expect(toolResult.metadata.tool_status).toEqual({ [callId]: 'success' });
    expect(toolResult.metadata.tool_result[callId]).toEqual({
      content: 'model view',
      display_content: 'user view',
    });

    // The model-facing content never carries the display-only field
    expect(toolResult.content).toContain('model view');
    expect(toolResult.content).not.toContain('"display_content"');
  });

  it('streams the resolved display content before closing the call', async () => {
    const executeTool = vi.fn().mockResolvedValue({
      success: true,
      content: 'model view',
      display_content: 'user view',
      error: '',
    });
    const service = new MentionAttachmentService(createToolManager(executeTool), rec.activityStream);

    await service.attachDirectories(['src'], rec.agent, (m) => rec.uiMessages.push(m));

    expect(rec.events.map((e) => e.type)).toEqual([
      ActivityEventType.TOOL_CALL_START,
      ActivityEventType.TOOL_OUTPUT_CHUNK,
      ActivityEventType.TOOL_CALL_END,
    ]);
    expect(rec.events[1].data.chunk).toBe('user view');
    expect(rec.events.every((e) => e.id === rec.events[0].id)).toBe(true);
  });

  it('emits no output chunk when the tool fails', async () => {
    const executeTool = vi.fn().mockResolvedValue({
      success: false,
      content: '',
      error: 'not a directory',
      error_type: 'invalid_path',
    });
    const service = new MentionAttachmentService(createToolManager(executeTool), rec.activityStream);

    const outcome = await service.attachDirectories(['nope'], rec.agent, (m) =>
      rec.uiMessages.push(m)
    );

    expect(outcome).toBe('attached');
    expect(rec.events.map((e) => e.type)).toEqual([
      ActivityEventType.TOOL_CALL_START,
      ActivityEventType.TOOL_CALL_END,
    ]);

    const toolResult = rec.agentMessages[1] as any;
    expect(toolResult.is_error).toBe(true);
    const callId = (rec.agentMessages[0] as any).tool_calls[0].id;
    expect(toolResult.metadata.tool_status).toEqual({ [callId]: 'error' });
    expect(toolResult.metadata.tool_result[callId]).toMatchObject({
      error: 'not a directory',
      error_type: 'invalid_path',
    });
  });

  it('closes out the tool call and history when execution throws', async () => {
    const executeTool = vi.fn().mockRejectedValue(new Error('tree exploded'));
    const service = new MentionAttachmentService(createToolManager(executeTool), rec.activityStream);

    const outcome = await service.attachDirectories(['src'], rec.agent, (m) =>
      rec.uiMessages.push(m)
    );

    expect(outcome).toBe('aborted');
    expect(rec.events.map((e) => e.type)).toEqual([
      ActivityEventType.TOOL_CALL_START,
      ActivityEventType.TOOL_CALL_END,
    ]);
    expect(rec.agentMessages.map((m) => m.role)).toEqual(['assistant', 'tool']);

    const assistant = rec.agentMessages[0] as any;
    const toolResult = rec.agentMessages[1] as any;
    expect(toolResult.tool_call_id).toBe(assistant.tool_calls[0].id);
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain('<error type="system_error">');
    expect(toolResult.content).toContain('tree exploded');

    expect(rec.uiMessages).toEqual([
      { role: 'assistant', content: 'Error showing directory structure: tree exploded' },
    ]);
  });

  it('reports a missing tree tool without opening a call', async () => {
    const service = new MentionAttachmentService(
      createToolManager(vi.fn(), null),
      rec.activityStream
    );

    expect(
      await service.attachDirectories(['src'], rec.agent, (m) => rec.uiMessages.push(m))
    ).toBe('aborted');
    expect(rec.uiMessages).toEqual([
      { role: 'assistant', content: 'Error: Tree tool not available' },
    ]);
    expect(rec.agentMessages).toEqual([]);
    expect(rec.events).toEqual([]);
  });

  it('propagates tool display flags into the lifecycle events', async () => {
    const executeTool = vi.fn().mockResolvedValue(ok('x'));
    const service = new MentionAttachmentService(
      createToolManager(executeTool, {
        visibleInChat: false,
        isTransparentWrapper: true,
        shouldCollapse: true,
        hideOutput: true,
      }),
      rec.activityStream
    );

    await service.attachDirectories(['src'], rec.agent, (m) => rec.uiMessages.push(m));

    expect(rec.events[0].data).toMatchObject({
      visibleInChat: false,
      isTransparent: true,
      hideOutput: true,
    });
    const end = rec.events[rec.events.length - 1];
    expect(end.data).toMatchObject({
      visibleInChat: false,
      isTransparent: true,
      collapsed: true,
    });
  });
});
