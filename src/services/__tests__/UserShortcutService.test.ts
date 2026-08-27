/**
 * UserShortcutService tests
 *
 * Covers the `!` bash shortcut and the `#` memory shortcut: how each is
 * dispatched, and what each hands back to the caller.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import { UserShortcutService, ShortcutAgent, ShortcutFileSystem } from '../UserShortcutService.js';
import { ActivityStream } from '../ActivityStream.js';
import { ToolManager } from '@tools/ToolManager.js';
import { ActivityEventType, Message } from '@shared/index.js';

interface Recorder {
  agent: ShortcutAgent;
  agentMessages: Message[];
  uiMessages: Message[];
  events: any[];
  activityStream: ActivityStream;
}

function createRecorder(): Recorder {
  const agentMessages: Message[] = [];
  const uiMessages: Message[] = [];
  const events: any[] = [];
  const activityStream = new ActivityStream();
  activityStream.emit = ((event: any) => {
    events.push(event);
  }) as any;

  const agent: ShortcutAgent = {
    addMessage: (message: Message) => {
      agentMessages.push(message);
    },
    getAgentName: () => 'main',
    getInstanceId: () => 'agent-1',
    getToolAbortSignal: () => undefined,
  };

  return { agent, agentMessages, uiMessages, events, activityStream };
}

function createToolManager(executeTool: any, tool: any = { visibleInChat: true }): ToolManager {
  return {
    getTool: vi.fn().mockReturnValue(tool),
    executeTool,
  } as unknown as ToolManager;
}

describe('UserShortcutService - bash shortcut', () => {
  let rec: Recorder;

  beforeEach(() => {
    rec = createRecorder();
  });

  it('routes execution through ToolManager.executeTool with isUserInitiated set', async () => {
    const executeTool = vi.fn().mockResolvedValue({ success: true, content: 'hi', error: '' });
    const service = new UserShortcutService(createToolManager(executeTool), rec.activityStream);

    await service.runBashShortcut('echo hi', rec.agent, (m) => rec.uiMessages.push(m));

    expect(executeTool).toHaveBeenCalledTimes(1);
    const call = executeTool.mock.calls[0];
    expect(call[0]).toBe('bash');
    expect(call[1]).toEqual({ command: 'echo hi', description: 'Execute user command' });
    expect(call[3]).toBe(false); // isRetry
    expect(call[5]).toBe(true); // isUserInitiated
    expect(call[6]).toBe(false); // isContextFile
    expect(call[7]).toBe('main'); // currentAgentName
    expect(call[8]).toMatchObject({ agentId: 'agent-1', agentName: 'main' });
  });

  it('produces a valid user -> assistant(tool_calls) -> tool message sequence', async () => {
    const executeTool = vi.fn().mockResolvedValue({ success: true, content: 'hi', error: '' });
    const service = new UserShortcutService(createToolManager(executeTool), rec.activityStream);

    await service.runBashShortcut('echo hi', rec.agent, (m) => rec.uiMessages.push(m));

    expect(rec.agentMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(rec.agentMessages[0]?.content).toBe('echo hi');

    const assistant = rec.agentMessages[1] as any;
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].function.name).toBe('bash');
    expect(assistant.tool_calls[0].function.arguments).toEqual({ command: 'echo hi' });

    const toolResult = rec.agentMessages[2] as any;
    expect(toolResult.tool_call_id).toBe(assistant.tool_calls[0].id);
    expect(toolResult.name).toBe('bash');
    expect(toolResult.content).toContain('hi');

    // The tool call display shows the output; only the echoed command goes to chat
    expect(rec.uiMessages).toEqual([{ role: 'user', content: 'echo hi' }]);
  });

  it('emits the complete tool lifecycle', async () => {
    const executeTool = vi.fn().mockResolvedValue({ success: true, content: 'hi', error: '' });
    const service = new UserShortcutService(createToolManager(executeTool), rec.activityStream);

    await service.runBashShortcut('echo hi', rec.agent, (m) => rec.uiMessages.push(m));

    expect(rec.events.map((event) => event.type)).toEqual([
      ActivityEventType.TOOL_CALL_START,
      ActivityEventType.TOOL_EXECUTION_START,
      ActivityEventType.TOOL_CALL_END,
    ]);
    expect(rec.events.every((event) => event.id === rec.events[0].id)).toBe(true);
    expect(rec.events[2].data.success).toBe(true);
    expect(rec.events[2].data.executionStartTime).toBe(rec.events[1].timestamp);
  });

  it('reports a failed tool result without an extra chat error message', async () => {
    const executeTool = vi.fn().mockResolvedValue({
      success: false,
      content: '',
      error: 'command not found',
      error_type: 'execution_error',
    });
    const service = new UserShortcutService(createToolManager(executeTool), rec.activityStream);

    await service.runBashShortcut('nope', rec.agent, (m) => rec.uiMessages.push(m));

    expect(rec.events[2].data.success).toBe(false);
    expect(rec.events[2].data.error).toBe('command not found');
    expect((rec.agentMessages[2] as any).is_error).toBe(true);
    expect(rec.uiMessages).toEqual([{ role: 'user', content: 'nope' }]);
  });

  it('closes out the tool call and history when execution throws', async () => {
    const executeTool = vi.fn().mockRejectedValue(new Error('boom'));
    const service = new UserShortcutService(createToolManager(executeTool), rec.activityStream);

    await service.runBashShortcut('explode', rec.agent, (m) => rec.uiMessages.push(m));

    // TOOL_CALL_END still emitted so the UI does not hang on a started call
    expect(rec.events.map((e) => e.type)).toEqual([
      ActivityEventType.TOOL_CALL_START,
      ActivityEventType.TOOL_EXECUTION_START,
      ActivityEventType.TOOL_CALL_END,
    ]);
    expect(rec.events[2].data.success).toBe(false);

    // Agent history keeps a valid tool_calls/tool pair
    expect(rec.agentMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect((rec.agentMessages[2] as any).tool_call_id).toBe(
      (rec.agentMessages[1] as any).tool_calls[0].id
    );

    expect(rec.uiMessages[1]).toMatchObject({
      role: 'assistant',
      content: 'Error executing bash command: boom',
      metadata: { isError: true },
    });
  });

  it('reports missing collaborators instead of executing', async () => {
    const noManager = new UserShortcutService(null, rec.activityStream);
    await noManager.runBashShortcut('ls', rec.agent, (m) => rec.uiMessages.push(m));
    expect(rec.uiMessages).toEqual([
      { role: 'assistant', content: 'Error: Tool manager not available' },
    ]);

    rec.uiMessages.length = 0;
    const noTool = new UserShortcutService(
      createToolManager(vi.fn(), null),
      rec.activityStream
    );
    await noTool.runBashShortcut('ls', rec.agent, (m) => rec.uiMessages.push(m));
    expect(rec.uiMessages).toEqual([
      { role: 'assistant', content: 'Error: Bash tool not available' },
    ]);
    expect(rec.agentMessages).toEqual([]);
  });
});

describe('UserShortcutService - memory shortcut', () => {
  let rec: Recorder;
  let files: Map<string, string>;
  let fsStub: ShortcutFileSystem;
  const projectDir = path.resolve('/tmp/user-shortcut-service-project');

  beforeEach(() => {
    rec = createRecorder();
    files = new Map<string, string>();
    fsStub = {
      existsSync: (p: string) => files.has(p),
      readFileSync: (p: string) => files.get(p) ?? '',
      writeFileSync: (p: string, data: string) => {
        files.set(p, data);
      },
    };
  });

  const makeService = (overrides: Partial<ShortcutFileSystem> = {}) =>
    new UserShortcutService(createToolManager(vi.fn()), rec.activityStream, {
      fs: { ...fsStub, ...overrides },
      cwd: () => projectDir,
    });

  it('creates ALLY.md when no instructions file exists', () => {
    const service = makeService();

    service.saveMemoryShortcut('always run tests', '# always run tests', (m) =>
      rec.uiMessages.push(m)
    );

    const allyPath = path.join(projectDir, 'ALLY.md');
    expect(files.get(allyPath)).toBe('- always run tests\n');
    expect(rec.uiMessages).toEqual([
      { role: 'user', content: '# always run tests' },
      { role: 'assistant', content: 'Memory saved to ALLY.md' },
    ]);
  });

  it('appends a bullet to an existing instructions file', () => {
    const allyPath = path.join(projectDir, 'ALLY.md');
    files.set(allyPath, '# Project\n\n- first rule\n\n');
    const service = makeService();

    service.saveMemoryShortcut('second rule', '# second rule', (m) => rec.uiMessages.push(m));

    expect(files.get(allyPath)).toBe('# Project\n\n- first rule\n- second rule\n');
    expect(rec.uiMessages[1]).toEqual({
      role: 'assistant',
      content: 'Memory saved to ALLY.md',
    });
  });

  it('reports a write failure as an error message and writes nothing', () => {
    const service = makeService({
      writeFileSync: () => {
        throw new Error('EACCES: permission denied');
      },
    });

    service.saveMemoryShortcut('unwritable', '# unwritable', (m) => rec.uiMessages.push(m));

    expect(files.size).toBe(0);
    expect(rec.uiMessages).toEqual([
      {
        role: 'assistant',
        content: 'Error saving memory: EACCES: permission denied',
        metadata: { isError: true },
      },
    ]);
  });
});
