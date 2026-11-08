import type { Agent, AgentMessageSource } from '../agent/Agent.js';
import type { AgentPoolService } from './AgentPoolService.js';
import type { BackgroundAgentManager, BackgroundAgentTask } from './BackgroundAgentManager.js';
import type { ActivityStream } from './ActivityStream.js';
import { runFleetDelegation } from '../tools/fleetDelegation.js';
import { logger } from './Logger.js';
import { randomUUID } from 'node:crypto';

export interface AgentMessageReceipt {
  message_id: string;
  recipient_id: string;
  status: 'delivered' | 'queued';
  task_id?: string;
}
export interface AgentMessageDelivery {
  receipt: AgentMessageReceipt;
  status: 'queued' | 'delivered' | 'cancelled' | 'failed';
  error?: string;
}
interface Route { agent: Agent; address: string; parent?: Agent; pooled: boolean; generation?: number; }

/** One nonblocking channel; recipient session queues own turns and fleet tasks own pool leases. */
export class AgentMessagingService {
  private readonly routes = new Map<string, Route>();
  private readonly addresses = new WeakMap<Agent, string>();
  private readonly deliveries = new Map<string, AgentMessageDelivery>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly root: () => Agent | null | undefined,
    private readonly pool: () => AgentPoolService | null | undefined,
    private readonly manager: BackgroundAgentManager,
    private readonly activityStream: ActivityStream,
  ) {}

  register(agent: Agent, address: string, parent?: Agent, pooled = false): number | undefined {
    if (this.closed) throw new Error('Agent messaging is closing');
    this.pruneRoutes();
    const metadata = pooled ? this.pool()?.getAgentMetadata(address) : undefined;
    const generation = metadata?.contextGeneration;
    const existing = this.routes.get(address);
    if (pooled) this.pool()?.retainConversation(address);
    this.routes.set(address, { agent, address, parent: existing?.agent === agent && existing.generation === generation ? existing.parent : parent, pooled, generation });
    this.addresses.set(agent, address);
    return generation;
  }

  addressOf(agent: Agent): string {
    if (agent === this.root()) return 'main';
    return this.addresses.get(agent) ?? agent.getInstanceId();
  }

  getDelivery(messageId: string): Readonly<AgentMessageDelivery> | undefined { return this.deliveries.get(messageId); }

  send(sender: Agent, recipient: string, message: string): Promise<AgentMessageReceipt> {
    if (this.closed) return Promise.reject(new Error('Agent messaging is closing'));
    const operation = this.sendOwned(sender, recipient, message);
    this.track(operation);
    return operation;
  }

  private async sendOwned(sender: Agent, recipient: string, message: string): Promise<AgentMessageReceipt> {
    this.pruneRoutes();
    this.pruneDeliveries();
    if (this.deliveries.size >= 256) throw new Error('Agent message queue is full. Wait for pending messages before sending more.');
    if (!message.trim() || message.length > 100_000) throw new Error('Message must contain 1–100000 characters.');
    const target = this.resolve(sender, recipient);
    if (!target) throw new Error(`Agent not found: ${recipient}. Use main, parent, a task ID, or a returned agent_id.`);
    if (target.agent === sender) throw new Error('Choose another agent; self-messaging is not supported.');
    const messageId = randomUUID();
    const source = { messageId, sender: this.addressOf(sender) };
    const text = `[Agent ${source.sender}]\n${message}`;
    const receipt: AgentMessageReceipt = { message_id: messageId, recipient_id: target.address, status: 'queued' };
    const delivery: AgentMessageDelivery = { receipt, status: 'queued' };
    this.deliveries.set(messageId, delivery);
    this.pruneDeliveries();
    const running = this.manager.listTasks().find(task => task.subAgent === target.agent && task.status === 'running');
    if (running && !running.acceptingMessages) {
      this.observe(running.promise.then(() => this.deliver(sender, target, text, source, delivery)), delivery);
      return receipt;
    }
    try { await this.deliver(sender, target, text, source, delivery); }
    catch (error) { this.fail(delivery, error); throw error; }
    return receipt;
  }

  private async deliver(sender: Agent, target: Route, text: string, source: AgentMessageSource, delivery: AgentMessageDelivery): Promise<void> {
    const running = this.manager.listTasks().find(task => task.subAgent === target.agent && task.status === 'running');
    if (target.pooled && !running) {
      const lease = this.pool()?.reserveById(target.address);
      if (!lease || lease.agent !== target.agent) throw new Error('This persistent agent is no longer available.');
      const outcome = await runFleetDelegation({
        manager: this.manager, activityStream: this.activityStream, agentType: 'message', taskPrompt: text,
        callId: source.messageId, subAgent: target.agent, pooledAgent: lease, agentId: target.address,
        parentAgent: sender, messaging: this, publishCompletion: false,
        run: () => target.agent.sendMessage(text, { agentMessage: source }), cleanup: () => lease.release(),
      });
      delivery.receipt.task_id = outcome.taskId;
      const task = this.manager.getTask(outcome.taskId)!;
      this.observe(task.promise.then(() => {
        delivery.status = task.status === 'cancelled' ? 'cancelled' : task.status === 'error' ? 'failed' : 'delivered';
        if (task.error) delivery.error = task.error;
      }), delivery);
      return;
    }
    const admission = target.agent.receiveAgentMessage(text, source);
    delivery.receipt.status = admission.kind;
    if (admission.kind === 'delivered') delivery.status = 'delivered';
    this.observe(admission.admitted.then(accepted => { delivery.status = accepted ? 'delivered' : 'cancelled'; }), delivery);
    this.observe(admission.completion, delivery);
  }

  /** Completion is business evidence, not an acknowledgement that asks for another reply. */
  publishCompletion(task: BackgroundAgentTask, owner: Agent): void {
    if (task.consumed || task.deliveryPending || this.closed) return;
    task.deliveryPending = true;
    const sender = this.addressOf(task.subAgent);
    const source = { messageId: `result:${task.id}`, sender };
    const text = `[Agent ${sender}; ${task.id} ${task.status}]\n${task.error ?? task.result ?? '(no output)'}`;
    let retryAfterSettlement = false;
    const operation = (async () => {
      const route = this.resolve(task.subAgent, this.addressOf(owner));
      if (!route) throw new Error('The task owner is no longer available.');
      const live = this.manager.listTasks().find(candidate => candidate.subAgent === owner && candidate.status === 'running');
      if (live && !live.acceptingMessages) {
        await live.promise;
        retryAfterSettlement = true;
        return;
      }
      if (route.pooled && !live) {
        // An idle persistent owner needs its own lease/turn. The result is acknowledged
        // at canonical message admission, before that turn evaluates completion gates.
        const lease = this.pool()?.reserveById(route.address);
        if (!lease) throw new Error('The task owner is no longer available.');
        let acknowledge!: (accepted: boolean) => void;
        const admitted = new Promise<boolean>(resolve => { acknowledge = resolve; });
        const outcome = await runFleetDelegation({ manager: this.manager, activityStream: this.activityStream,
          agentType: 'message', taskPrompt: text, callId: source.messageId, subAgent: owner,
          agentId: route.address, pooledAgent: lease, parentAgent: task.subAgent, messaging: this, publishCompletion: false,
          run: () => owner.sendMessage(text, { agentMessage: source, onMessageAdmitted: () => { task.consumed = true; acknowledge(true); } }),
          cleanup: () => lease.release(),
        });
        const responseTask = this.manager.getTask(outcome.taskId)!;
        void responseTask.promise.then(() => { responseTask.consumed = true; acknowledge(false); }, () => acknowledge(false));
        task.consumed = await admitted;
      } else {
        const admission = owner.receiveAgentMessage(text, source);
        task.consumed = await admission.admitted;
        await admission.completion;
      }
    })();
    this.track(operation.finally(() => {
      task.deliveryPending = false;
      if (retryAfterSettlement && !this.closed) this.publishCompletion(task, owner);
    }));
    void operation.catch(error => logger.error(`[AgentMessaging] Completion delivery ${task.id} failed:`, error));
  }

  private resolve(sender: Agent, requested: string): Route | undefined {
    const root = this.root();
    if (requested === 'main' && root) return { agent: root, address: 'main', pooled: false };
    if (requested === 'parent') {
      const parent = this.routes.get(this.addressOf(sender))?.parent;
      return parent ? this.resolve(sender, this.addressOf(parent)) : undefined;
    }
    const task = this.manager.getTask(requested);
    if (task) {
      const route = this.routes.get(this.addressOf(task.subAgent));
      return route && route.agent === task.subAgent && route.generation === task.contextGeneration ? route : undefined;
    }
    const route = this.routes.get(requested);
    if (route?.pooled && (this.pool()?.getAgentMetadata(requested)?.agent !== route.agent || this.pool()?.getAgentMetadata(requested)?.contextGeneration !== route.generation)) {
      this.routes.delete(requested);
      return undefined;
    }
    return route;
  }

  private observe(operation: Promise<unknown>, delivery: AgentMessageDelivery): void {
    this.track(operation.catch(error => this.fail(delivery, error)));
  }
  private fail(delivery: AgentMessageDelivery, error: unknown): void {
    delivery.status = 'failed';
    delivery.error = error instanceof Error ? error.message : String(error);
    logger.error(`[AgentMessaging] Delivery ${delivery.receipt.message_id} failed: ${delivery.error}`);
  }
  stopAdmission(): void { this.closed = true; }

  /** Stop admission, then drain recipient-owned deliveries before releasing route references. */
  cleanup(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      this.routes.clear();
      this.deliveries.clear();
    })();
    return this.closing;
  }

  private track(operation: Promise<unknown>): void {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
  }
  private pruneRoutes(): void {
    for (const [address, route] of this.routes) {
      if (route.pooled ? this.pool()?.getAgentMetadata(address)?.agent !== route.agent || this.pool()?.getAgentMetadata(address)?.contextGeneration !== route.generation : !this.manager.getTask(address)) {
        this.routes.delete(address);
      }
    }
  }
  private pruneDeliveries(): void {
    for (const [id, delivery] of this.deliveries) {
      if (this.deliveries.size < 256) break;
      if (delivery.status !== 'queued') this.deliveries.delete(id);
    }
  }
}
