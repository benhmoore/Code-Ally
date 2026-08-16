import { beforeEach, describe, expect, it } from 'vitest';
import { FocusScope, type FocusTarget } from '../FocusScope.js';

class FakeFocusManager implements FocusTarget {
  focusDirectory: string | null = null;
  excluded: string[] | null = null;
  setFocusCalls: string[] = [];
  clearFocusCalls = 0;
  clearExcludedCalls = 0;
  failNext = false;
  throwNext = false;

  getFocusDirectory(): string | null {
    return this.focusDirectory;
  }

  async setFocus(inputPath: string): Promise<{ success: boolean; message: string }> {
    this.setFocusCalls.push(inputPath);
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('focus exploded');
    }
    if (this.failNext) {
      this.failNext = false;
      return { success: false, message: 'not accessible' };
    }
    this.focusDirectory = inputPath;
    return { success: true, message: 'ok' };
  }

  clearFocus(): unknown {
    this.clearFocusCalls++;
    this.focusDirectory = null;
    return { success: true, message: 'cleared' };
  }

  setExcludedFiles(filePaths: string[]): void {
    this.excluded = [...filePaths];
  }

  clearExcludedFiles(): void {
    this.clearExcludedCalls++;
    this.excluded = null;
  }
}

describe('FocusScope', () => {
  let manager: FakeFocusManager;
  let scope: FocusScope;

  beforeEach(() => {
    manager = new FakeFocusManager();
    scope = new FocusScope({ resolveTarget: () => manager, label: 'agent-1' });
  });

  it('acquires focus and restores the previous directory on release', async () => {
    manager.focusDirectory = '/repo/before';

    await scope.acquire('/repo/scoped');
    expect(manager.focusDirectory).toBe('/repo/scoped');
    expect(scope.isHeld()).toBe(true);
    expect(scope.getPreviousFocus()).toBe('/repo/before');

    await scope.release();
    expect(manager.focusDirectory).toBe('/repo/before');
    expect(scope.isHeld()).toBe(false);
  });

  it('clears focus on release when there was no previous focus', async () => {
    await scope.acquire('/repo/scoped');
    await scope.release();

    expect(manager.clearFocusCalls).toBe(1);
    expect(manager.focusDirectory).toBeNull();
  });

  it('installs and clears file exclusions across the lifetime', async () => {
    await scope.acquire('/repo/scoped', ['secret.env']);
    expect(manager.excluded).toEqual(['secret.env']);

    await scope.release();
    expect(manager.excluded).toBeNull();
    expect(manager.clearExcludedCalls).toBe(1);
  });

  it('rolls back exclusions when setFocus reports failure', async () => {
    // Regression: exclusions were installed before setFocus, and release keyed off
    // "did we set focus" — so a failed setFocus left the exclusions installed on
    // the process-global manager forever.
    manager.failNext = true;

    await scope.acquire('/nope', ['secret.env']);

    expect(manager.excluded).toBeNull();
    expect(scope.isHeld()).toBe(false);
  });

  it('rolls back exclusions when setFocus throws', async () => {
    manager.throwNext = true;

    await expect(scope.acquire('/nope', ['secret.env'])).resolves.toBeUndefined();

    expect(manager.excluded).toBeNull();
    expect(scope.isHeld()).toBe(false);
  });

  it('does not restore focus after a failed acquire', async () => {
    manager.focusDirectory = '/repo/before';
    manager.failNext = true;

    await scope.acquire('/nope');
    await scope.release();

    // Only the failed acquire attempt; release must not touch a focus it never took.
    expect(manager.setFocusCalls).toEqual(['/nope']);
    expect(manager.focusDirectory).toBe('/repo/before');
    expect(manager.clearFocusCalls).toBe(0);
  });

  it('is idempotent: a second release does not re-borrow focus', async () => {
    manager.focusDirectory = '/repo/before';
    await scope.acquire('/repo/scoped');

    await scope.release();
    manager.focusDirectory = '/somewhere/else'; // a later owner took focus

    await scope.release();

    expect(manager.focusDirectory).toBe('/somewhere/else');
    expect(manager.setFocusCalls).toEqual(['/repo/scoped', '/repo/before']);
    expect(manager.clearExcludedCalls).toBe(0);
  });

  it('releases ownership even when the restore itself throws', async () => {
    manager.focusDirectory = '/repo/before';
    await scope.acquire('/repo/scoped');
    manager.throwNext = true;

    await expect(scope.release()).resolves.toBeUndefined();

    expect(scope.isHeld()).toBe(false);
    // A retry must not attempt the restore a second time.
    await scope.release();
    expect(manager.setFocusCalls).toEqual(['/repo/scoped', '/repo/before']);
  });

  it('is a no-op when the focus manager is unavailable', async () => {
    const orphan = new FocusScope({ resolveTarget: () => null });

    await expect(orphan.acquire('/repo/scoped', ['x'])).resolves.toBeUndefined();
    expect(orphan.isHeld()).toBe(false);
    await expect(orphan.release()).resolves.toBeUndefined();
  });

  it('tolerates the focus manager disappearing between acquire and release', async () => {
    let available = true;
    const flaky = new FocusScope({ resolveTarget: () => (available ? manager : null) });

    await flaky.acquire('/repo/scoped');
    available = false;

    await expect(flaky.release()).resolves.toBeUndefined();
    expect(flaky.isHeld()).toBe(false);
  });

  it('reset() drops ownership without touching the focus manager', async () => {
    // Pooled reuse: the next task must never restore the previous task's focus.
    manager.focusDirectory = '/repo/before';
    await scope.acquire('/repo/scoped', ['secret.env']);

    scope.reset();

    expect(scope.isHeld()).toBe(false);
    expect(scope.getPreviousFocus()).toBeNull();
    expect(manager.focusDirectory).toBe('/repo/scoped');
    expect(manager.clearExcludedCalls).toBe(0);

    await scope.release();
    expect(manager.setFocusCalls).toEqual(['/repo/scoped']);
  });

  it('never throws out of acquire when the target itself is broken', async () => {
    const broken = new FocusScope({
      resolveTarget: () => {
        throw new Error('registry down');
      },
    });

    await expect(broken.acquire('/repo/scoped')).resolves.toBeUndefined();
    expect(broken.isHeld()).toBe(false);
    await expect(broken.release()).resolves.toBeUndefined();
  });
});
