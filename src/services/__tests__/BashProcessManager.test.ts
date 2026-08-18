import { afterEach, describe, expect, it, vi } from 'vitest';
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
    process: { kill: vi.fn(), exitCode: null, signalCode: null } as any,
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
