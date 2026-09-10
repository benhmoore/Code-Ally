import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EditAgentTool } from '../EditAgentTool.js';
import { WriteAgentTool } from '../WriteAgentTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ReadStateManager } from '../../services/ReadStateManager.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import type { AgentManager } from '../../services/AgentManager.js';
import type { AgentData } from '../../types/agents.js';
import { serializeAgent } from '../../utils/agentContentUtils.js';

describe('agent file observation evidence', () => {
  let directory: string;
  let registry: ServiceRegistry;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ally-agent-evidence-'));
    registry = ServiceRegistry.getInstance();
    registry['_services'].clear();
    registry['_descriptors'].clear();
  });

  afterEach(async () => {
    registry['_services'].clear();
    registry['_descriptors'].clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(['create', 'edit'] as const)('%s does not authorize generated source absent from the result', async mode => {
    const file = path.join(directory, 'reviewer.md');
    const original: AgentData = {
      name: 'reviewer', description: 'Original description', system_prompt: 'Unobserved retained instructions',
    };
    if (mode === 'edit') await fs.writeFile(file, serializeAgent(original));
    const manager = {
      readUserAgentFile: async () => mode === 'edit' ? fs.readFile(file, 'utf8') : null,
      getAgentFilePath: () => file,
      writeAgentFile: async (agent: AgentData) => {
        const content = serializeAgent(agent);
        await fs.writeFile(file, content);
        return { filePath: file, content };
      },
    };
    registry.registerInstance('agent_manager', manager as unknown as AgentManager);
    const reads = new ReadStateManager();
    registry.registerInstance('read_state_manager', reads);
    reads.trackRead(file, 1, 1, 'editor');
    reads.trackRead(file, 1, 1, 'observer');
    const trackRead = vi.spyOn(reads, 'trackRead');
    const tool = mode === 'edit' ? new EditAgentTool(new ActivityStream()) : new WriteAgentTool(new ActivityStream());
    const result = await tool.execute({
      name: 'reviewer', description: 'Updated description',
      ...(mode === 'create' ? { system_prompt: 'New instructions' } : {}),
    }, undefined, undefined, false, false, { agentId: 'editor' });
    expect(result.success).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toContain('Updated description');
    expect(JSON.stringify(result)).not.toContain('Unobserved retained instructions');
    expect(trackRead).not.toHaveBeenCalled();
    expect(reads.getReadState(file, 'editor')).toBeNull();
    expect(reads.getReadState(file, 'observer')).toBeNull();
  });
});
