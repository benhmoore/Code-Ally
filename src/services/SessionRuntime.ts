import type { Message } from '../types/index.js';
import type { ConversationCheckpointV1, ProviderCheckpointState } from '../agent/compaction/types.js';
import type { ConversationViewStore, ConversationViewSnapshot } from './ConversationViewStore.js';
import type { ConversationInputQueue, PendingConversationInput } from './ConversationInputQueue.js';

export interface SessionResumeState {
  messages: Message[];
  transcript?: Message[];
  checkpoint?: ConversationCheckpointV1 | null;
  providerState?: ProviderCheckpointState;
  canonicalMessages?: Message[];
}
export interface SessionSnapshot extends ConversationViewSnapshot {
  pendingInputs: readonly PendingConversationInput[];
}
export type SubmissionResult<T> = { kind: 'steered' } | { kind: 'completed'; value: T } | { kind: 'not_sent' };
export interface SessionRuntimeDependencies {
  view: ConversationViewStore;
  input: ConversationInputQueue;
  isProcessing: () => boolean;
  steer: (text: string) => boolean;
  execute: (text: string, images?: string[]) => Promise<string>;
  cancel: () => void;
  resume: (state: SessionResumeState) => void;
  close: () => Promise<void>;
}

/** Frontend-neutral admission, observation and lifecycle for one conversation. */
export class SessionRuntime {
  private snapshot: SessionSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: Array<() => void>;
  private closed = false;
  private disposed = false;
  private viewVersion?: ConversationViewSnapshot;
  private inputVersion?: readonly PendingConversationInput[];
  private closePromise?: Promise<void>;

  constructor(private readonly deps: SessionRuntimeDependencies) {
    this.snapshot = this.readSnapshot();
    this.unsubscribes = [deps.view.subscribe(this.refresh), deps.input.subscribe(this.refresh)];
  }

  private readSnapshot(): SessionSnapshot {
    this.viewVersion = this.deps.view.getSnapshot();
    this.inputVersion = this.deps.input.getSnapshot();
    return { ...this.viewVersion, pendingInputs: this.inputVersion };
  }
  private refresh = (): void => {
    if (this.disposed) return;
    this.snapshot = this.readSnapshot();
    this.listeners.forEach(listener => listener());
  };
  getSnapshot = (): SessionSnapshot => {
    if (!this.disposed && (this.viewVersion !== this.deps.view.getSnapshot()
      || this.inputVersion !== this.deps.input.getSnapshot())) this.snapshot = this.readSnapshot();
    return this.snapshot;
  };
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  addDisplayMessage = (message: Message): void => { if (!this.closed) this.deps.view.addDisplayMessage(message); };

  /** A frontend may include preparation and result publication in the owned turn. */
  async submit<T = string>(text: string, options: {
    mode?: 'auto' | 'follow_up';
    images?: string[];
    execute?: (text: string, signal: AbortSignal) => Promise<T>;
  } = {}): Promise<SubmissionResult<T>> {
    if (this.closed) throw new Error('Session is closed');
    if (!text.trim()) return { kind: 'not_sent' };
    if (options.mode !== 'follow_up' && this.deps.steer(text)) return { kind: 'steered' };
    let result: SubmissionResult<T> = { kind: 'not_sent' };
    await this.deps.input.enqueue(text, async (input, signal) => {
      if (signal.aborted) return;
      const value = options.execute
        ? await options.execute(input, signal)
        : await this.deps.execute(input, options.images) as T;
      result = { kind: 'completed', value };
    });
    return result;
  }

  cancel(): void {
    if (this.closed) return;
    this.deps.input.cancel();
    if (this.deps.isProcessing()) this.deps.cancel();
  }
  editPending(id: string, text: string): boolean { return this.deps.input.edit(id, text); }
  removePending(id: string): PendingConversationInput | undefined { return this.deps.input.remove(id); }
  whenIdle(): Promise<void> { return this.deps.input.whenIdle(); }

  resume(state: SessionResumeState): void {
    if (this.closed) throw new Error('Session is closed');
    if (this.deps.isProcessing() || this.deps.input.isExecuting() || this.deps.input.getSnapshot().length) {
      throw new Error('Wait for active and queued work to finish before resuming another conversation');
    }
    this.deps.resume(structuredClone(state));
    this.refresh();
  }

  close(): Promise<void> {
    this.closed = true;
    this.closePromise ??= this.deps.close().finally(() => this.dispose());
    return this.closePromise;
  }

  /** Release frontend observers when the underlying owner is disposed or reused. */
  dispose(): void {
    this.getSnapshot();
    this.disposed = true;
    this.closed = true;
    this.unsubscribes.forEach(unsubscribe => unsubscribe());
    this.listeners.clear();
  }
}
