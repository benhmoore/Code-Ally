import { generateMessageId } from '../utils/id.js';

export interface PendingConversationInput {
  readonly id: string;
  readonly text: string;
  readonly status?: 'not_sent';
}

interface PendingOperation {
  input: PendingConversationInput;
  execute: (text: string, signal: AbortSignal) => Promise<void>;
  settle: (error?: unknown) => void;
}

/** Serial admission at the owning conversation's completed-turn boundary. */
export class ConversationInputQueue {
  private pending: PendingOperation[] = [];
  private snapshot: readonly PendingConversationInput[] = [];
  private readonly listeners = new Set<() => void>();
  private active = false;
  private closed = false;
  private activeController?: AbortController;
  private activeOperation?: PendingOperation;
  private activeStarted = false;

  constructor(private readonly isBusy: () => boolean) {}

  isExecuting(): boolean { return this.active; }

  getSnapshot = (): readonly PendingConversationInput[] => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  enqueue(text: string, execute: (text: string, signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Conversation is closed'));
    if (!text.trim()) return Promise.resolve();
    const completion = new Promise<void>((resolve, reject) => {
      this.pending.push({
        input: { id: generateMessageId(), text }, execute,
        settle: error => error === undefined ? resolve() : reject(error),
      });
    });
    this.publish();
    this.drain();
    return completion;
  }

  edit(id: string, text: string): boolean {
    const operation = this.pending.find(item => item.input.id === id);
    if (!operation || !text.trim()) return false;
    operation.input = { id, text };
    this.publish();
    return true;
  }

  remove(id: string): PendingConversationInput | undefined {
    if (this.closed) {
      const input = this.snapshot.find(item => item.id === id);
      this.snapshot = this.snapshot.filter(item => item.id !== id);
      this.listeners.forEach(listener => listener());
      return input;
    }
    const index = this.pending.findIndex(item => item.input.id === id);
    if (index < 0) return undefined;
    const [operation] = this.pending.splice(index, 1);
    operation!.settle();
    this.publish();
    return operation!.input;
  }

  clear(): void {
    const discarded = this.pending.splice(0);
    discarded.forEach(operation => operation.settle());
    this.publish();
  }

  cancel(): void {
    this.activeController?.abort();
    this.clear();
  }

  /** Called after the entire turn has settled, including cleanup and persistence. */
  drain = (): void => {
    if (this.closed || this.active || this.isBusy()) return;
    const operation = this.pending.shift();
    if (!operation) return;
    this.active = true;
    this.publish();
    const controller = new AbortController();
    this.activeController = controller;
    this.activeOperation = operation;
    this.activeStarted = false;
    // Give the previous turn's caller a chance to finish publication and release.
    void new Promise<void>(resolve => setImmediate(resolve))
      .then(() => {
        if (controller.signal.aborted) return;
        this.activeStarted = true;
        return operation.execute(operation.input.text, controller.signal);
      })
      .then(() => operation.settle(), error => operation.settle(error))
      .finally(() => { this.active = false; this.activeController = undefined; this.activeOperation = undefined; this.drain(); });
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.activeController?.abort();
    const undelivered = this.pending.splice(0);
    if (this.activeOperation && !this.activeStarted) undelivered.unshift(this.activeOperation);
    this.snapshot = undelivered.map(operation => ({ ...operation.input, status: 'not_sent' }));
    undelivered.forEach(operation => operation.settle());
    this.listeners.forEach(listener => listener());
  }

  private publish(): void {
    this.snapshot = this.pending.map(operation => operation.input);
    this.listeners.forEach(listener => listener());
  }
}
