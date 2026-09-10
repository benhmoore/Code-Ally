import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tryLock } from 'fs-native-extensions';

/** An OS-owned exclusive lease, released by close or process death.
 * The lock file must never be removed or replaced: all contenders must lock
 * the same inode. Contention returns undefined; unsupported locking and I/O
 * errors propagate rather than falling back to unsafe stale-owner heuristics.
 */
export class FileOwnership {
  private constructor(private readonly handle: FileHandle) {}

  static async acquire(filePath: string): Promise<FileOwnership | undefined> {
    const handle = await fs.open(filePath, 'a+', 0o600);
    try {
      if (tryLock(handle.fd)) return new FileOwnership(handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
    await handle.close();
    return undefined;
  }

  async release(): Promise<void> {
    await this.handle.close();
  }
}
