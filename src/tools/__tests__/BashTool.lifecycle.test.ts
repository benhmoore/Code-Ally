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

  it('keeps a real command PID running across foreground release until normal completion', async () => {
    const manager = new BashProcessManager();
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name => name === 'bash_process_manager' ? manager as never : null);
    const spawn = vi.spyOn(bashProcess, 'spawnBashCommand');
    const waiting = new BashTool(new ActivityStream())['executeCommand']('printf ready; sleep 0.1; printf done', process.cwd(), Infinity);
    const child = spawn.mock.results[0]!.value as ChildProcess;
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
      expect(manager.backgroundForeground()).toBe(1);
      const result = await waiting;
      expect(result.pid).toBe(child.pid);
      const info = manager.listProcesses()[0]!;
      expect(info.process).toBe(child);
      await closed;
      await Promise.resolve();
      expect(info.status).toBe('exited');
      expect(info.exitCode).toBe(0);
      expect(info.outputBuffer.getLines().join('')).toBe('readydone');
      expect(spawn).toHaveBeenCalledOnce();
    } finally { await manager.shutdown(); }
  });

  it('leaves the foreground command untouched when shortcut background admission is full', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 34567, exitCode: null, signalCode: null,
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true) }) as unknown as ChildProcess;
    const spawn = vi.spyOn(bashProcess, 'spawnBashCommand').mockReturnValue(child);
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const manager = new BashProcessManager(0);
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name => name === 'bash_process_manager' ? manager as never : null);
    let settled = false;
    const waiting = new BashTool(new ActivityStream())['executeCommand']('already admitted command', process.cwd(), Infinity)
      .then(result => { settled = true; return result; });
    child.emit('spawn');
    await Promise.resolve();
    expect(() => manager.backgroundForeground()).toThrow('Process limit reached');
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
    expect(manager.listProcesses()).toHaveLength(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    child.stdout!.emit('data', Buffer.from('normal completion'));
    child.emit('close', 0, null);
    expect(await waiting).toMatchObject({ success: true, content: 'normal completion' });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it.each(['shortcut', 'timeout'])('hands the same running PID to supervision via %s without restart or abort', async trigger => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 23456, exitCode: null, signalCode: null,
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true) }) as unknown as ChildProcess;
    const spawn = vi.spyOn(bashProcess, 'spawnBashCommand').mockReturnValue(child);
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const manager = new BashProcessManager();
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name => name === 'bash_process_manager' ? manager as never : null);
    const stream = new ActivityStream();
    const events: unknown[] = [];
    stream.subscribe('background_process_exit' as any, event => events.push(event));
    const controller = new AbortController();
    const waiting = new BashTool(stream)['executeCommand']('long command', process.cwd(), 1000, 'full', controller.signal);
    child.stdout!.emit('data', Buffer.from('before detach\n'));
    child.emit('spawn');
    await Promise.resolve();
    if (trigger === 'shortcut') {
      expect(manager.backgroundForeground('another-agent')).toBe(0);
      expect(manager.backgroundForeground()).toBe(1);
      expect(manager.backgroundForeground()).toBe(0);
    } else await vi.advanceTimersByTimeAsync(1000);
    expect(manager.backgroundForeground()).toBe(0);
    const result = await waiting;
    const info = manager.listProcesses()[0]!;
    expect(result).toMatchObject({ success: true, pid: 23456, shell_id: info.id });
    expect(info.process).toBe(child);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    child.stdout!.emit('data', Buffer.from('after detach\n'));
    child.emit('close', 0, null);
    child.emit('close', 0, null);
    await Promise.resolve();
    expect(info.status).toBe('exited');
    expect(info.outputBuffer.getLines()).toEqual(['before detach', 'after detach']);
    expect(events).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('admits a background child after spawn and keeps final output until close', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null, stdout: new EventEmitter() }) as unknown as ChildProcess;
    vi.spyOn(bashProcess, 'spawnBashCommand').mockReturnValue(child);
    const manager = new BashProcessManager();
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name => name === 'bash_process_manager' ? manager as never : null);
    const waiting = new BashTool(new ActivityStream())['executeCommand']('echo example', process.cwd(), Infinity, 'full', undefined, undefined, true);
    expect(manager.listProcesses()).toEqual([]);
    child.emit('spawn');
    expect((await waiting).success).toBe(true);
    const info = manager.listProcesses()[0];
    child.emit('exit', 0, null);
    expect(info.status).toBe('running');
    child.stdout!.emit('data', Buffer.from('final output'));
    child.emit('close', 0, null);
    await Promise.resolve();
    expect(info.status).toBe('exited');
    expect(info.outputBuffer.getLines().join('\n')).toBe('final output');
  });

  it('reports an asynchronous background spawn failure only after close', async () => {
    const child = new EventEmitter() as ChildProcess;
    vi.spyOn(bashProcess, 'spawnBashCommand').mockReturnValue(child);
    const manager = new BashProcessManager();
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name => name === 'bash_process_manager' ? manager as never : null);
    let settled = false;
    const waiting = new BashTool(new ActivityStream())['executeCommand']('echo example', process.cwd(), Infinity, 'full', undefined, undefined, true)
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
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name => name === 'bash_process_manager' ? manager as never : null);
    const result = await new BashTool(new ActivityStream())['executeCommand']('printf ok', path.join(tmpdir(), `ally-missing-${randomUUID()}`), Infinity, 'full', undefined, undefined, true);
    expect(result.success).toBe(false);
    expect(result.error_type).toBe('system_error');
    expect(manager.listProcesses()).toEqual([]);
  });

  it('reaps a child rejected by background admission before reporting failure', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null, kill: vi.fn(() => true) }) as unknown as ChildProcess;
    vi.spyOn(bashProcess, 'spawnBashCommand').mockReturnValue(child);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const manager = new BashProcessManager(0);
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name => name === 'bash_process_manager' ? manager as never : null);
    const tool = new BashTool(new ActivityStream());
    let settled = false;
    const waiting = tool['executeCommand']('echo example', process.cwd(), Infinity, 'full', undefined, undefined, true)
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
