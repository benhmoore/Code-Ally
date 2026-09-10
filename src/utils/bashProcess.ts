import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/**
 * Run a model-supplied shell command under one deterministic Bash contract.
 *
 * Node's `shell: true` selects `/bin/sh` on Unix and reports only the final
 * pipeline stage's status. That can turn `tests | tail` into a successful tool
 * result when the tests failed. Bash with pipefail makes every shell-backed
 * tool observe the same conservative success invariant: every pipeline stage
 * completed successfully unless the command explicitly handles a failure.
 * Profiles are disabled so user startup files cannot change automation.
 */
export function spawnBashCommand(command: string, options: SpawnOptions): ChildProcess {
  return spawn('bash', ['--noprofile', '--norc', '-o', 'pipefail', '-c', command], {
    ...options,
    shell: false,
  });
}

/** Hand off ownership only after spawn succeeds; failed spawn settles on close. */
export function waitForBashSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.removeListener('spawn', onSpawn);
      child.once('close', () => reject(error));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** Signal a detached Unix process group, or the direct child on other platforms. */
export function signalBashProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (process.platform !== 'win32' && child.pid && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return child.kill(signal);
}

/**
 * Observe a newly spawned command through close, including cancellation cleanup.
 * Attach immediately after spawn. Abort requests termination; it is not evidence
 * of exit. A non-cooperating child is escalated after the grace period. Neither
 * sending a signal nor receiving an error substitutes for confirmed close.
 */
export function waitForBashClose(
  child: ChildProcess,
  signal: AbortSignal,
  gracefulTimeoutMs = 5000,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const send = (requested: NodeJS.Signals) => {
      try { signalBashProcess(child, requested); }
      catch (error) { failure ??= error as Error; }
    };
    const abort = () => {
      send('SIGTERM');
      escalation = setTimeout(() => send('SIGKILL'), gracefulTimeoutMs);
    };
    const onError = (error: Error) => { failure ??= error; };
    const onClose = (code: number | null) => {
      clearTimeout(escalation);
      signal.removeEventListener('abort', abort);
      child.removeListener('error', onError);
      if (failure) reject(failure);
      else resolve(signal.aborted ? null : code);
    };
    child.on('error', onError);
    child.once('close', onClose);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
