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
});
