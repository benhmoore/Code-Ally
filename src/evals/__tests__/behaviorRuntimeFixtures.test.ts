import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setupRuntimeBehaviorFixture, verifyRuntimeBehaviorFixture } from '../behaviorRuntimeFixtures.js';

const roots: string[] = [];
const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), 'ally-runtime-case-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
describe('runtime behavior verification', () => {
  it('requires delegated totals and preserved inputs, not a completion claim', async () => {
    const root = await workspace();
    await setupRuntimeBehaviorFixture('delegated-synthesis', root);
    expect((await verifyRuntimeBehaviorFixture('delegated-synthesis', root)).passed).toBe(false);
    await writeFile(join(root, 'result.json'), JSON.stringify({ north: 84, south: 37 }));
    expect((await verifyRuntimeBehaviorFixture('delegated-synthesis', root)).passed).toBe(true);
    await writeFile(join(root, 'north.json'), '[]');
    expect((await verifyRuntimeBehaviorFixture('delegated-synthesis', root)).passed).toBe(false);
  });
  it('rejects stale facts and detects protected policy changes after a checkpoint', async () => {
    const root = await workspace();
    await setupRuntimeBehaviorFixture('checkpoint-continuation', root);
    const policy = await readFile(join(root, 'policy.txt'), 'utf8');
    await writeFile(join(root, 'settings.json'), '{"revision":2,"taxRate":0.125}\n');
    await writeFile(
      join(root, 'result.json'),
      JSON.stringify({ channel: 'canary', currency: 'GBP', revision: 1, taxRate: 0.2 })
    );
    expect((await verifyRuntimeBehaviorFixture('checkpoint-continuation', root)).passed).toBe(false);
    await writeFile(
      join(root, 'result.json'),
      JSON.stringify({ channel: 'canary', currency: 'GBP', revision: 2, taxRate: 0.125 })
    );
    expect((await verifyRuntimeBehaviorFixture('checkpoint-continuation', root)).passed).toBe(true);
    await writeFile(join(root, 'policy.txt'), policy + 'Changed');
    expect((await verifyRuntimeBehaviorFixture('checkpoint-continuation', root)).passed).toBe(false);
  });
});
