/** Serializes mutations to the same canonical file path within this process. */
export class FileMutationCoordinator {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(filePath);
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const queued = (async () => {
      await previous?.catch(() => undefined);
      try {
        resolveResult(await operation());
      } catch (error) {
        rejectResult(error);
        throw error;
      }
    })();
    const tail = queued.catch(() => undefined);
    this.queues.set(filePath, tail);

    try {
      return await result;
    } finally {
      if (this.queues.get(filePath) === tail) this.queues.delete(filePath);
    }
  }
}

export const fileMutationCoordinator = new FileMutationCoordinator();
