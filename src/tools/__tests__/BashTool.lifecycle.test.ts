import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bashProcess from '../../utils/bashProcess.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { BashTool } from '../BashTool.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { BashProcessManager } from '../../services/BashProcessManager.js';

describe('shell lifecycle', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('admits a background child after spawn and keeps final output until close', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new EventEmitter() }) as unknown as ChildProcess;
    vi.spyOn(bashProcess, 'spawnBashCommand').mockReturnValue(child);
    const manager = new BashProcessManager();
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockReturnValue(manager);
    const waiting = new BashTool(new ActivityStream())['spawnBackground']('echo example', process.cwd(), false);
    expect(manager.listProcesses()).toEqual([]);
    child.emit('spawn');
    expect((await waiting).success).toBe(true);
    const info = manager.listProcesses()[0];
    child.emit('exit', 0, null);
    expect(info.status).toBe('running');
    child.stdout!.emit('data', Buffer.from('final output'));
    child.emit('close', 0, null);
    expect(info.status).toBe('exited');
    expect(info.outputBuffer.getLines().join('\n')).toBe('final output');
  });

  it('reports an asynchronous background spawn failure only after close', async () => {
    const child = new EventEmitter() as ChildProcess;
    vi.spyOn(bashProcess, 'spawnBashCommand').mockReturnValue(child);
    const manager = new BashProcessManager();
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockReturnValue(manager);
    let settled = false;
    const waiting = new BashTool(new ActivityStream())['spawnBackground']('echo example', process.cwd(), false)
      .then(result => { settled = true; return result; });
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(manager.listProcesses()).toEqual([]);
    child.emit('close', -2);
    expect((await waiting).error).toContain('spawn ENOENT');
    expect(child.listenerCount('spawn')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  it('handles a real background launch with a nonexistent working directory', async () => {
    const manager = new BashProcessManager();
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockReturnValue(manager);
    const result = await new BashTool(new ActivityStream())['spawnBackground']('printf ok', path.join(tmpdir(), `ally-missing-${randomUUID()}`), false);
    expect(result.success).toBe(false);
    expect(result.error_type).toBe('system_error');
    expect(manager.listProcesses()).toEqual([]);
  });

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
    child.emit('spawn');
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
