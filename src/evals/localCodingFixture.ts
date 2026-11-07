/** Deterministic inclusive-range repair fixture and independent verification. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const BUGGY_SOURCE = `export function rangeSize(start, end) {
  if (end < start) return 0;
  return end - start;
}
`;
export const VISIBLE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeSize } from './range.js';
test('counts both endpoints', () => assert.equal(rangeSize(3, 5), 3));
`;
const INDEPENDENT_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeSize } from './range.js';
test('independent range cases', () => {
  for (const [start, end, expected] of [[0,0,1],[3,5,3],[-3,-1,3],[-2,2,5],[5,3,0],[10,11,2]]) {
    assert.equal(rangeSize(start, end), expected, JSON.stringify({start,end}));
  }
});
`;

/** Write only the public task files into an existing empty workspace. */
export async function createCodingFixture(workspace: string): Promise<void> {
  await Promise.all([
    writeFile(join(workspace, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(workspace, 'range.js'), BUGGY_SOURCE),
    writeFile(join(workspace, 'range.test.js'), VISIBLE_TEST),
  ]);
}

/** Verify copied source against trusted tests outside the agent workspace. */
export async function verifyCodingFixture(workspace: string): Promise<{
  source: string; sourceChanged: boolean; testsUnchanged: boolean; independentTestsPassed: boolean; verificationOutput: string;
}> {
  const [source, visibleTest] = await Promise.all([
    readFile(join(workspace, 'range.js'), 'utf8').catch(() => ''), readFile(join(workspace, 'range.test.js'), 'utf8').catch(() => ''),
  ]);
  const verifier = await mkdtemp(join(tmpdir(), 'ally-coding-verify-'));
  try {
    await Promise.all([
      writeFile(join(verifier, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(verifier, 'range.js'), source),
      writeFile(join(verifier, 'range.test.js'), INDEPENDENT_TEST),
    ]);
    try {
      const output = await promisify(execFile)(process.execPath, ['--test'], { cwd: verifier, timeout: 10_000 });
      return { source, sourceChanged: source !== BUGGY_SOURCE, testsUnchanged: visibleTest === VISIBLE_TEST, independentTestsPassed: true, verificationOutput: output.stdout + output.stderr };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      return { source, sourceChanged: source !== BUGGY_SOURCE, testsUnchanged: visibleTest === VISIBLE_TEST, independentTestsPassed: false, verificationOutput: `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message}` };
    }
  } finally { await rm(verifier, { recursive: true, force: true }); }
}
