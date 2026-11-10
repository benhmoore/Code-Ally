/** Offline integration across actual Auto eligibility, review, scoped observation, and edit publication. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApplyPatchTool } from '../../tools/ApplyPatchTool.js';
import { ReadTool } from '../../tools/ReadTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ReadStateManager } from '../../services/ReadStateManager.js';
import { PermissionPolicyService } from '../../services/PermissionPolicyService.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { permissionReadinessProbeKind } from '../PermissionReviewRequest.js';

const registry = ServiceRegistry.getInstance();
let root: string, file: string, service: PermissionPolicyService;
let mutateDuringReview = false;
const reviewed: Record<string, any>[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ally-auto-unified-'));
  file = join(root, 'source.js');
  await writeFile(file, 'export const count = 1;\n');
  registry['_services'].clear();
  registry['_descriptors'].clear();
  registry.registerInstance('read_state_manager', new ReadStateManager());
  mutateDuringReview = false;
  reviewed.length = 0;
  service = new PermissionPolicyService(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const probe = permissionReadinessProbeKind(body);
    if (!probe) {
      reviewed.push(body);
      if (mutateDuringReview) await writeFile(file, 'external author\n');
    }
    const choice = probe === 'negative' ? 'deny' : 'allow';
    return Response.json({
      answers: {
        permission: {
          type: 'choice',
          choice,
          probabilities: { allow: choice === 'allow' ? 1 : 0, ask: 0, deny: choice === 'deny' ? 1 : 0 },
        },
      },
    });
  });
  service.configure({
    ...DEFAULT_CONFIG,
    endpoint: 'http://offline',
    reviewer_model: 'offline-reviewer',
    permission_mode: 'auto',
  });
  await service.refresh();
});
afterEach(async () => {
  await service.cleanup();
  registry['_services'].clear();
  registry['_descriptors'].clear();
  await rm(root, { recursive: true, force: true });
});
const patch = '@@ -1,1 +1,1 @@\n-export const count = 1;\n+export const count = 2;\n';
const input = () => ({
  toolName: 'apply-patch',
  args: { file_path: file, patch },
  workspaceRoot: root,
  task: 'Change source.js count from 1 to 2.',
});
it('reviews original valid unified arguments after real scoped observation and preserves final CAS', async () => {
  const stream = new ActivityStream(),
    tool = new ApplyPatchTool(stream),
    action = input(),
    context = { agentId: 'editor' };
  expect((await tool.validateBeforePermission(action.args, context))?.success).toBe(false);
  tool.releasePreparedInvocation(action.args);
  expect(
    (await new ReadTool(stream).execute({ file_path: file }, undefined, undefined, false, false, context)).success
  ).toBe(true);
  expect(await tool.validateBeforePermission(action.args, context)).toBeNull();
  await tool.runPreview(action.args, 'reviewed-edit', context);
  expect(await service.evaluate(action)).toMatchObject({ verdict: 'allow', source: 'reviewer' });
  expect(reviewed[0].state.proposed_action.arguments).toEqual(action.args);
  expect(reviewed[0].state.proposed_action.arguments).not.toHaveProperty('old_text');
  await writeFile(file, 'external author\n');
  const result = await tool.execute(action.args, undefined, undefined, false, false, context);
  expect(result.success).toBe(false);
  expect(result.error).toContain('File changed');
  expect(await readFile(file, 'utf8')).toBe('external author\n');
});
it('abstains when the exact patch target changes during model review', async () => {
  mutateDuringReview = true;
  expect(await service.evaluate(input())).toMatchObject({
    verdict: 'ask',
    reason: expect.stringContaining('target changed'),
  });
  expect(await readFile(file, 'utf8')).toBe('external author\n');
});

it.each([Buffer.from([0xff]), Buffer.from([0])])(
  'does not send invalid target text for model review: %j',
  async invalid => {
    const external = Buffer.concat([Buffer.from('export const count = 1;\n'), invalid]);
    await writeFile(file, external);
    expect(await service.evaluate(input())).toMatchObject({ verdict: 'ask', source: 'policy' });
    expect(reviewed).toHaveLength(0);
    expect(await readFile(file)).toEqual(external);
  }
);
