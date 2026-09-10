import { describe, expect, it, vi } from 'vitest';
import { shutdownApplication } from '../shutdownApplication.js';
import type { ServiceRegistry } from '../ServiceRegistry.js';

function fixture() {
  const calls: string[] = [];
  const operation = (name: string) => vi.fn(() => { calls.push(name); });
  const run = operation('run');
  const agent = operation('agent');
  const watchers = operation('watchers');
  const shells = operation('shells');
  const agents = operation('agents');
  const registryShutdown = operation('registry');
  const services = new Map<string, unknown>([
    ['run_supervisor', { interruptForShutdown: run }],
    ['agent', { stopAndDrain: agent }],
    ['background_task_registry', { shutdown: watchers }],
    ['bash_process_manager', { shutdown: shells }],
    ['background_agent_manager', { shutdown: agents }],
  ]);
  const registry = { get: (name: string) => services.get(name), shutdown: registryShutdown } as unknown as ServiceRegistry;
  return { registry, calls, operations: [run, agent, watchers, shells, agents, registryShutdown], watchers, shells, registryShutdown };
}

describe('application shutdown coordination', () => {
  it.each([0, 1, 2, 3, 4, 5])('continues every independent cleanup after step %i fails', async failing => {
    const { registry, operations, calls } = fixture();
    const cause = new Error('cleanup fault');
    operations[failing].mockImplementation(() => { throw cause; });
    const failures = await shutdownApplication(registry);
    expect(failures).toHaveLength(1);
    expect(failures[0].cause).toBe(cause);
    for (const operation of operations) expect(operation).toHaveBeenCalledOnce();
    if (failing !== 0 && failing !== 1) expect(calls.slice(0, 2)).toEqual(['run', 'agent']);
  });

  it('starts other owners while a watcher drains and retains registry until settlement', async () => {
    const { registry, watchers, shells, registryShutdown } = fixture();
    let finish!: () => void;
    watchers.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = shutdownApplication(registry);
    expect(shells).toHaveBeenCalledOnce();
    expect(registryShutdown).not.toHaveBeenCalled();
    finish();
    expect(await pending).toEqual([]);
    expect(registryShutdown).toHaveBeenCalledOnce();
  });
});
