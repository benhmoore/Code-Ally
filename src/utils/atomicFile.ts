import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Publish a complete same-directory temporary file, optionally refusing replacement. */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: { mode?: number; overwrite?: boolean } = {}
): Promise<void> {
  const existingMode = options.mode ?? await fs.stat(filePath).then((stat) => stat.mode).catch(() => 0o600);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', existingMode);
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.overwrite === false) {
      // Linking publishes the complete inode atomically and fails if the target
      // already exists. A check followed by rename would permit a racing overwrite.
      await fs.link(tempPath, filePath);
      await fs.unlink(tempPath);
    } else {
      await fs.rename(tempPath, filePath);
    }
    // Persist the directory entry as well as the file contents where supported.
    const directory = await fs.open(path.dirname(filePath), 'r').catch(() => undefined);
    if (directory) {
      await directory.sync().catch(() => undefined);
      await directory.close().catch(() => undefined);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
