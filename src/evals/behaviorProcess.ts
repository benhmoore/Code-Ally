/** Bound one owned evaluation worker without signalling a PID after its exit. */
import type { ChildProcess } from 'node:child_process';
export const BEHAVIOR_WORKER_STOP = 'behavior-worker-stop';
export const BEHAVIOR_WORKER_CLEANED = 'behavior-worker-cleanup-complete';
export const BEHAVIOR_WORKER_STOPPING = 'behavior-worker-stopping';

export interface BehaviorProcessOutcome {
  pid?: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  interrupted: boolean;
  exitObserved: boolean;
  closeObserved: boolean;
  cleanupConfirmed: boolean;
  cleanupAcknowledged: boolean;
  cooperativeStopSent: boolean;
  ownedProcesses: Array<{ pid: number; id: string }>;
  groupSignalSent: boolean;
  directSignalSent: boolean;
  timeoutTriggeredAfterMs?: number;
  timeoutOvershootMs?: number;
  errors: string[];
}
export interface BehaviorProcessOptions {
  timeoutMs: number;
  cooperativeGraceMs?: number;
  terminationGraceMs?: number;
  closeGraceMs?: number;
  signalGroup?: (pid: number) => void;
}
export function superviseBehaviorWorker(
  child: ChildProcess,
  options: BehaviorProcessOptions
): Promise<BehaviorProcessOutcome> {
  return new Promise(resolve => {
    const started = Date.now();
    const state: BehaviorProcessOutcome = {
      pid: child.pid,
      exitCode: null,
      signal: null,
      timedOut: false,
      interrupted: false,
      exitObserved: false,
      closeObserved: false,
      cleanupConfirmed: false,
      cleanupAcknowledged: false,
      cooperativeStopSent: false,
      ownedProcesses: [],
      groupSignalSent: false,
      directSignalSent: false,
      errors: [],
    };
    let finished = false;
    let stopping = false;
    let forcedWindows = false;
    let cooperativeTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const destroyPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      clearTimeout(terminationTimer);
      clearTimeout(cooperativeTimer);
      clearTimeout(closeTimer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      child.removeListener('exit', exited);
      child.removeListener('close', closed);
      child.removeListener('message', message);
      // Keep an error listener: a denied asynchronous child.kill can report late.
      state.cleanupConfirmed =
        !child.pid || (state.exitObserved && state.closeObserved && state.cleanupAcknowledged && !forcedWindows);
      if (child.pid && !state.cleanupAcknowledged)
        state.errors.push('Worker did not acknowledge managed-process cleanup; descendant cleanup is unconfirmed');
      if (!state.closeObserved) destroyPipes();
      if (!state.exitObserved) {
        if (child.connected) child.disconnect();
        child.unref();
      }
      resolve(state);
    };
    const alive = () =>
      !finished && !state.exitObserved && child.exitCode === null && child.signalCode === null && !!child.pid;
    const force = () => {
      if (!alive()) return;
      if (process.platform !== 'win32') {
        try {
          (
            options.signalGroup ??
            (pid => {
              process.kill(-pid, 'SIGKILL');
            })
          )(child.pid!);
          state.groupSignalSent = true;
        } catch (error) {
          state.errors.push(`Worker process-group termination failed: ${String(error)}`);
        }
      }
      if (process.platform === 'win32') {
        forcedWindows = true;
        state.errors.push('Process-group termination is unavailable on Windows; descendant cleanup is unconfirmed');
      }
      if (!state.groupSignalSent && alive()) {
        try {
          state.directSignalSent = child.kill('SIGKILL');
          if (!state.directSignalSent) state.errors.push('Owned worker direct SIGKILL was not delivered');
        } catch (error) {
          state.errors.push(`Owned worker direct termination failed: ${String(error)}`);
        }
      }
      terminationTimer = setTimeout(() => {
        state.errors.push(
          'Worker exit was not observed within the termination grace period; owned processes may remain'
        );
        finish();
      }, options.terminationGraceMs ?? 2000);
    };
    const stop = () => {
      if (stopping || finished) return;
      if (!alive()) {
        finish();
        return;
      }
      stopping = true;
      clearTimeout(timeoutTimer);
      if (child.connected) {
        try {
          child.send({ type: BEHAVIOR_WORKER_STOP }, error => {
            if (error && !finished) state.errors.push(`Worker stop request failed: ${String(error)}`);
          });
          state.cooperativeStopSent = true;
        } catch (error) {
          state.errors.push(`Worker stop request failed: ${String(error)}`);
        }
      }
      if (state.cooperativeStopSent) cooperativeTimer = setTimeout(force, options.cooperativeGraceMs ?? 1500);
      else force();
    };
    const message = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      if (value.type === BEHAVIOR_WORKER_CLEANED) state.cleanupAcknowledged = true;
      if (value.type === BEHAVIOR_WORKER_STOPPING && 'ownedProcesses' in value && Array.isArray(value.ownedProcesses))
        state.ownedProcesses = value.ownedProcesses.filter(
          (item): item is { pid: number; id: string } =>
            !!item &&
            typeof item === 'object' &&
            Number.isSafeInteger(item.pid) &&
            item.pid > 0 &&
            typeof item.id === 'string'
        );
    };
    const interrupt = () => {
      state.interrupted = true;
      stop();
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      state.exitObserved = true;
      state.exitCode = code;
      state.signal = signal;
      clearTimeout(timeoutTimer);
      clearTimeout(terminationTimer);
      clearTimeout(cooperativeTimer);
      if (state.closeObserved) finish();
      else
        closeTimer = setTimeout(() => {
          state.errors.push('Worker exited but its pipes remained open; descendant cleanup is unconfirmed');
          finish();
        }, options.closeGraceMs ?? 250);
    };
    const closed = (code: number | null = child.exitCode, signal: NodeJS.Signals | null = child.signalCode) => {
      state.closeObserved = true;
      if (!state.exitObserved) {
        state.exitCode = code;
        state.signal = signal;
      }
      finish();
    };
    child.on('message', message);
    child.once('exit', exited);
    child.once('close', closed);
    child.on('error', error => {
      if (!finished) state.errors.push(`Owned worker error: ${String(error)}`);
      if (!child.pid) finish();
    });
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const timeoutTimer = setTimeout(() => {
      state.timedOut = true;
      state.timeoutTriggeredAfterMs = Date.now() - started;
      state.timeoutOvershootMs = Math.max(0, state.timeoutTriggeredAfterMs - options.timeoutMs);
      stop();
    }, options.timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) {
      exited(child.exitCode, child.signalCode);
      if ((!child.stdout || child.stdout.destroyed) && (!child.stderr || child.stderr.destroyed)) closed();
    }
  });
}
