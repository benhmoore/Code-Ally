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
});
