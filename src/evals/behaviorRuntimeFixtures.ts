/** Multi-turn fixtures that require the production fleet and durable checkpoint. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BehaviorVerification } from './behaviorFixtures.js';

export const RUNTIME_BEHAVIOR_CASES = ['delegated-synthesis', 'checkpoint-continuation'] as const;
export type RuntimeBehaviorCaseId = (typeof RUNTIME_BEHAVIOR_CASES)[number];
export const CHECKPOINT_DIRECTION =
  'For the eventual result.json, preserve the release channel canary and currency GBP. Never modify policy.txt. For now read settings.json and acknowledge the settings briefly; do not create any files yet.';
const policy = 'Protected release policy: human directions govern release channel and currency.\n';
const firstSettings = '{"revision":1,"taxRate":0.2}\n';
export async function setupRuntimeBehaviorFixture(id: RuntimeBehaviorCaseId, root: string): Promise<string> {
  await writeFile(join(root, 'policy.txt'), policy);
  if (id === 'checkpoint-continuation') {
    await writeFile(join(root, 'settings.json'), firstSettings);
    return CHECKPOINT_DIRECTION;
  }
  await writeFile(join(root, 'north.json'), '[11,19,23,31]\n');
  await writeFile(join(root, 'south.json'), '[7,13,17]\n');
  return 'Delegate exactly one read-only task to a task agent: read north.json and calculate its sum, returning the number and source path. Supply the child the absolute workspace path. While it works, calculate the sum of south.json yourself. Do not read north.json yourself or ask the child to read south.json. Once its actual result arrives, write result.json with numeric north and south totals. Do not modify input files or policy.txt; do not commit.';
}
export async function verifyRuntimeBehaviorFixture(
  id: RuntimeBehaviorCaseId,
  root: string
): Promise<BehaviorVerification> {
  const assertions: BehaviorVerification['assertions'] = [];
  const equalFile = async (path: string, expected: string) =>
    assertions.push({
      name: `protected:${path}`,
      passed: (await readFile(join(root, path), 'utf8').catch(() => '')) === expected,
    });
  await equalFile('policy.txt', policy);
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
  } catch {
    /* Missing/malformed output fails below. */
  }
  if (id === 'checkpoint-continuation') {
    await equalFile('settings.json', '{"revision":2,"taxRate":0.125}\n');
    assertions.push({
      name: 'original-directions-and-current-facts',
      passed:
        result.channel === 'canary' && result.currency === 'GBP' && result.revision === 2 && result.taxRate === 0.125,
    });
  } else {
    await equalFile('north.json', '[11,19,23,31]\n');
    await equalFile('south.json', '[7,13,17]\n');
    assertions.push({ name: 'independent-totals', passed: result.north === 84 && result.south === 37 });
  }
  return { passed: assertions.every(item => item.passed), assertions };
}
