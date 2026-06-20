import { describe, expect, it } from 'vitest';
import { InterruptionManager } from '../InterruptionManager.js';

describe('InterruptionManager', () => {
  it('does not reuse an aborted tool signal after reset', () => {
    const manager = new InterruptionManager();

    const firstSignal = manager.startToolExecution();
    manager.interrupt('cancel');

    expect(firstSignal.aborted).toBe(true);

    manager.reset();
    const secondSignal = manager.startToolExecution();

    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal.aborted).toBe(false);
  });

  it('keeps newly started tool execution aborted while a cancel is active', () => {
    const manager = new InterruptionManager();

    manager.interrupt('cancel');
    const signal = manager.startToolExecution();

    expect(signal.aborted).toBe(true);
  });

  it('beginRequest returns a fresh, non-aborted request signal', () => {
    const manager = new InterruptionManager();

    const signal = manager.beginRequest();

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('aborts the request signal when interrupt(cancel) fires after beginRequest', () => {
    const manager = new InterruptionManager();

    const requestSignal = manager.beginRequest();
    manager.interrupt('cancel');

    expect(requestSignal.aborted).toBe(true);
  });

  it('interjection aborts the request signal but not the tool signal', () => {
    const manager = new InterruptionManager();

    const requestSignal = manager.beginRequest();
    const toolSignal = manager.startToolExecution();

    manager.interrupt('interjection');

    expect(requestSignal.aborted).toBe(true);
    expect(toolSignal.aborted).toBe(false);
  });

  it('cancel aborts both the request signal and the tool signal', () => {
    const manager = new InterruptionManager();

    const requestSignal = manager.beginRequest();
    const toolSignal = manager.startToolExecution();

    manager.interrupt('cancel');

    expect(requestSignal.aborted).toBe(true);
    expect(toolSignal.aborted).toBe(true);
  });

  it('beginRequest returns a fresh non-aborted signal after interrupt then reset', () => {
    const manager = new InterruptionManager();

    const firstSignal = manager.beginRequest();
    manager.interrupt('cancel');
    expect(firstSignal.aborted).toBe(true);

    manager.reset();
    const secondSignal = manager.beginRequest();

    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal.aborted).toBe(false);
  });
});
