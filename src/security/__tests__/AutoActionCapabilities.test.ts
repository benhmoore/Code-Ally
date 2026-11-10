import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { classifyAutoAction } from '../AutoActionPolicy.js';
import { ToolCapability as C } from '../../tools/ToolCapability.js';

let directory: string;
let root: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'ally-capability-permission-'));
  root = path.join(directory, 'workspace');
  await mkdir(root);
  await writeFile(path.join(root, 'source.ts'), 'existing');
  await writeFile(path.join(directory, 'outside.txt'), 'outside');
  await symlink(directory, path.join(root, 'escape'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.each([[], [C.AppStateWrite], [C.FsRead], [C.FsRead, C.AppStateWrite]].map(capabilities => ({ capabilities })))(
  'admits declared baseline capabilities $capabilities within canonical workspace',
  async ({ capabilities }) => {
    expect(
      (
        await classifyAutoAction({
          toolName: 'generic',
          args: {},
          workspaceRoot: root,
          toolMetadata: { capabilities, localPaths: ['source.ts'] },
        })
      ).kind
    ).toBe('allow');
  }
);

it.each([C.Network, C.RemoteEffect, C.ShellExec, C.ProcessControl, C.FsWrite])(
  'does not admit unbounded generic %s effects',
  async capability => {
    expect(
      (
        await classifyAutoAction({
          toolName: 'generic',
          args: {},
          workspaceRoot: root,
          toolMetadata: { capabilities: [capability], localPaths: [] },
        })
      ).kind
    ).toBe('ask');
  }
);

it('does not infer safe metadata from a legacy name or model arguments', async () => {
  for (const toolName of ['agent', 'ask-user-question', 'read-history', 'unknown']) {
    expect(
      (
        await classifyAutoAction({
          toolName,
          workspaceRoot: root,
          args: { toolMetadata: { capabilities: [], localPaths: [] } },
        })
      ).kind
    ).toBe('ask');
  }
});

it('retains builtin read and edit boundaries despite incorrect safe metadata', async () => {
  const toolMetadata = { capabilities: [], localPaths: [] };
  expect(
    (
      await classifyAutoAction({
        toolName: 'read',
        args: { file_path: '../outside.txt' },
        workspaceRoot: root,
        toolMetadata,
      })
    ).kind
  ).toBe('ask');
  expect(
    (
      await classifyAutoAction({
        toolName: 'write',
        args: { file_path: 'new.ts', content: 'new' },
        workspaceRoot: root,
        toolMetadata,
      })
    ).kind
  ).toBe('review');
  expect(
    (
      await classifyAutoAction({
        toolName: 'apply-patch',
        args: { file_path: 'source.ts', old_text: 'old', new_text: 'new' },
        workspaceRoot: root,
        toolMetadata,
      })
    ).kind
  ).toBe('review');
});

it.each(['../outside.txt', 'escape/outside.txt'])(
  'asks for declared generic read target %s outside canonical root',
  async localPath => {
    expect(
      (
        await classifyAutoAction({
          toolName: 'generic',
          args: {},
          workspaceRoot: root,
          toolMetadata: { capabilities: [C.FsRead], localPaths: [localPath] },
        })
      ).kind
    ).toBe('ask');
  }
);
