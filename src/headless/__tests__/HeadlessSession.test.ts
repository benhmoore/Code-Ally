import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Agent } from '@agent/Agent.js';
import { ToolManager } from '@tools/ToolManager.js';
import { ActivityStream } from '@services/ActivityStream.js';
import type { ModelClient, LLMResponse, SendOptions } from '@llm/ModelClient.js';
import { ActivityEventType, type Config, type Message } from '@shared/index.js';
import type { SessionManager } from '@services/SessionManager.js';
import type { CLIOptions } from '@cli/ArgumentParser.js';
import type { RunOutcome } from '@services/RunSupervisor.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { StructuredOutputTool, STRUCTURED_OUTPUT_TOOL } from '@tools/StructuredOutputTool.js';
import type { ParameterSchema } from '@shared/index.js';
import { HeadlessSession, assertSafeSessionId, openHeadlessSession } from '../HeadlessSession.js';
import type { WireEvent } from '../wire.js';

/** The verdict-shaped schema a triage caller asks for. */
const VERDICT_SCHEMA: ParameterSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fingerprint', 'outcome', 'summary'],
        properties: {
          fingerprint: { type: 'string' },
          outcome: { enum: ['fixed', 'dismissed', 'escalated', 'skipped', 'resolved'] },
          repo: { type: 'string' },
          branch: { type: 'string' },
          commit: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
  },
};

const VERDICT = {
  results: [{ fingerprint: 'abc123', outcome: 'fixed', summary: 'Patched the null guard.' }],
};

/** A model reply that calls the structured-output tool with `payload`. */
function structuredCall(payload: unknown): LLMResponse {
  return {
    content: '',
    tool_calls: [{
      id: 'call-structured',
      type: 'function',
      function: { name: STRUCTURED_OUTPUT_TOOL, arguments: payload as Record<string, any> },
    }],
    interrupted: false,
  };
}

const CONFIG = {
  model: 'test-model',
  endpoint: 'http://localhost:11434',
  context_size: 8192,
  temperature: 0.7,
  max_tokens: 2048,
  bash_timeout: 120000,
  auto_confirm: true,
  parallel_tools: false,
  stream_responses: false,
  setup_completed: true,
} as unknown as Config;

const COMPLETED: RunOutcome = { kind: 'completed', summary: 'done' };

/** Collects the lines the session writes, parsed back into wire events. */
function collector(): { stream: NodeJS.WritableStream; events: () => WireEvent[] } {
  const lines: string[] = [];
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return {
    stream,
    events: () => lines.join('').split('\n').filter(Boolean).map(line => JSON.parse(line) as WireEvent),
  };
}

