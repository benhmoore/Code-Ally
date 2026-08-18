import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExitCommand } from '../commands/ExitCommand.js';
import type { ServiceRegistry } from '../../services/ServiceRegistry.js';

describe('ExitCommand', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shuts down registered services before exiting', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process exited');
    }) as never);
    const registry = { shutdown } as unknown as ServiceRegistry;

    await expect(new ExitCommand().execute([], [], registry)).rejects.toThrow('process exited');

    expect(shutdown).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
