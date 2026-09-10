/**
 * HookRunner - the wire format and exit code contract, exercised against real
 * shell scripts rather than a mocked child process, because the contract is
 * the process boundary.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { HookRunner } from '../HookRunner.js';
import type { ResolvedHookGroup, ResolvedHooksConfig } from '../types.js';

let scriptDir: string;

beforeAll(async () => {
  scriptDir = await fs.mkdtemp(join(tmpdir(), 'ally-hook-runner-'));
});

afterAll(async () => {
  await fs.rm(scriptDir, { recursive: true, force: true });
});

async function script(name: string, body: string): Promise<string> {
  const path = join(scriptDir, name);
  await fs.writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function runner(groups: ResolvedHookGroup[], event: keyof ResolvedHooksConfig = 'PreToolUse'): HookRunner {
  return new HookRunner(
    { [event]: groups },
    { sessionId: () => 'session-1', cwd: scriptDir, projectDir: '/project/root' },
  );
}

function group(command: string, extra: Partial<ResolvedHookGroup> = {}, timeout?: number): ResolvedHookGroup {
  return {
    hooks: [{ type: 'command', command, ...(timeout === undefined ? {} : { timeout }) }],
    source: 'settings',
    ...extra,
  };
}

describe('HookRunner exit codes', () => {
  it('proceeds on exit 0 with no stdout', async () => {
    const verdict = await runner([group('exit 0')]).run('PreToolUse', {
      tool_name: 'bash',
      tool_input: {},
    });
    expect(verdict).toEqual({ kind: 'proceed', additionalContext: [], systemMessages: [] });
  });

  it('parses JSON stdout on exit 0', async () => {
    const path = await script(
      'context.sh',
      `echo '{"systemMessage":"loaded","hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"remember this"}}'`,
    );
    const verdict = await runner([group(path)]).run('PreToolUse', { tool_name: 'bash', tool_input: {} });
    expect(verdict).toEqual({
      kind: 'proceed',
      additionalContext: ['remember this'],
      systemMessages: ['loaded'],
    });
  });

  it('blocks on exit 2 with stderr as the reason', async () => {
    const path = await script('deny.sh', 'echo "not allowed here" >&2\nexit 2');
    const verdict = await runner([group(path, { source: 'plugin:guard' })]).run('PreToolUse', {
      tool_name: 'bash',
      tool_input: {},
    });
    expect(verdict).toEqual({ kind: 'block', reason: 'not allowed here', source: 'plugin:guard' });
  });

  it('treats any other exit code as a non-blocking failure', async () => {
    const path = await script('broken.sh', 'echo "oops" >&2\nexit 7');
    const verdict = await runner([group(path)]).run('PreToolUse', { tool_name: 'bash', tool_input: {} });
    expect(verdict.kind).toBe('proceed');
  });

  it('kills a hook that overruns its timeout and does not block on it', async () => {
    const path = await script('slow.sh', 'sleep 30');
    const started = Date.now();
    const verdict = await runner([group(path, {}, 0.25)]).run('PreToolUse', {
      tool_name: 'bash',
      tool_input: {},
    });
    expect(verdict.kind).toBe('proceed');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('settles when a hook exits, even though a backgrounded child holds the pipes', async () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'notify-in-background.sh');
    const started = Date.now();
    const verdict = await runner([group(path, {}, 10)]).run('PreToolUse', {
      tool_name: 'bash',
      tool_input: {},
    });
    expect(verdict).toMatchObject({ kind: 'proceed', systemMessages: ['notified'] });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('blocks on a deny permissionDecision in stdout', async () => {
    const path = await script(
      'deny-json.sh',
      `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"policy says no"}}'`,
    );
    const verdict = await runner([group(path)]).run('PreToolUse', { tool_name: 'bash', tool_input: {} });
    expect(verdict).toMatchObject({ kind: 'block', reason: 'policy says no' });
  });

  it('blocks on a block decision in stdout', async () => {
    const path = await script('block-json.sh', `echo '{"decision":"block","reason":"stop"}'`);
    const verdict = await runner([group(path)]).run('PreToolUse', { tool_name: 'bash', tool_input: {} });
    expect(verdict).toMatchObject({ kind: 'block', reason: 'stop' });
  });

  it('replaces the tool input when a hook returns updatedInput', async () => {
    const path = await script(
      'rewrite.sh',
      `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"git status"}}}'`,
    );
    const verdict = await runner([group(path)]).run('PreToolUse', {
      tool_name: 'bash',
      tool_input: { command: 'git push' },
    });
    expect(verdict).toMatchObject({ kind: 'proceed', updatedInput: { command: 'git status' } });
  });

  it('takes plain stdout as context for SessionStart', async () => {
    const path = await script('brief.sh', 'echo "three findings are open"');
    const verdict = await new HookRunner(
      { SessionStart: [group(path)] },
      { sessionId: () => 's', cwd: scriptDir, projectDir: '/project/root' },
    ).run('SessionStart', { source: 'startup' });
    expect(verdict).toMatchObject({ additionalContext: ['three findings are open'] });
  });
});

describe('HookRunner payload and environment', () => {
  it('writes the event payload to stdin as JSON', async () => {
    const out = join(scriptDir, 'payload.json');
    const path = await script('capture.sh', `cat > ${out}`);
    await runner([group(path)]).run('PreToolUse', {
      tool_name: 'bash',
      tool_input: { command: 'ls' },
    });
    expect(JSON.parse(await fs.readFile(out, 'utf-8'))).toEqual({
      session_id: 'session-1',
      cwd: scriptDir,
      hook_event_name: 'PreToolUse',
      tool_name: 'bash',
      tool_input: { command: 'ls' },
    });
  });

  it('exports the project dir under both names and the plugin root for plugin hooks', async () => {
    const out = join(scriptDir, 'env.txt');
    const path = await script(
      'env.sh',
      `printf '%s|%s|%s' "$CLAUDE_PROJECT_DIR" "$ALLY_PROJECT_DIR" "$CLAUDE_PLUGIN_ROOT" > ${out}`,
    );
    await runner([group(path, { source: 'plugin:guardrails', pluginRoot: '/plugins/guardrails' })]).run(
      'PreToolUse',
      { tool_name: 'bash', tool_input: {} },
    );
    expect(await fs.readFile(out, 'utf-8')).toBe('/project/root|/project/root|/plugins/guardrails');
  });

  it('leaves CLAUDE_PLUGIN_ROOT unset for hooks that did not come from a plugin', async () => {
    const out = join(scriptDir, 'env-noplugin.txt');
    const path = await script('env-noplugin.sh', `printf '%s' "$CLAUDE_PLUGIN_ROOT" > ${out}`);
    await runner([group(path)]).run('PreToolUse', { tool_name: 'bash', tool_input: {} });
    expect(await fs.readFile(out, 'utf-8')).toBe('');
  });
});

describe('HookRunner matching', () => {
  it('runs every hook of an event concurrently and lets any block win', async () => {
    const marker = join(scriptDir, 'concurrent.txt');
    const slow = await script('slow-allow.sh', `sleep 0.4; echo done >> ${marker}`);
    const fast = await script('fast-deny.sh', 'echo "denied" >&2\nexit 2');
    const started = Date.now();
    const verdict = await runner([group(slow), group(fast)]).run('PreToolUse', {
      tool_name: 'bash',
      tool_input: {},
    });
    expect(verdict).toMatchObject({ kind: 'block', reason: 'denied' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it('matches a group with no matcher and a group matching *', async () => {
    const path = await script('always.sh', 'exit 2');
    for (const matcher of [undefined, '*']) {
      const verdict = await runner([group(path, matcher === undefined ? {} : { matcher })]).run(
        'PreToolUse',
        { tool_name: 'bash', tool_input: {} },
        'bash',
      );
      expect(verdict.kind).toBe('block');
    }
  });

  it('treats the matcher as a regex over the normalized tool name', async () => {
    const path = await script('regex.sh', 'exit 2');
    const config = [group(path, { matcher: '^(bash|write)$' })];
    expect((await runner(config).run('PreToolUse', { tool_name: 'bash', tool_input: {} }, 'bash')).kind).toBe('block');
    expect((await runner(config).run('PreToolUse', { tool_name: 'read', tool_input: {} }, 'read')).kind).toBe('proceed');
  });

  it('matches a Claude-spelled tool name against its Ally name', async () => {
    const path = await script('alias.sh', 'exit 2');
    const verdict = await runner([group(path, { matcher: 'Edit' })]).run(
      'PreToolUse',
      { tool_name: 'apply-patch', tool_input: {} },
      'apply-patch',
    );
    expect(verdict.kind).toBe('block');
  });

  it('skips a group whose matcher is not a valid regex', async () => {
    const path = await script('never.sh', 'exit 2');
    const verdict = await runner([group(path, { matcher: '([' })]).run(
      'PreToolUse',
      { tool_name: 'bash', tool_input: {} },
      'bash',
    );
    expect(verdict.kind).toBe('proceed');
  });
});

describe('HookRunner.hasHooks', () => {
  it('is false for an event with no configured group and true otherwise', () => {
    const instance = runner([group('exit 0')]);
    expect(instance.hasHooks('PreToolUse')).toBe(true);
    expect(instance.hasHooks('SessionEnd')).toBe(false);
  });

  it('proceeds without spawning anything when the config is empty', async () => {
    const empty = new HookRunner({}, { sessionId: () => 's', cwd: scriptDir, projectDir: scriptDir });
    expect(await empty.run('Stop', { stop_hook_active: false })).toMatchObject({ kind: 'proceed' });
  });
});