function sessionManagerStub(): SessionManager {
  return {
    sessionExists: vi.fn().mockResolvedValue(false),
    createSession: vi.fn().mockResolvedValue('created'),
    setCurrentSession: vi.fn(),
    getCurrentSession: vi.fn().mockReturnValue(null),
    getSessionMessages: vi.fn().mockResolvedValue([]),
    saveSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager;
}

describe('HeadlessSession', () => {
  let agent: Agent;
  let activityStream: ActivityStream;
  let modelClient: ModelClient;
  /** Replies the fake model returns, in order. A function waits for the signal. */
  let replies: Array<string | ((signal: AbortSignal) => Promise<LLMResponse>)>;

  /** Build the session the way the composition root does, session first. */
  async function session(options: CLIOptions, extra: Partial<{
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    getOutcome: () => RunOutcome | undefined;
    sessionManager: SessionManager;
  }> = {}): Promise<HeadlessSession> {
    const sessionManager = extra.sessionManager ?? sessionManagerStub();
    return new HeadlessSession({
      agent,
      sessionManager,
      options,
      session: await openHeadlessSession(options, sessionManager),
      model: 'test-model',
      toolNames: ['bash', 'read'],
      cwd: '/work',
      getOutcome: extra.getOutcome ?? (() => COMPLETED),
      stdin: extra.stdin,
      stdout: extra.stdout,
    });
  }

  beforeEach(() => {
    replies = [];
    modelClient = {
      modelName: 'test-model',
      send: vi.fn(async (_messages: readonly Message[], options: SendOptions): Promise<LLMResponse> => {
        const reply = replies.shift() ?? 'Mock response';
        if (typeof reply === 'function') return reply(options.signal);
        return { content: reply, tool_calls: [], interrupted: false };
      }),
      close: vi.fn(),
      cancel: vi.fn(),
      setModelName: vi.fn(),
    } as unknown as ModelClient;

    activityStream = new ActivityStream();
    agent = new Agent(modelClient, new ToolManager([]), activityStream, {
      config: CONFIG,
      isSpecializedAgent: false,
      isOnceMode: true,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await agent.cleanup();
  });

  it('rejects a session id that is not a safe file name', () => {
    expect(() => assertSafeSessionId('../escape')).toThrow('Invalid --session-id');
    expect(() => assertSafeSessionId('run_2026-09-10.1')).not.toThrow();
  });

  it('prints only the response text in text mode', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    replies = ['The answer.'];

    const outcome = await (await session({ once: 'question' })).run();

    expect(outcome).toEqual(COMPLETED);
    expect(log.mock.calls).toEqual([['The answer.']]);
  });

  it('writes only the final result object in json mode', async () => {
    const out = collector();
    replies = ['The answer.'];

    await (await session({ once: 'question', outputFormat: 'json' }, { stdout: out.stream })).run();

    expect(out.events()).toEqual([expect.objectContaining({
      type: 'result',
      subtype: 'success',
      result: 'The answer.',
      outcome: COMPLETED,
      num_turns: 1,
      is_error: false,
    })]);
  });

  it('writes init, assistant and result events in stream-json mode', async () => {
    const out = collector();
    replies = ['The answer.'];

    await (await session({ once: 'question', outputFormat: 'stream-json', sessionId: 'run-1' },
      { stdout: out.stream })).run();

    const events = out.events();
    expect(events[0]).toEqual({
      type: 'system',
      subtype: 'init',
      session_id: 'run-1',
      model: 'test-model',
      tools: ['bash', 'read'],
      cwd: '/work',
    });
    expect(events).toContainEqual({
      type: 'assistant',
      session_id: 'run-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The answer.' }] },
    });
    const result = events.at(-1) as { type: string; session_id: string; duration_ms: number };
    expect(result.type).toBe('result');
    expect(result.session_id).toBe('run-1');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('maps tool calls onto tool_use and tool_result events', async () => {
    const out = collector();
    replies = [async () => {
      activityStream.emit({
        id: 'call-1', type: ActivityEventType.TOOL_CALL_START, timestamp: Date.now(),
        data: { toolName: 'bash', arguments: { command: 'ls' } },
      });
      activityStream.emit({
        id: 'group-1', type: ActivityEventType.TOOL_CALL_START, timestamp: Date.now(),
        data: { groupExecution: true, toolCount: 1 },
      });
      activityStream.emit({
        id: 'call-1', type: ActivityEventType.TOOL_CALL_END, timestamp: Date.now(),
        data: { success: true, toolName: 'bash', output: 'src' },
      });
      return { content: 'Listed.', tool_calls: [], interrupted: false };
    }];

    await (await session({ once: 'list files', outputFormat: 'stream-json', sessionId: 'run-2' },
      { stdout: out.stream })).run();

    const events = out.events();
    expect(events).toContainEqual({
      type: 'tool_use', session_id: 'run-2', id: 'call-1', name: 'bash', input: { command: 'ls' },
    });
    expect(events).toContainEqual({
      type: 'tool_result', session_id: 'run-2', tool_use_id: 'call-1', is_error: false, content: 'src',
    });
    expect(events.filter(event => event.type === 'tool_use')).toHaveLength(1);
  });

  it('runs a second user line as its own turn and ends when stdin closes', async () => {
    const out = collector();
    const stdin = new PassThrough();
    replies = ['First.', 'Second.'];

    const run = (await session({ inputFormat: 'stream-json', outputFormat: 'stream-json', sessionId: 'run-3' },
      { stdin, stdout: out.stream })).run();

    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'one' } })}\n`);
    await vi.waitFor(() => expect(out.events().filter(e => e.type === 'result')).toHaveLength(1));
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'two' } })}\n`);
    await vi.waitFor(() => expect(out.events().filter(e => e.type === 'result')).toHaveLength(2));
    stdin.end();

    expect(await run).toEqual(COMPLETED);
    const results = out.events().filter((e): e is Extract<WireEvent, { type: 'result' }> => e.type === 'result');
    expect(results.map(r => [r.result, r.num_turns, r.subtype]))
      .toEqual([['First.', 1, 'success'], ['Second.', 2, 'success']]);
  });

  it('interjects a user line that arrives during an active turn', async () => {
    const out = collector();
    const stdin = new PassThrough();
    const interject = vi.spyOn(agent, 'addUserInterjection');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    replies = [async () => { await held; return { content: 'Done.', tool_calls: [], interrupted: false }; }];

    const run = (await session({ once: 'start', inputFormat: 'stream-json', outputFormat: 'stream-json' },
      { stdin, stdout: out.stream })).run();

    await vi.waitFor(() => expect(modelClient.send).toHaveBeenCalled());
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'also this' } })}\n`);
    await vi.waitFor(() => expect(interject).toHaveBeenCalledExactlyOnceWith('also this'));
    release();
    stdin.end();
    await run;

    expect(out.events().filter(e => e.type === 'result')).toHaveLength(1);
  });

  it('reports an interrupted turn then a successful wrap-up turn', async () => {
    const out = collector();
    const stdin = new PassThrough();
    replies = [
      signal => new Promise<LLMResponse>(resolve => {
        signal.addEventListener('abort', () =>
          resolve({ content: '', tool_calls: [], interrupted: true }), { once: true });
      }),
      'Wrapped up.',
    ];

    const run = (await session({ once: 'long task', inputFormat: 'stream-json', outputFormat: 'stream-json' },
      { stdin, stdout: out.stream })).run();

    await vi.waitFor(() => expect(modelClient.send).toHaveBeenCalled());
    stdin.write(`${JSON.stringify({
      type: 'control_request', request_id: 'req-1', request: { subtype: 'interrupt' },
    })}\n`);
    await vi.waitFor(() => expect(out.events().filter(e => e.type === 'result')).toHaveLength(1));
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'wrap up' } })}\n`);
    await vi.waitFor(() => expect(out.events().filter(e => e.type === 'result')).toHaveLength(2));
    stdin.end();
    await run;

    const events = out.events();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req-1' },
    }));
    const results = events.filter((e): e is Extract<WireEvent, { type: 'result' }> => e.type === 'result');
    expect(results.map(r => [r.subtype, r.is_error]))
      .toEqual([['error_during_execution', true], ['success', false]]);
  });

  it('reports the structured output slot on the result once it is set', async () => {
    const out = collector();
    const headless = await session({ once: 'question', outputFormat: 'json' }, { stdout: out.stream });
    replies = [async () => {
      headless.setStructuredOutput({ verdict: 'ok' });
      return { content: 'The answer.', tool_calls: [], interrupted: false };
    }];

    await headless.run();

    expect(out.events()[0]).toMatchObject({ structured_output: { verdict: 'ok' } });
  });

  describe('structured output', () => {
    const REMINDER = `Record your final answer with the ${STRUCTURED_OUTPUT_TOOL} tool before ending your turn.`;

    beforeEach(async () => {
      await agent.cleanup();
      agent = new Agent(modelClient, new ToolManager([
        new StructuredOutputTool(activityStream, VERDICT_SCHEMA),
      ]), activityStream, {
        config: CONFIG,
        isSpecializedAgent: false,
        isOnceMode: true,
        requirements: {
          required_tools_all: [STRUCTURED_OUTPUT_TOOL],
          reminder_message: REMINDER,
        },
      });
    });

    /** Wire the sink the way the composition root does. */
    function sinkFor(headless: HeadlessSession): HeadlessSession {
      ServiceRegistry.getInstance().registerInstance('structured_output_sink', {
        set: value => headless.setStructuredOutput(value),
      });
      return headless;
    }

    it('carries the payload the model recorded onto the result event', async () => {
      const out = collector();
      replies = [async () => structuredCall(VERDICT), 'Recorded.'];

      const headless = sinkFor(await session({ once: 'triage', outputFormat: 'json' }, { stdout: out.stream }));
      await headless.run();

      expect(out.events()[0]).toMatchObject({
        type: 'result',
        subtype: 'success',
        structured_output: VERDICT,
      });
    });

    it('reminds a model that ends its turn without recording anything', async () => {
      const out = collector();
      replies = ['Nothing to report.', async () => structuredCall(VERDICT), 'Recorded.'];

      const headless = sinkFor(await session({ once: 'triage', outputFormat: 'json' }, { stdout: out.stream }));
      await headless.run();

      const sent = vi.mocked(modelClient.send).mock.calls;
      expect(sent.length).toBe(3);
      expect(JSON.stringify(sent[1]![0])).toContain(REMINDER);
      expect(out.events()[0]).toMatchObject({ structured_output: VERDICT });
    });
  });

  it('gives the session id to a hook reading it before the first turn', async () => {
    const out = collector();
    const manager = sessionManagerStub();
    let current: string | null = null;
    vi.mocked(manager.setCurrentSession).mockImplementation(name => { current = name; });
    vi.mocked(manager.getCurrentSession).mockImplementation(() => current);
    replies = ['The answer.'];

    const headless = await session(
      { once: 'question', outputFormat: 'stream-json', sessionId: 'run-hook' },
      { stdout: out.stream, sessionManager: manager },
    );
    // The hook runner reads the id through the session manager, the way the
    // SessionStart block does before the session ever runs.
    const idAtHookTime = manager.getCurrentSession();
    await headless.run();

    expect(idAtHookTime).toBe('run-hook');
    expect(new Set(out.events().map(event => event.session_id))).toEqual(new Set(['run-hook']));
  });

  it('does not carry a turn structured output onto the next turn', async () => {
    const out = collector();
    const stdin = new PassThrough();
    const headless = await session(
      { inputFormat: 'stream-json', outputFormat: 'stream-json' },
      { stdin, stdout: out.stream },
    );
    replies = [
      async () => {
        headless.setStructuredOutput({ verdict: 'first' });
        return { content: 'First.', tool_calls: [], interrupted: false };
      },
      'Second.',
    ];

    const run = headless.run();
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'one' } })}\n`);
    await vi.waitFor(() => expect(out.events().filter(e => e.type === 'result')).toHaveLength(1));
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'two' } })}\n`);
    await vi.waitFor(() => expect(out.events().filter(e => e.type === 'result')).toHaveLength(2));
    stdin.end();
    await run;

    const results = out.events().filter(
      (event): event is Extract<WireEvent, { type: 'result' }> => event.type === 'result');
    expect(results[0]).toMatchObject({ structured_output: { verdict: 'first' } });
    expect(results[1]).not.toHaveProperty('structured_output');
  });

  it('keeps stdout free of everything but wire events', async () => {
    const out = collector();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    replies = ['The answer.'];

    await (await session({ once: 'question', outputFormat: 'stream-json' }, { stdout: out.stream })).run();

    expect(stdout).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(out.events().length).toBeGreaterThan(1);
  });
});
