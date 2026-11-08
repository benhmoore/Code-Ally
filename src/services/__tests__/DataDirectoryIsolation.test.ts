import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it('keeps integration and profile initialization inside the configured data directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ally data isolation '));
  try {
    const script = `
      import assert from 'node:assert/strict';
      import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
      import path from 'node:path';
      import { IntegrationStore } from './src/services/IntegrationStore.ts';
      import { ProfileManager } from './src/services/ProfileManager.ts';
      const integrations = new IntegrationStore();
      const profiles = new ProfileManager();
      const root = path.resolve(process.env.ALLY_DATA_DIR);
      assert.equal(path.dirname(integrations.getSettingsPath()), root);
      assert.equal(profiles.profilesDir, path.join(root, 'profiles'));
      const configFile = path.join(root, 'profiles/default/config.json');
      mkdirSync(path.dirname(configFile), { recursive: true });
      writeFileSync(configFile, '{"model":"preserve-fixture"}');
      await integrations.initialize();
      await integrations.saveSettings();
      await profiles.initialize();
      await profiles.initialize();
      assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).model, 'preserve-fixture');
      assert.ok(existsSync(path.join(root, 'profiles/default/profile.json')));
      assert.ok(existsSync(integrations.getSettingsPath()));
      assert.ok(existsSync(path.join(root, 'profiles', 'default')));
      console.log('isolated');
    `;
    const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, ALLY_DATA_DIR: directory },
      timeout: 15000,
    });
    expect(result.stdout).toContain('isolated');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
