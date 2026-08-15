import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Write a file through a same-directory temporary file and atomic rename. */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: { mode?: number } = {}
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
    await fs.rename(tempPath, filePath);
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
