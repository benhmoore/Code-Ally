import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Required durability barrier. Unsupported filesystems fail explicitly. */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Persist newly created directory entries, from the leaf through their parent. */
export async function createDurableDirectory(directory: string): Promise<void> {
  const target = path.resolve(directory);
  const firstCreated = await fs.mkdir(target, { recursive: true });
  const parent = path.dirname(firstCreated ?? target);
  let current = target;
  while (true) {
    await syncDirectory(current);
    if (current === parent) break;
    current = path.dirname(current);
  }
}
