/**
 * The confirmation gate is derived from declared capabilities, not from a
 * per-tool boolean. These tests pin the two properties that matter:
 *
 *  1. No tool can execute a model-supplied shell command without confirmation.
 *  2. Every tool that reaches the local filesystem declares its path parameters
 *     in its schema, so `BaseTool` can authorize them.
 *
 * Both were violated before: `watch` ran `spawn(target, {shell:true})` with
 * `requiresConfirmation = false`, and `tree`'s `paths` escaped authorization
 * purely because of what the parameter was named.
 */

import { describe, it, expect } from 'vitest';
import { ToolCapability, CONFIRMED_CAPABILITIES, capabilitiesRequireConfirmation } from '../ToolCapability.js';
import { collectLocalPaths } from '../schemaPaths.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { WatchTool } from '../WatchTool.js';
import { BashTool } from '../BashTool.js';
import { TreeTool } from '../TreeTool.js';
import { ReadTool } from '../ReadTool.js';

const stream = () => new ActivityStream();

describe('capability-derived confirmation gate', () => {
  it('treats state-changing and code-running capabilities as confirmable', () => {
    expect(CONFIRMED_CAPABILITIES.has(ToolCapability.ShellExec)).toBe(true);
    expect(CONFIRMED_CAPABILITIES.has(ToolCapability.FsWrite)).toBe(true);
    expect(CONFIRMED_CAPABILITIES.has(ToolCapability.ProcessControl)).toBe(true);
    expect(CONFIRMED_CAPABILITIES.has(ToolCapability.RemoteEffect)).toBe(true);
  });

  it('does not confirm reads, network fetches, or app-internal state writes', () => {
    // Reads are bounded by path authorization; confirming them, or confirming
    // every todo update, would train users to click through prompts.
    expect(CONFIRMED_CAPABILITIES.has(ToolCapability.FsRead)).toBe(false);
    expect(CONFIRMED_CAPABILITIES.has(ToolCapability.Network)).toBe(false);
    expect(CONFIRMED_CAPABILITIES.has(ToolCapability.AppStateWrite)).toBe(false);
  });

  it('confirms when any declared capability is confirmable', () => {
    expect(capabilitiesRequireConfirmation([ToolCapability.FsRead])).toBe(false);
    expect(capabilitiesRequireConfirmation([ToolCapability.FsRead, ToolCapability.ShellExec])).toBe(true);
    expect(capabilitiesRequireConfirmation([])).toBe(false);
  });
});

describe('watch — the verified unprompted-execution path', () => {
  const watch = () => new WatchTool(stream());

  it('requires confirmation for the shell condition', () => {
    expect(watch().requiresConfirmation({ condition: 'shell', command: 'echo hi' })).toBe(true);
  });

  it('stays unprompted for the harmless conditions', () => {
    expect(watch().requiresConfirmation({ condition: 'file_exists', file_path: '/tmp/x' })).toBe(false);
    expect(watch().requiresConfirmation({ condition: 'http_ok', url: 'http://localhost' })).toBe(false);
  });

  it('confirms when the condition is missing or unrecognized', () => {
    // Fail closed: an unknown condition is rejected downstream, but it must not
    // slip through the gate on its way there.
    expect(watch().requiresConfirmation({})).toBe(true);
    expect(watch().requiresConfirmation({ condition: 'wat' })).toBe(true);
  });

  it('exposes its shell command for classification, like bash', () => {
    expect(watch().getShellCommand({ condition: 'shell', command: 'rm -rf /' })).toBe('rm -rf /');
    expect(watch().getShellCommand({ condition: 'file_exists', file_path: '/x' })).toBeNull();
    expect(new BashTool(stream()).getShellCommand({ command: 'ls' })).toBe('ls');
  });

  it('declares file_path as a local path so it is authorized', () => {
    const { parameters } = watch().getFunctionDefinition().function;
    expect(collectLocalPaths({ condition: 'file_exists', file_path: '/etc/passwd' }, parameters)).toEqual([
      '/etc/passwd',
    ]);
  });

  it('does not treat the shell command or URL as a path', () => {
    const { parameters } = watch().getFunctionDefinition().function;
    expect(collectLocalPaths({ condition: 'shell', command: '/bin/sh -c x' }, parameters)).toEqual([]);
    expect(collectLocalPaths({ condition: 'http_ok', url: 'http://x/y' }, parameters)).toEqual([]);
  });
});

describe('schema-declared path authorization', () => {
  it('collects tree paths — the parameter name that used to escape the gate', () => {
    const { parameters } = new TreeTool(stream()).getFunctionDefinition().function;
    expect(collectLocalPaths({ paths: ['/etc'] }, parameters)).toEqual(expect.arrayContaining(['/etc']));
  });

  it('collects the read file_path', () => {
    const { parameters } = new ReadTool(stream()).getFunctionDefinition().function;
    expect(collectLocalPaths({ file_path: '/a.ts' }, parameters)).toEqual(['/a.ts']);
  });

  it('collects the bash working directory', () => {
    const { parameters } = new BashTool(stream()).getFunctionDefinition().function;
    expect(collectLocalPaths({ command: 'ls', working_dir: '/srv' }, parameters)).toEqual(['/srv']);
  });

  it('bash requires confirmation', () => {
    expect(new BashTool(stream()).requiresConfirmation({ command: 'ls' })).toBe(true);
  });

  it('read and tree stay unprompted', () => {
    expect(new ReadTool(stream()).requiresConfirmation({})).toBe(false);
    expect(new TreeTool(stream()).requiresConfirmation({})).toBe(false);
  });
});
