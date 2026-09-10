import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { spawnBashCommand } from '../../utils/bashProcess.js';
import {
  BashProcessManager,
  CircularBuffer,
  type ProcessInfo,
} from '../BashProcessManager.js';

function processInfo(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    id: 'shell-test',
    pid: 12345,
    command: 'npm run dev',
    process: { pid: 12345, kill: vi.fn(), exitCode: null, signalCode: null } as any,
    outputBuffer: new CircularBuffer(),
    startTime: Date.now() - 1_000,
    status: 'running',
    exitCode: null,
    exitSignal: null,
    terminationSignal: null,
    blocksCompletion: false,
    exitTime: null,
    ...overrides,
  };
}

describe('BashProcessManager lifecycle', () => {
  it.skipIf(process.platform === 'win32')('awaits a real SIGTERM-resistant child during shutdown', async () => {
    const child = spawnBashCommand("trap '' TERM; printf ready; while :; do sleep 1; done", {
      detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const manager = new BashProcessManager();
    manager.addProcess(processInfo({ pid: child.pid!, process: child }));
    try {
      await once(child.stdout!, 'data');
      await manager.shutdown(30);
      expect(child.signalCode).toBe('SIGKILL');
      expect(manager.listProcesses()).toEqual([]);
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally { await manager.shutdown(30); }
  });

  it('keeps shutdown pending through escalation until close and rejects new admission', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true), exitCode: null, signalCode: null });
    const manager = new BashProcessManager();
    const info = processInfo({ process: child as any });
    manager.addProcess(info);
    const shutdown = manager.shutdown(100);
    expect(manager.shutdown(100)).toBe(shutdown);
    expect(() => manager.addProcess(processInfo({ id: 'late' }))).toThrow(/shutting down/);
    let settled = false;
    void shutdown.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
      expect(settled).toBe(false);
      expect(manager.getProcess(info.id)).toBe(info);
      child.emit('close', null, 'SIGKILL');
      await shutdown;
      expect(manager.listProcesses()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { child.emit('close', null); vi.useRealTimers(); }
  });

  it('retains tracking and surfaces errors after all children close', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    const manager = new BashProcessManager();
    const info = processInfo({ process: child as any });
    manager.addProcess(info);
    const shutdown = manager.shutdown();
    const rejected = expect(shutdown).rejects.toThrow('Background process shutdown failed');
    await Promise.resolve();
    child.emit('error', new Error('signal failed'));
    child.emit('close', null);
    await rejected;
    expect(manager.getProcess(info.id)).toBe(info);
  });

  it('retains an unconsumed completed dependency under capacity pressure', () => {
    const manager = new BashProcessManager(1);
    const required = processInfo({ id: 'required', status: 'exited', exitCode: 0, exitTime: Date.now(), blocksCompletion: true });
    manager.addProcess(required);
    expect(() => manager.addProcess(processInfo({ id: 'next' }))).toThrow(/pending dependency results/);
    expect(manager.getProcess('required')).toBe(required);
    manager.acknowledgeCompletedResults(['required']);
    manager.addProcess(processInfo({ id: 'next' }));
    expect(manager.getProcess('required')).toBeUndefined();
  });

  it('does not acknowledge a running process or pin ordinary completed history', () => {
    const manager = new BashProcessManager(1);
    const required = processInfo({ blocksCompletion: true });
    manager.addProcess(required);
    manager.acknowledgeCompletedResults([required.id]);
    required.status = 'exited';
    expect(() => manager.addProcess(processInfo({ id: 'next' }))).toThrow();
    required.blocksCompletion = false;
    manager.addProcess(processInfo({ id: 'next' }));
    expect(manager.getProcess(required.id)).toBeUndefined();
  });
  afterEach(() => vi.restoreAllMocks());

  it('participates in registry cleanup by shutting down managed processes', async () => {
    const manager = new BashProcessManager();
    const shutdown = vi.spyOn(manager, 'shutdown').mockResolvedValue();

    await manager.initialize();
    await manager.cleanup();

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('marks a signaled process as stopping immediately and stops advertising it as running', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const manager = new BashProcessManager();
    const info = processInfo();
    manager.addProcess(info);

    expect(manager.killProcess(info.id, 'SIGKILL')).toBe(true);
    expect(info.status).toBe('stopping');
    expect(info.terminationSignal).toBe('SIGKILL');
    expect(manager.getStatusReminders().some((line) => line.includes('[running]'))).toBe(false);
  });

  it('tells the model that ordinary long-running servers do not block completion', () => {
    const manager = new BashProcessManager();
    manager.addProcess(processInfo());

    expect(manager.getStatusReminders()).toEqual([
      expect.stringContaining('non-blocking and does not prevent objective completion'),
    ]);
  });

  it('treats a null exit code with an exit signal as exited, not running', () => {
    const manager = new BashProcessManager();
    manager.addProcess(processInfo({
      status: 'exited',
      exitCode: null,
      exitSignal: 'SIGKILL',
      terminationSignal: 'SIGKILL',
      exitTime: Date.now(),
    }));

    expect(manager.getStatusReminders()).toEqual([
      expect.stringContaining('[exited(SIGKILL)]'),
    ]);
  });

  it('settles tracking when the target already disappeared before signal delivery', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation(() => { throw missing; });
    const manager = new BashProcessManager();
    const info = processInfo();
    (info.process.kill as any).mockReturnValue(false);
    manager.addProcess(info);

    expect(manager.killProcess(info.id, 'SIGTERM')).toBe(true);
    expect(info.status).toBe('exited');
    expect(manager.getStatusReminders().some((line) => line.includes('[running]'))).toBe(false);
  });
});
