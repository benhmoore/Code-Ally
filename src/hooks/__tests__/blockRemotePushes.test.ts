/**
 * Compatibility with a hook written for Claude Code, as a test rather than a
 * claim. The fixture is a guard of the shape those hooks take: it reads
 * tool_input.command from the payload on stdin and exits 2 with a reason on
 * stderr.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HookRunner } from '../HookRunner.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'block-remote-pushes.sh');

function runner(): HookRunner {
  return new HookRunner(
    {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: fixture, timeout: 10 }],
          source: 'settings',
        },
      ],
    },
    { sessionId: () => 'session-1', cwd: process.cwd(), projectDir: process.cwd() },
  );
}

function runCommand(command: string) {
  return runner().run('PreToolUse', { tool_name: 'bash', tool_input: { command } }, 'bash');
}

describe('a Claude Code style guard hook through the runner', () => {
  it('blocks git push origin main with the script reason', async () => {
    expect(await runCommand('git push origin main')).toEqual({
      kind: 'block',
      reason: 'remote-publishing commands are blocked in this session; branches stay local',
      source: 'settings',
    });
  });

  it('lets git status proceed', async () => {
    expect(await runCommand('git status')).toMatchObject({ kind: 'proceed' });
  });
});
