import { describe, expect, it } from 'vitest';
import { TrustManager } from '../TrustManager.js';
import { PolicyDeniedError } from '../../security/PathSecurity.js';

describe('non-strict run authorization policy', () => {
  it('pre-approves an allowed tool without prompting', async () => {
    const manager = new TrustManager(false);
    manager.setRunAuthorizationPolicy({ allowed_tools: ['Read', 'write'] });

    await expect(manager.checkPermission('read', {}, 'a.txt')).resolves.toBe(true);
    await expect(manager.checkPermission('write', {}, 'a.txt')).resolves.toBe(true);
  });

  it('denies a disallowed tool even under auto-confirm', async () => {
    const manager = new TrustManager(true);
    manager.setRunAuthorizationPolicy({ disallowed_tools: ['mcp__github__*'] });

    await expect(manager.checkPermission('mcp-github-create-issue', {}))
      .rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('denies a disallowed tool that is also allowed', async () => {
    const manager = new TrustManager(false);
    manager.setRunAuthorizationPolicy({ allowed_tools: ['bash'], disallowed_tools: ['bash'] });

    await expect(manager.checkPermission('bash', { command: 'ls' }, { command: 'ls' }))
      .rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('falls through to auto-confirm for an unnamed tool', async () => {
    const manager = new TrustManager(true);
    manager.setRunAuthorizationPolicy({ allowed_tools: ['read'] });

    await expect(manager.checkPermission('write', {}, 'a.txt')).resolves.toBe(true);
  });

  it('falls through to auto-allow mode for an unnamed tool', async () => {
    const manager = new TrustManager(false, undefined, () => true);
    manager.setRunAuthorizationPolicy({ allowed_tools: ['read'] });

    await expect(manager.checkPermission('write', {}, 'a.txt')).resolves.toBe(true);
    await expect(manager.checkPermission('bash', { command: 'rm -rf /' }, { command: 'rm -rf /' }))
      .rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('falls through to the interaction check when nothing else grants', async () => {
    const manager = new TrustManager(false);
    manager.setRunAuthorizationPolicy({ allowed_tools: ['read'] });
    manager.setRunPolicyManager({ isInteractionAvailable: () => false } as never);

    await expect(manager.checkPermission('write', {}, 'a.txt'))
      .rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('reports its disallowed globs for schema exclusion', () => {
    const manager = new TrustManager(false);
    expect(manager.getDisallowedToolPatterns()).toEqual([]);

    manager.setRunAuthorizationPolicy({ disallowed_tools: ['bash'] });
    expect(manager.getDisallowedToolPatterns()).toEqual(['bash']);
  });
});

describe('strict run authorization policy', () => {
  it('denies an unnamed tool even under auto-confirm', async () => {
    const manager = new TrustManager(true);
    manager.setScheduledPermissionPolicy({ allowed_tools: ['read'] });

    await expect(manager.checkPermission('write', {}, 'a.txt'))
      .rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(manager.checkPermission('read', {}, 'a.txt')).resolves.toBe(true);
  });

  it('denies an unnamed shell command even under auto-allow mode', async () => {
    const manager = new TrustManager(false, undefined, () => true);
    manager.setScheduledPermissionPolicy({
      allowed_bash_commands: [{ match: 'exact', value: 'git status' }],
    });

    await expect(manager.checkPermission('bash', { command: 'ls' }, { command: 'ls' }))
      .rejects.toBeInstanceOf(PolicyDeniedError);
  });
});
