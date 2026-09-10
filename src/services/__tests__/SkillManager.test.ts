import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillManager } from '../SkillManager.js';

/**
 * Skill loading, focused on the frontmatter contract. A skill is addressed by
 * its directory, and skills written for Claude Code routinely carry only a
 * description, so the directory has to be able to supply the name.
 */
describe('SkillManager plugin skill loading', () => {
  let root: string;
  let manager: SkillManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ally-skills-'));
    manager = new SkillManager(root);
    // Plugin skills reach the live map only once the manager is initialized,
    // which is the order the composition root uses.
    await manager.initialize();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function skill(dirName: string, contents: string): Promise<string> {
    const pluginRoot = join(root, 'plugin');
    const dir = join(pluginRoot, 'skills', dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), contents);
    return pluginRoot;
  }

  it('takes the name from the directory when frontmatter omits it', async () => {
    const pluginRoot = await skill(
      'triage-infra-error',
      '---\ndescription: "Runbook for unattended triage batches."\n---\n\nFollow these steps.\n'
    );
    await manager.loadPluginSkills(pluginRoot, 'guardrails');

    expect(manager.hasSkill('triage-infra-error')).toBe(true);
    expect(await manager.getSkill('triage-infra-error')).toMatchObject({
      name: 'triage-infra-error',
      description: 'Runbook for unattended triage batches.',
      instructions: 'Follow these steps.',
    });
  });

  it('lets an explicit frontmatter name win over the directory', async () => {
    const pluginRoot = await skill(
      'some-directory',
      '---\nname: preferred-name\ndescription: "Has its own name."\n---\n\nBody.\n'
    );
    await manager.loadPluginSkills(pluginRoot, 'guardrails');

    expect(manager.hasSkill('preferred-name')).toBe(true);
    expect(manager.hasSkill('some-directory')).toBe(false);
  });

  it('still requires a description', async () => {
    const pluginRoot = await skill('no-description', '---\nname: no-description\n---\n\nBody.\n');
    await manager.loadPluginSkills(pluginRoot, 'guardrails');

    expect(manager.hasSkill('no-description')).toBe(false);
  });

  it('rejects a directory name that is not a valid skill name', async () => {
    const pluginRoot = await skill('Not Kebab Case', '---\ndescription: "Bad directory name."\n---\n\nBody.\n');
    await manager.loadPluginSkills(pluginRoot, 'guardrails');

    expect(manager.hasSkill('Not Kebab Case')).toBe(false);
    expect(manager.hasSkill('not-kebab-case')).toBe(false);
  });
});
