import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent/Agent.js';
import { AgentMessagingService } from '../AgentMessagingService.js';
import { BackgroundAgentManager } from '../BackgroundAgentManager.js';
import { ActivityStream } from '../ActivityStream.js';
import { ConversationInputQueue } from '../ConversationInputQueue.js';
import { ConversationViewStore } from '../ConversationViewStore.js';
import { SessionRuntime } from '../SessionRuntime.js';
import { runFleetDelegation } from '../../tools/fleetDelegation.js';
import type { AgentPoolService } from '../AgentPoolService.js';

const resources: Array<() => void> = [];
afterEach(() => { resources.splice(0).forEach(close => close()); });
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
async function tick() { await new Promise<void>(resolve => setImmediate(resolve)); }
function actor(id: string) {
  let busy = false;
  const messages: Array<{ text: string; context: any }> = [];
  const interjections: Array<{ text: string; source: unknown }> = [];
  const queue = new ConversationInputQueue(() => busy);
  const view = new ConversationViewStore(new ActivityStream(), () => [], () => []);
  resources.push(() => { queue.close(); view.close(); });
  let operation: (() => Promise<void>) | undefined;
  let steering = false;
  let concurrent = 0;
  let maxConcurrent = 0;
  const value = {
    getInstanceId: () => id, getInputQueue: () => queue, getConversationView: () => view,
    canAcceptSteering: () => busy && steering,
    addUserInterjection: vi.fn((text: string, source: unknown) => interjections.push({ text, source })),
    interrupt: vi.fn(),
    sendMessage: vi.fn(async (text: string, context: any = {}) => {
      if (busy) throw new Error('Concurrent agent turn');
      busy = true;
      maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      messages.push({ text, context });
      context.onMessageAdmitted?.();
      try { await operation?.(); return `reply from ${id}`; }
      finally { busy = false; concurrent--; queue.drain(); }
    }),
    getSession: () => runtime,
    receiveAgentMessage: (text: string, source: any) => Agent.prototype.receiveAgentMessage.call(value as unknown as Agent, text, source),
  };
  const runtime = new SessionRuntime({ view, input: queue, isProcessing: () => busy, steer: () => false,
    execute: text => value.sendMessage(text), cancel: () => queue.cancel(), resume: () => {}, close: async () => queue.close() });
  return { agent: value as unknown as Agent, messages, interjections, queue,
    setOperation: (next?: () => Promise<void>) => { operation = next; },
    allowSteering: () => { steering = true; }, maxConcurrent: () => maxConcurrent };
}
function fixture() {
  const main = actor('main-instance');
  const child = actor('child-instance');
  const manager = new BackgroundAgentManager();
  const metadata = new Map<string, any>([['child', { agent: child.agent, contextGeneration: 0, inUse: false }]]);
  const reserveById = vi.fn((id: string) => {
    const entry = metadata.get(id);
    if (!entry) throw new Error('Agent not found');
    if (entry.inUse) throw new Error('Agent is busy');
    entry.inUse = true;
    return { agent: entry.agent, agentId: id, release: () => { entry.inUse = false; } };
  });
  const pool = { getAgentMetadata: (id: string) => metadata.get(id), reserveById,
    retainConversation: vi.fn((id: string) => { metadata.get(id).retainConversation = true; }) } as unknown as AgentPoolService;
  const stream = new ActivityStream();
  const service = new AgentMessagingService(() => main.agent, () => pool, manager, stream);
  service.register(child.agent, 'child', main.agent, true);
  const launch = async (options: { cleanup?: () => Promise<void>; publish?: boolean } = {}) => {
    const lease = pool.reserveById('child');
    return runFleetDelegation({ manager, activityStream: stream, agentType: 'task', taskPrompt: 'initial',
      callId: 'initial', subAgent: child.agent, pooledAgent: lease, parentAgent: main.agent,
      agentId: 'child', messaging: service, publishCompletion: options.publish ?? false,
      run: () => child.agent.sendMessage('initial'), cleanup: async () => { await options.cleanup?.(); lease.release(); } });
  };
  return { main, child, manager, metadata, pool, reserveById, service, launch };
}

