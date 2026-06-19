import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { AgentManager } from '../AgentManager.js';
import { serializeAgent } from '../../utils/agentContentUtils.js';
import type { AgentData } from '../../types/agents.js';

describe('AgentManager.loadPluginAgents', () => {
  let installPath: string;
  let agentsDir: string;
  let manager: AgentManager;

  beforeEach(async () => {
    installPath = await mkdtemp(join(tmpdir(), 'ally-plugin-'));
    agentsDir = join(installPath, 'agents');
    manager = new AgentManager();
  });

  afterEach(async () => {
    await rm(installPath, { recursive: true, force: true });
  });

  async function writePluginAgent(agent: AgentData): Promise<void> {
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, `${agent.name}.md`), serializeAgent(agent), 'utf-8');
  }

  it('discovers and registers agents shipped in a plugin', async () => {
    await writePluginAgent({
      name: 'plugin-helper',
      description: 'A helper from a plugin',
      system_prompt: 'You help.',
    });

    await manager.loadPluginAgents(installPath, 'my-plugin');

    const loaded = await manager.loadAgent('plugin-helper');
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe('plugin-helper');
    expect(loaded?._pluginName).toBe('my-plugin');

    const listed = await manager.listAgents();
    const entry = listed.find(a => a.name === 'plugin-helper');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('plugin');
    expect(entry?.pluginName).toBe('my-plugin');
  });

  it('is a no-op when the plugin ships no agents directory', async () => {
    await expect(manager.loadPluginAgents(installPath, 'empty-plugin')).resolves.toBeUndefined();
    const listed = await manager.listAgents();
    expect(listed.find(a => a.source === 'plugin')).toBeUndefined();
  });

  it('skips malformed agent files without throwing and still loads valid ones', async () => {
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'broken.md'), 'no frontmatter here', 'utf-8');
    await writePluginAgent({
      name: 'good-agent',
      description: 'Valid',
      system_prompt: 'Valid prompt.',
    });

    await manager.loadPluginAgents(installPath, 'mixed-plugin');

    expect(await manager.loadAgent('good-agent')).not.toBeNull();
    expect(await manager.loadAgent('broken')).toBeNull();
  });
});
