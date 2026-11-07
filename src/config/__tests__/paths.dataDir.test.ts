import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

describe('application data directory', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('uses an explicit application directory for hermetic headless runs', async () => {
    vi.stubEnv('ALLY_DATA_DIR', '/tmp/ally-isolated-data');
    vi.resetModules();
    const { ALLY_HOME } = await import('../paths.js');
    expect(ALLY_HOME).toBe(resolve('/tmp/ally-isolated-data'));
  });

  it('keeps the standard user directory when no override is set', async () => {
    vi.stubEnv('ALLY_DATA_DIR', '');
    vi.resetModules();
    const { ALLY_HOME } = await import('../paths.js');
    expect(ALLY_HOME).toBe(join(homedir(), '.ally'));
  });
});
