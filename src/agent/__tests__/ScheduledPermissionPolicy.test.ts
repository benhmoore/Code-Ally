import { describe, expect, it } from 'vitest';
import { TrustManager } from '../TrustManager.js';
import { PermissionDeniedError } from '../../security/PathSecurity.js';

describe('scheduled permission policy', () => {
  it('allows matching scheduled bash commands without prompting', async () => {
    const manager = new TrustManager(false);
    manager.setScheduledPermissionPolicy({
      allowed_bash_commands: [
        { match: 'exact', value: 'git push' },
        { match: 'prefix', value: 'npm test' },
      ],
    });

    await expect(manager.checkPermission('bash', { command: 'git push' }, { command: 'git push' })).resolves.toBe(true);
    await expect(manager.checkPermission('bash', { command: 'npm test -- --runInBand' }, { command: 'npm test -- --runInBand' })).resolves.toBe(true);
  });

  it('denies non-matching or explicitly denied scheduled bash commands', async () => {
    const manager = new TrustManager(false);
    manager.setScheduledPermissionPolicy({
      allowed_bash_commands: [{ match: 'prefix', value: 'git ' }],
      denied_bash_patterns: ['\\bgit\\s+commit\\b'],
    });

    await expect(manager.checkPermission('bash', { command: 'git commit -m x' }, { command: 'git commit -m x' }))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(manager.checkPermission('bash', { command: 'rm -rf tmp' }, { command: 'rm -rf tmp' }))
      .rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('denies sensitive non-bash tools unless explicitly allowed', async () => {
    const manager = new TrustManager(false);
    manager.setScheduledPermissionPolicy({ allowed_tools: ['write'] });

    await expect(manager.checkPermission('write', { file_path: 'a.txt' }, 'a.txt')).resolves.toBe(true);
    await expect(manager.checkPermission('edit', { file_path: 'a.txt' }, 'a.txt'))
      .rejects.toBeInstanceOf(PermissionDeniedError);
  });

  describe('allow-rule matching is exhaustive and fails closed', () => {
    it('refuses a regex allow-rule, including the catch-all .*', async () => {
      const manager = new TrustManager(false);
      manager.setScheduledPermissionPolicy({
        allowed_bash_commands: [{ match: 'regex', value: '.*' } as any],
      });

      await expect(manager.checkPermission('bash', { command: 'rm -rf /' }, { command: 'rm -rf /' }))
        .rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(manager.checkPermission('bash', { command: 'git push' }, { command: 'git push' }))
        .rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it('refuses unknown, misspelled, and missing match kinds', async () => {
      const manager = new TrustManager(false);
      manager.setScheduledPermissionPolicy({
        allowed_bash_commands: [
          { match: 'startswith', value: 'curl' } as any,
          { match: 'Exact', value: 'whoami' } as any,
          { value: 'id' } as any,
          null as any,
        ],
      });

      for (const command of ['curl http://evil', 'whoami', 'id']) {
        await expect(manager.checkPermission('bash', { command }, { command }))
          .rejects.toBeInstanceOf(PermissionDeniedError);
      }
    });

    it('still honors regex deny patterns, which fail closed', async () => {
      const manager = new TrustManager(false);
      manager.setScheduledPermissionPolicy({
        allowed_bash_commands: [{ match: 'prefix', value: 'git ' }],
        denied_bash_patterns: ['.*'],
      });

      await expect(manager.checkPermission('bash', { command: 'git status' }, { command: 'git status' }))
        .rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });
});
