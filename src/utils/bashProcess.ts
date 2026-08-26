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
