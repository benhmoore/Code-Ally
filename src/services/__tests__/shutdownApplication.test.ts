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
  it('settles auxiliary writes before persistence cleanup and closes unowned model clients once', async () => {
    const { registry, registryShutdown } = fixture();
    let finish!: () => void;
    const auxiliary = { cleanup: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
    const owned = { close: vi.fn() };
    const unowned = { close: vi.fn().mockResolvedValue(undefined) };
    const original = registry.get.bind(registry);
    vi.spyOn(registry, 'get').mockImplementation(name => {
      if (name === 'idle_message_generator') return auxiliary as any;
      if (name === 'model_client' || name === 'service_model_client') return unowned as any;
      if (name === 'agent') return { stopAndDrain: vi.fn(), getModelClient: () => owned } as any;
      return original(name);
    });
    const pending = shutdownApplication(registry);
    expect(registryShutdown).not.toHaveBeenCalled();
    expect(unowned.close).not.toHaveBeenCalled();
    finish();
    expect(await pending).toEqual([]);
    expect(unowned.close).toHaveBeenCalledOnce();
    expect(owned.close).not.toHaveBeenCalled();
    expect(registryShutdown).toHaveBeenCalledOnce();
  });

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
