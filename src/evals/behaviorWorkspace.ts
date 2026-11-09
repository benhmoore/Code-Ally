/** Extra fixture confinement; deliberately separate from production authorization. */
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { resolvePath } from '../utils/pathUtils.js';
import type { BaseTool } from '../tools/BaseTool.js';

export async function assertFixturePath(workspace: string, value: string): Promise<void> {
  const root = await realpath(workspace);
  let target = resolve(resolvePath(value, root));
  const inside = (path: string) => {
    const difference = relative(root, path);
    return (
      difference !== '..' && !difference.startsWith('../') && !difference.startsWith('..\\') && !isAbsolute(difference)
    );
  };
  if (!inside(target)) throw new Error('Evaluation path is outside the fixture workspace');
  // Existing symlinks and nearest-existing parents must resolve inside too.
  for (;;) {
    try {
      if (!inside(await realpath(target))) throw new Error('Evaluation path resolves outside the fixture workspace');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(target);
      if (parent === target) throw error;
      target = parent;
    }
  }
}

export function confineFixtureTools(tools: BaseTool[], workspace: string): void {
  const guard = async (args: Record<string, unknown>, toolName: string) => {
    for (const key of [
      'file_path',
      'path',
      'working_dir',
      'paths',
      'context_files',
      ...(toolName === 'glob' ? ['patterns'] : []),
    ]) {
      const values = Array.isArray(args[key]) ? (args[key] as unknown[]) : [args[key]];
      for (const value of values) if (typeof value === 'string') await assertFixturePath(workspace, value);
    }
  };
  for (const tool of tools) {
    const execute = tool.execute.bind(tool);
    const validate = tool.validateBeforePermission.bind(tool);
    tool.execute = async (args, ...rest) => {
      await guard(args, tool.name);
      return execute(args, ...rest);
    };
    tool.validateBeforePermission = async (args, ...rest) => {
      await guard(args, tool.name);
      return validate(args, ...rest);
    };
  }
}
