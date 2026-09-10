/**
 * HooksConfigLoader - merge order, source tagging, and what a malformed entry
 * costs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHooksConfig, normalizeHooksConfig } from '../HooksConfigLoader.js';
import type { HooksConfig } from '../types.js';

let workDir: string;

beforeAll(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'ally-hooks-loader-'));
});

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

function commandGroup(command: string): HooksConfig {
  return { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command }] }] };
}

function fakeConfigManager(hooks: unknown) {
  return { getValue: () => hooks } as never;
}

function fakePluginManager(plugins: Array<{ pluginName: string; installPath: string; hooks: unknown }>) {
  return {
    getEnabledPlugins: () => plugins as never,
    getPluginHooksConfig: async (installPath: string) =>
      (plugins.find(plugin => plugin.installPath === installPath)?.hooks ?? null) as never,
  } as never;
}

describe('loadHooksConfig', () => {
  it('concatenates profile, plugin, and settings groups in that order', async () => {
    const settingsFile = join(workDir, 'settings.json');
    await fs.writeFile(settingsFile, JSON.stringify({ hooks: commandGroup('from-settings') }));

    const config = await loadHooksConfig({
      configManager: fakeConfigManager(commandGroup('from-profile')),
      pluginManager: fakePluginManager([
        { pluginName: 'guardrails', installPath: '/plugins/guardrails', hooks: commandGroup('from-plugin') },
      ]),
      settingsFile,
    });

    expect(config.PreToolUse?.map(group => group.hooks[0].command)).toEqual([
      'from-profile',
      'from-plugin',
      'from-settings',
    ]);
    expect(config.PreToolUse?.map(group => group.source)).toEqual([
      'profile',
      'plugin:guardrails',
      'settings',
    ]);
  });

  it('carries the plugin install path so the runner can export CLAUDE_PLUGIN_ROOT', async () => {
    const config = await loadHooksConfig({
      pluginManager: fakePluginManager([
        { pluginName: 'guardrails', installPath: '/plugins/guardrails', hooks: commandGroup('guard') },
      ]),
    });
    expect(config.PreToolUse?.[0]?.pluginRoot).toBe('/plugins/guardrails');
  });

  it('returns an empty config when no source declares a hook', async () => {
    expect(await loadHooksConfig({})).toEqual({});
  });

  it('throws when a named settings file is missing', async () => {
    await expect(loadHooksConfig({ settingsFile: join(workDir, 'absent.json') })).rejects.toThrow(
      /Could not read settings file/,
    );
  });

  it('throws when a named settings file is not valid JSON', async () => {
    const path = join(workDir, 'broken.json');
    await fs.writeFile(path, '{not json');
    await expect(loadHooksConfig({ settingsFile: path })).rejects.toThrow(/not valid JSON/);
  });

  it('accepts a settings file with no hooks key', async () => {
    const path = join(workDir, 'no-hooks.json');
    await fs.writeFile(path, JSON.stringify({ model: 'something' }));
    expect(await loadHooksConfig({ settingsFile: path })).toEqual({});
  });
});

describe('normalizeHooksConfig', () => {
  it('keeps a well-formed group and its timeout', () => {
    const config = normalizeHooksConfig(
      { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard', timeout: 5 }] }] },
      'settings',
    );
    expect(config.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard', timeout: 5 }], source: 'settings' },
    ]);
  });

  it('drops unknown events, malformed groups, and unusable hooks', () => {
    const config = normalizeHooksConfig(
      {
        NotAnEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
        PreToolUse: [
          'not a group',
          { matcher: 7, hooks: [] },
          { hooks: 'not an array' },
          { hooks: [{ type: 'inline', command: 'x' }] },
          { hooks: [{ type: 'command', command: '  ' }] },
          { hooks: [{ type: 'command', command: 'ok', timeout: -1 }] },
          { hooks: [{ type: 'command', command: 'kept' }] },
        ],
      },
      'settings',
    );
    expect(config.PreToolUse).toHaveLength(1);
    expect(config.PreToolUse?.[0]?.hooks[0]?.command).toBe('kept');
    expect(config.NotAnEvent as unknown).toBeUndefined();
  });

  it('ignores a hooks value that is not an object', () => {
    expect(normalizeHooksConfig(['nope'], 'profile')).toEqual({});
    expect(normalizeHooksConfig(undefined, 'profile')).toEqual({});
  });
});
