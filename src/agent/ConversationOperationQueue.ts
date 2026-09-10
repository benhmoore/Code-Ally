/** Agent-owned mutations run only when the turn owner reaches a safe boundary. */
export class ConversationOperationQueue {
  private pending: Array<{ run: () => Promise<void>; reject: (error: Error) => void }> = [];
  private draining?: Promise<void>;
  private closed = false;

  get active(): boolean { return this.draining !== undefined; }
  get hasWork(): boolean { return this.active || this.pending.length > 0; }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Conversation operations are closed'));
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        reject,
        run: async () => {
          try { resolve(await operation()); }
          catch (error) { reject(error); }
        },
      });
    });
  }

  drain(): Promise<void> {
    if (this.draining) return this.draining;
    const draining = Promise.resolve().then(async () => {
      try {
        while (this.pending.length) await this.pending.shift()!.run();
      } finally {
        if (this.draining === draining) this.draining = undefined;
      }
    });
    this.draining = draining;
    return draining;
  }

  async close(): Promise<void> {
    this.closed = true;
    const error = new Error('Conversation operation cancelled during shutdown');
    for (const operation of this.pending.splice(0)) operation.reject(error);
    await this.draining;
  }
}
