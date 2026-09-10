import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bashProcess from '../../utils/bashProcess.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { BashTool } from '../BashTool.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { BashProcessManager } from '../../services/BashProcessManager.js';

describe('foreground shell lifecycle', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('reaps a child rejected by background admission before reporting failure', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 12345, kill: vi.fn(() => true) }) as unknown as ChildProcess;
    vi.spyOn(bashProcess, 'spawnBashCommand').mockReturnValue(child);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const manager = new BashProcessManager(0);
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockReturnValue(manager);
    const tool = new BashTool(new ActivityStream());
    let settled = false;
    const waiting = tool['spawnBackground']('echo example', process.cwd(), false)
      .then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(false);
    child.emit('close', null);
    expect((await waiting).success).toBe(false);
    expect(manager.listProcesses()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not force completion after cancellation while close remains pending', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true), exitCode: null, signalCode: null,
      stdout: new EventEmitter(), stderr: new EventEmitter(),
    }) as unknown as ChildProcess;
    vi.spyOn(bashProcess, 'spawnBashCommand').mockReturnValue(child);
    const controller = new AbortController();
    const tool = new BashTool(new ActivityStream());
    let settled = false;
    const waiting = tool['executeCommand']('echo example', process.cwd(), Infinity, 'full', controller.signal)
      .then(result => { settled = true; return result; });
    controller.abort();
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
    child.stdout!.emit('data', Buffer.from('final output'));
    child.emit('close', null, 'SIGKILL');
    const result = await waiting;
    expect(result.success).toBe(false);
    expect(result.error_type).toBe('interrupted');
    expect(result.content).toBe('final output');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not report a signal-terminated command as successful', async () => {
    const result = await new BashTool(new ActivityStream()).execute({ command: 'kill -TERM $$' });
    expect(result.success).toBe(false);
    expect(result.return_code).toBeNull();
    expect(result.error_type).toBe('command_failed');
  });
});
