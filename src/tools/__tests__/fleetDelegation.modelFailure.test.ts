import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent/Agent.js';
import { OllamaClient } from '../../llm/OllamaClient.js';
import { ToolManager } from '../ToolManager.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { BackgroundAgentManager } from '../../services/BackgroundAgentManager.js';
import { ActivityEventType } from '../../types/index.js';
import { runFleetDelegation } from '../fleetDelegation.js';

const agents: Agent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.cleanup()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture(stream = false) {
  const activityStream = new ActivityStream('child-call');
  const client = new OllamaClient({ endpoint: 'http://fixture.invalid', modelName: 'fixture', contextSize: 8192, maxTokens: 1000, activityStream });
  const subAgent = new Agent(client, new ToolManager([]), activityStream, {
    config: { ...DEFAULT_CONFIG, model: 'fixture', stream_responses: stream, context_size: 8192 },
    isSpecializedAgent: true, agentType: 'task',
  });
  agents.push(subAgent);
  const manager = new BackgroundAgentManager();
  const parentStream = new ActivityStream();
  const parentEvents: any[] = [];
  parentStream.subscribe('*', event => parentEvents.push(event));
  const published = vi.fn();
  const launch = async (prompt = 'Perform fixture task') => {
    const result = await runFleetDelegation({ manager, activityStream: parentStream,
      subAgent, parentAgent: { getInstanceId: () => 'main' } as Agent,
      messaging: { register: () => 1, publishCompletion: published } as any,
      agentType: 'task', taskPrompt: prompt, callId: 'child-call', pooledAgent: null,
      run: () => subAgent.sendMessage(prompt, { parentCallId: 'child-call' }), cleanup: () => {},
    });
    const task = manager.getTask(result.taskId)!;
    await task.promise;
    return task;
  };
  return { subAgent, manager, parentEvents, published, launch };
}
const successfulResponse = () => new Response(JSON.stringify({ message: { role: 'assistant', content: 'Verified fixture work.' }, done: true }), { status: 200 });

describe('typed model outcome reaches the fleet', () => {
  it('records a nonretryable HTTP 400 in the child transcript and publishes an error outcome', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Fixture child request rejected' }), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const { subAgent, parentEvents, published, launch } = fixture();
    const task = await launch();
    expect(fetch).toHaveBeenCalledOnce();
    expect(subAgent.getTurnSnapshot()).toMatchObject({ state: 'failed', terminationReason: 'failed' });
    expect(task.status).toBe('error');
    expect(task.error).toContain('400');
    expect(task.error).toContain('Fixture child request rejected');
    const audit = task.completedView?.messages.find(message => message.metadata?.isError);
    expect(audit?.content).toBe(task.error);
    expect(subAgent.getMessages().some(message => message.id === audit?.id)).toBe(true);
    expect(published).toHaveBeenCalledWith(task, expect.anything());
    expect(parentEvents.find(event => event.type === ActivityEventType.AGENT_BACKGROUND_COMPLETE)?.data)
      .toMatchObject({ status: 'error', error: task.error });
    expect(parentEvents.find(event => event.type === ActivityEventType.AGENT_END)?.data)
      .toMatchObject({ status: 'error', error: task.error, interrupted: false });

    // A later successful turn on the same agent clears the typed failure.
    fetch.mockResolvedValueOnce(successfulResponse());
    const recovered = await launch('Try a different task');
    expect(recovered.status).toBe('done');
    expect(recovered.error).toBeFalsy();
    expect(subAgent.getTurnSnapshot()).toMatchObject({ state: 'completed', error: undefined });
  });

  it.each([false, true])('retains partial work and reports bounded stream recovery (second failure: %s)', async failsAgain => {
    const brokenStream = () => {
      let delivered = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (!delivered) {
            delivered = true;
            controller.enqueue(new TextEncoder().encode(JSON.stringify({
              message: { role: 'assistant', content: 'Partial fixture evidence.' }, done: false,
            }) + '\n'));
          } else controller.error(new TypeError('fixture connection terminated'));
        },
      }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
    const fetch = vi.fn().mockResolvedValueOnce(brokenStream()).mockResolvedValueOnce(failsAgain
      ? brokenStream() : new Response(JSON.stringify({ message: { role: 'assistant', content: 'Recovered and verified.' }, done: true }) + '\n'));
    vi.stubGlobal('fetch', fetch);
    const { subAgent, launch } = fixture(true);
    const task = await launch();
    expect(fetch).toHaveBeenCalledTimes(2);
    const partials = task.completedView?.messages.filter(message => message.metadata?.partial);
    expect(partials).toHaveLength(failsAgain ? 2 : 1);
    expect(partials?.[0]?.content).toBe('Partial fixture evidence.');
    if (failsAgain) {
      expect(task.status).toBe('error');
      expect(task.error).toContain('Model stream failed after one recovery attempt');
      expect(task.error).toContain('fixture connection terminated');
      expect(subAgent.getTurnSnapshot().state).toBe('failed');
      expect(task.completedView?.messages.find(message => message.metadata?.isError)?.content).toBe(task.error);
    } else {
      expect(task.status).toBe('done');
      expect(task.error).toBeFalsy();
      expect(subAgent.getTurnSnapshot().state).toBe('completed');
      expect(task.completedView?.messages.some(message => message.metadata?.isError)).toBe(false);
      expect(task.completedView?.messages.at(-1)?.content).toBe('Recovered and verified.');
    }
  });

  it('keeps a retryable HTTP 503 followed by success as a successful task', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Temporary fixture outage' }), { status: 503 }))
      .mockResolvedValueOnce(successfulResponse());
    vi.stubGlobal('fetch', fetch);
    const { launch, subAgent } = fixture();
    const settled = launch();
    await vi.advanceTimersByTimeAsync(10000);
    const task = await settled;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(task.status).toBe('done');
    expect(task.error).toBeFalsy();
    expect(subAgent.getTurnSnapshot()).toMatchObject({ state: 'completed', error: undefined });
    expect(task.completedView?.messages.some(message => message.metadata?.isError)).toBe(false);
  });

  it('keeps user cancellation distinct from provider failure', async () => {
    const { subAgent, launch } = fixture();
    const fetch = vi.fn(async () => {
      subAgent.interrupt({ kind: 'user_cancel' });
      throw new DOMException('Aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetch);
    const task = await launch();
    expect(task.status).toBe('cancelled');
    expect(task.error).toBeFalsy();
    expect(task.completedView?.messages.some(message => message.metadata?.isError)).toBe(false);
  });

  it('does not turn ordinary assistant text about errors into a failed outcome', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: { role: 'assistant', content: 'HTTP 400 was the historical cause. I fixed it and verified success.' }, done: true,
    }), { status: 200 })));
    const { launch } = fixture();
    const task = await launch();
    expect(task.status).toBe('done');
    expect(task.error).toBeFalsy();
  });
});