describe('agent message ownership', () => {
  it('sends both directions through one channel without human provenance or reply loops', async () => {
    const f = fixture();
    const receipt = await f.service.send(f.main.agent, 'child', 'inspect this');
    expect(receipt.status).toBe('queued');
    expect(receipt.task_id).toBeTruthy();
    await f.manager.getTask(receipt.task_id!)!.promise;
    expect(f.child.messages[0]!.context.agentMessage.sender).toBe('main');
    const response = await f.service.send(f.child.agent, 'parent', 'the finding');
    await f.main.queue.whenIdle();
    expect(response.recipient_id).toBe('main');
    expect(f.main.messages[0]!.context.agentMessage.sender).toBe('child');
    expect(f.main.messages).toHaveLength(1);
    expect(f.child.messages).toHaveLength(1);
    expect(f.service.getDelivery(response.message_id)?.status).toBe('delivered');
    await f.service.cleanup();
  });

  it('steers an active recipient with agent provenance and no concurrent turn', async () => {
    const f = fixture();
    const running = deferred();
    f.child.setOperation(() => running.promise);
    f.child.allowSteering();
    const task = await f.launch();
    await tick();
    const receipt = await f.service.send(f.main.agent, 'child', 'new finding');
    expect(receipt.status).toBe('delivered');
    expect(f.child.interjections[0]!.source).toMatchObject({ messageId: receipt.message_id, sender: 'main' });
    expect(f.child.messages).toHaveLength(1);
    running.resolve();
    await f.manager.getTask(task.taskId)!.promise;
    expect(f.child.maxConcurrent()).toBe(1);
    await f.service.cleanup();
  });

  it('queues finalization-boundary messages and retains the pool lease through all admitted turns', async () => {
    const f = fixture();
    const first = deferred();
    f.child.setOperation(() => first.promise);
    const task = await f.launch();
    await tick();
    const receipt = await f.service.send(f.main.agent, 'child', 'follow up');
    expect(receipt.status).toBe('queued');
    expect(f.metadata.get('child').inUse).toBe(true);
    first.resolve();
    await f.manager.getTask(task.taskId)!.promise;
    expect(f.child.messages).toHaveLength(2);
    expect(f.child.maxConcurrent()).toBe(1);
    expect(f.metadata.get('child').inUse).toBe(false);
    expect(f.service.getDelivery(receipt.message_id)?.status).toBe('delivered');
    await f.service.cleanup();
  });

  it('waits for a settling owner before starting a new pooled message task', async () => {
    const f = fixture();
    const cleanup = deferred();
    const entered = deferred();
    const task = await f.launch({ cleanup: async () => { entered.resolve(); await cleanup.promise; } });
    await entered.promise;
    expect(f.manager.getTask(task.taskId)?.acceptingMessages).toBe(false);
    const receipt = await f.service.send(f.main.agent, 'child', 'later');
    expect(receipt.status).toBe('queued');
    expect(f.child.messages).toHaveLength(1);
    cleanup.resolve();
    await f.manager.getTask(task.taskId)!.promise;
    await tick();
    await Promise.all(f.manager.listTasks().map(item => item.promise));
    expect(f.child.messages).toHaveLength(2);
    expect(f.child.maxConcurrent()).toBe(1);
    await f.service.cleanup();
  });

  it('rejects missing/self/stale-generation recipients instead of crossing conversations', async () => {
    const f = fixture();
    await expect(f.service.send(f.main.agent, 'missing', 'hello')).rejects.toThrow('Agent not found');
    await expect(f.service.send(f.main.agent, 'main', 'hello')).rejects.toThrow('self-messaging');
    const task = await f.launch();
    await f.manager.getTask(task.taskId)!.promise;
    f.metadata.get('child').contextGeneration++;
    f.service.register(f.child.agent, 'child', f.main.agent, true);
    await expect(f.service.send(f.main.agent, task.taskId, 'old context')).rejects.toThrow('Agent not found');
    f.metadata.delete('child');
    await expect(f.service.send(f.main.agent, 'child', 'expired')).rejects.toThrow('Agent not found');
    await f.service.cleanup();
  });

  it('cancels a queued initial message before execution and acknowledges it as cancelled', async () => {
    const f = fixture();
    const receipt = await f.service.send(f.main.agent, 'child', 'never execute');
    f.manager.cancelTask(receipt.task_id!);
    await f.manager.getTask(receipt.task_id!)!.promise;
    await tick();
    expect(f.child.messages).toHaveLength(0);
    expect(f.manager.getTask(receipt.task_id!)!.status).toBe('cancelled');
    expect(f.service.getDelivery(receipt.message_id)?.status).toBe('cancelled');
    await f.service.cleanup();
  });

  it('delivers headless completion once at canonical admission without an acknowledgement loop', async () => {
    const f = fixture();
    const task = await f.launch({ publish: true });
    await f.manager.getTask(task.taskId)!.promise;
    await f.main.queue.whenIdle();
    expect(f.main.messages).toHaveLength(1);
    expect(f.main.messages[0]!.text).toContain(`${task.taskId} done`);
    expect(f.main.messages[0]!.context.agentMessage.sender).toBe('child');
    expect(f.manager.getTask(task.taskId)!.consumed).toBe(true);
    expect(f.manager.drainCompletedResults()).toHaveLength(0);
    expect(f.child.messages).toHaveLength(1);
    await f.service.cleanup();
  });

  it('retains a cancelled completion until a later successful canonical admission', async () => {
    const f = fixture();
    const release = f.main.queue.holdWhileIdle();
    const started = await f.launch({ publish: true });
    const task = f.manager.getTask(started.taskId)!;
    await task.promise;
    expect(task.deliveryPending).toBe(true);
    expect(task.consumed).toBe(false);
    f.main.queue.cancel();
    await tick();
    expect(task.deliveryPending).toBe(false);
    expect(task.consumed).toBe(false);
    release();
    f.service.publishCompletion(task, f.main.agent);
    await f.main.queue.whenIdle();
    expect(task.consumed).toBe(true);
    expect(f.main.messages).toHaveLength(1);
    await f.service.cleanup();
  });

  it('wakes the correct idle pooled parent for nested completion without leaking it to main', async () => {
    const f = fixture();
    const initial = await f.launch();
    await f.manager.getTask(initial.taskId)!.promise;
    const nested = actor('grandchild-instance');
    const task = f.manager.createTask({ agentType: 'nested', taskPrompt: 'nested work', callId: 'nested', subAgent: nested.agent, pooledAgent: null });
    task.ownerId = f.child.agent.getInstanceId();
    task.status = 'done';
    task.result = 'nested finding';
    f.manager.addTask(task);
    f.service.register(nested.agent, task.id, f.child.agent);
    f.service.publishCompletion(task, f.child.agent);
    await tick();
    await Promise.all(f.manager.listTasks().map(item => item.promise));
    expect(f.child.messages[1]!.text).toContain('nested finding');
    expect(f.main.messages).toHaveLength(0);
    expect(nested.messages).toHaveLength(0);
    expect(task.consumed).toBe(true);
    await f.service.cleanup();
  });

  it('reports asynchronous execution failure and releases the persistent recipient lease', async () => {
    const f = fixture();
    f.child.setOperation(async () => { throw new Error('model unavailable'); });
    const receipt = await f.service.send(f.main.agent, 'child', 'work');
    await f.manager.getTask(receipt.task_id!)!.promise;
    await tick();
    expect(f.service.getDelivery(receipt.message_id)).toMatchObject({ status: 'failed', error: 'model unavailable' });
    expect(f.metadata.get('child').inUse).toBe(false);
    await f.service.cleanup();
  });

  it('closes admission immediately while draining accepted recipient work', async () => {
    const f = fixture();
    const gate = deferred();
    f.main.setOperation(() => gate.promise);
    await f.service.send(f.child.agent, 'main', 'pending work');
    await tick();
    let closed = false;
    const closing = f.service.cleanup().then(() => { closed = true; });
    await expect(f.service.send(f.child.agent, 'main', 'too late')).rejects.toThrow('closing');
    await tick();
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    expect(closed).toBe(true);
  });
});
