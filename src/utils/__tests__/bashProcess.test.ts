import { EventEmitter, once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { signalBashProcess, spawnBashCommand, waitForBashClose } from '../bashProcess.js';

describe('Bash cancellation settlement', () => {
  it.skipIf(process.platform === 'win32')('does not narrow a denied group signal to the direct child', () => {
    const failure = Object.assign(new Error('denied'), { code: 'EPERM' });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw failure; });
    const child = { pid: 12345, kill: vi.fn() } as unknown as ChildProcess;
    try {
      expect(() => signalBashProcess(child, 'SIGTERM')).toThrow(failure);
      expect(child.kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });

  it('handles an already aborted signal and still awaits close', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as unknown as ChildProcess;
    const controller = new AbortController();
    controller.abort();
    const waiting = waitForBashClose(child, controller.signal);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    child.emit('close', 0);
    expect(await waiting).toBeNull();
  });

  it('waits for close after cancellation, escalates, and removes lifecycle listeners', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as unknown as ChildProcess;
    const controller = new AbortController();
    let settled = false;
    const waiting = waitForBashClose(child, controller.signal, 100).then(code => { settled = true; return code; });
    try {
      controller.abort();
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
      expect(settled).toBe(false);
      child.emit('close', 0);
      expect(await waiting).toBeNull();
      expect(child.listenerCount('error')).toBe(0);
      expect(child.listenerCount('close')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('retains spawn errors until close and then rejects', async () => {
    const child = new EventEmitter() as ChildProcess;
    const failure = new Error('spawn failed');
    const waiting = waitForBashClose(child, new AbortController().signal);
    const rejected = expect(waiting).rejects.toBe(failure);
    child.emit('error', failure);
    child.emit('close', -2);
    await rejected;
  });

  it('clears escalation after graceful close', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as unknown as ChildProcess;
    const controller = new AbortController();
    try {
      const waiting = waitForBashClose(child, controller.signal, 100);
      controller.abort();
      child.emit('close', null);
      await waiting;
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    } finally { vi.useRealTimers(); }
  });

  it.skipIf(process.platform === 'win32')('reaps a real command that ignores SIGTERM before settling', async () => {
    const child = spawnBashCommand("trap '' TERM; printf ready; while :; do sleep 1; done", {
      detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const controller = new AbortController();
    const waiting = waitForBashClose(child, controller.signal, 30);
    try {
      await once(child.stdout!, 'data');
      controller.abort();
      expect(await waiting).toBeNull();
      expect(child.signalCode).toBe('SIGKILL');
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally {
      controller.abort();
      await waiting;
    }
  });
});
