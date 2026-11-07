import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrustManager } from '../../agent/TrustManager.js';
import { getProjectSessionsDir } from '../../config/paths.js';
import { PermissionManager } from '../PermissionManager.js';
import { PolicyDeniedError } from '../PathSecurity.js';
import type { BaseTool } from '../../tools/BaseTool.js';
import { ToolCapability } from '../../tools/ToolCapability.js';

const shellTool = {
  capabilitiesFor: () => [ToolCapability.ShellExec],
  getFunctionDefinition: () => ({ function: { parameters: { type: 'object', properties: {} } } }),
  requiresConfirmation: () => true,
  getShellCommand: (args: Record<string, unknown>) => String(args.command),
} as BaseTool;

describe('PermissionManager shell resources', () => {
  it('allows a read-only pipeline over a project-owned session artifact in Allow-all mode', async () => {
    const trust = new TrustManager('manual');
    trust.setPermissionMode('allow-all');
    const manager = new PermissionManager(trust);
    const artifact = path.join(getProjectSessionsDir(), 'session', 'tool-results', 'call.txt');

    await expect(manager.checkPermission('bash', {
      command: `grep -E "Test Files|FAIL" ${artifact} | tail -30`,
      working_dir: process.cwd(),
    }, shellTool)).resolves.toBe(true);
  });

  it('does not authorize a pipeline that reads an unapproved absolute path', async () => {
    const trust = new TrustManager('manual');
    trust.setPermissionMode('allow-all');
    const manager = new PermissionManager(trust);

    await expect(manager.checkPermission('bash', {
      command: 'grep root /etc/passwd | tail -5',
      working_dir: process.cwd(),
    }, shellTool)).rejects.toBeInstanceOf(PolicyDeniedError);
  });
});
