import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createDurableDirectory, syncDirectory } from '../durableDirectory.js';

describe('durable directory barriers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('syncs new descendants and the directory containing the first new entry', async () => {
    const root = path.resolve('durability-test');
    vi.spyOn(fs, 'mkdir').mockResolvedValue(path.join(root, 'new'));
    const handle = { sync: vi.fn(), close: vi.fn() };
    const open = vi.spyOn(fs, 'open').mockResolvedValue(handle as any);
    await createDurableDirectory(path.join(root, 'new', 'child'));
    expect(open.mock.calls.map(([directory]) => directory)).toEqual([path.join(root, 'new', 'child'), path.join(root, 'new'), root]);
    expect(handle.sync).toHaveBeenCalledTimes(3);
    expect(handle.close).toHaveBeenCalledTimes(3);
  });

  it('propagates unsupported or failed sync and still closes the handle', async () => {
    const failure = Object.assign(new Error('directory sync unavailable'), { code: 'EINVAL' });
    const handle = { sync: vi.fn().mockRejectedValue(failure), close: vi.fn() };
    vi.spyOn(fs, 'open').mockResolvedValue(handle as any);
    await expect(syncDirectory(path.resolve('durability-test'))).rejects.toBe(failure);
    expect(handle.close).toHaveBeenCalledOnce();
  });
});
