import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ToolSearchTool } from '@tools/ToolSearchTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ToolActivationRegistry } from '@services/ToolActivationRegistry.js';
import { selectRuntimeToolSurface } from '../runtimeToolSelection.js';
import type { FunctionDefinition } from '../../types/index.js';

function definition(name: string, description: string): FunctionDefinition {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: {} } },
  } as FunctionDefinition;
}

const CATALOGUE = [
  definition('read', 'Read one or more files.'),
  definition('web-fetch', 'Fetch and extract content from a URL.'),
  definition('chrome_take_screenshot', 'Capture a screenshot of the current browser page.'),
  definition('chrome_navigate_page', 'Navigate the browser to a URL.'),
];

describe('ToolSearchTool', () => {
  let tool: ToolSearchTool;
  let registry: ServiceRegistry;
  let activations: ToolActivationRegistry;

  beforeEach(() => {
    registry = ServiceRegistry.getInstance();
    registry['_services'].clear();
    registry['_descriptors'].clear();
    activations = new ToolActivationRegistry();
    registry.registerInstance('tool_activation_registry', activations);
    activations.setAvailable('agent-a', () => CATALOGUE);
    registry.registerInstance('tool_manager', {
      getFunctionDefinitions: () => CATALOGUE,
    } as any);
    tool = new ToolSearchTool(new ActivityStream());
  });

  afterEach(() => {
    registry['_services'].clear();
    registry['_descriptors'].clear();
  });

  it('loads an exact tool by name and marks it active', async () => {
    const result = await tool.execute(
      { query: 'select:chrome_take_screenshot' }, 'call-1', undefined, false, false, { agentId: 'agent-a' },
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('chrome_take_screenshot');
    // The native schema is sent on the next request; conversation content stays compact.
    expect(result.content).not.toContain('"parameters"');
    expect(activations.get('agent-a')).toContain('chrome_take_screenshot');
    expect(activations.getRequested('agent-a')).toEqual(['chrome_take_screenshot']);
  });

  it('uses the owner-published visibility instead of searching the unrestricted manager', async () => {
    activations.setAvailable('agent-a', () => [CATALOGUE[0]!]);
    const result = await tool.execute({ query: 'select:web-fetch' }, 'call-1', undefined, false, false,
      { agentId: 'agent-a', agentName: 'researcher' });
    expect(result.success).toBe(false);
    expect(result.suggestion).not.toContain('web-fetch');
    expect(activations.getRequested('agent-a')).toEqual([]);
  });

  it('caps exact-name selection just like keyword searches', async () => {
    const result = await tool.execute({ query: 'select:web-fetch,chrome_take_screenshot', max_results: 1 },
      'call-1', undefined, false, false, { agentId: 'agent-a' });
    expect(result.success).toBe(true);
    expect(activations.getRequested('agent-a')).toEqual(['web-fetch']);
  });

  it('does not report success before the owner publishes an eligible surface', async () => {
    const result = await tool.execute({ query: 'select:read' }, 'call-1', undefined, false, false, { agentId: 'unpublished' });
    expect(result.success).toBe(false);
    expect(activations.getRequested('unpublished')).toEqual([]);
  });

  it('loads capabilities omitted by relevance without loading forbidden or unavailable tools', async () => {
    const definitions = ['read', 'tool-search', 'scheduled-tasks', 'read-history', 'forbidden']
      .map(name => definition(name, name));
    const select = () => selectRuntimeToolSurface({ definitions,
      context: { planModeActive: false, latestUserText: 'Run npm test after 30 minutes' },
      schemaBudget: 100, estimateTokens: text => text.length,
      requested: activations.getRequested('agent-a'), disallowed: ['forbidden'],
    });
    const initial = select();
    activations.setAvailable('agent-a', () => select().eligible);
    expect(initial.exposed.map(item => item.function.name)).not.toContain('scheduled-tasks');
    expect((await tool.execute({ query: 'select:scheduled-tasks' }, 'call-1', undefined, false, false, { agentId: 'agent-a' })).success).toBe(true);
    expect(select().exposed.map(item => item.function.name)).toContain('scheduled-tasks');
    for (const unavailable of ['read-history', 'forbidden']) {
      const result = await tool.execute({ query: `select:${unavailable}` }, 'call-2', undefined, false, false, { agentId: 'agent-a' });
      expect(result.success).toBe(false);
      expect(result.suggestion).not.toContain(unavailable);
    }
  });

  it('refreshes eligibility after policy changes and releases the owner resolver on cleanup', async () => {
    let permitted = CATALOGUE;
    activations.setAvailable('agent-a', () => permitted);
    const execute = () => tool.execute({ query: 'select:web-fetch' }, 'call', undefined, false, false, { agentId: 'agent-a' });
    expect((await execute()).success).toBe(true);
    permitted = [CATALOGUE[0]!];
    expect((await execute()).success).toBe(false);
    activations.clear('agent-a');
    expect(activations.getAvailable('agent-a')).toBeUndefined();
    expect(activations.get('agent-a')).toEqual([]);
    expect(activations.getRequested('agent-a')).toEqual([]);
    expect((await execute()).success).toBe(false);
  });

  it('enforces the hard result ceiling for explicit lists', async () => {
    const definitions = Array.from({ length: 30 }, (_, index) => definition(`tool-${index}`, 'A tool'));
    activations.setAvailable('agent-a', () => definitions);
    const result = await tool.execute({ query: `select:${definitions.map(item => item.function.name).join(',')}`, max_results: 100 },
      'call', undefined, false, false, { agentId: 'agent-a' });
    expect(result.success).toBe(true);
    expect(activations.getRequested('agent-a')).toHaveLength(15);
  });

  it('finds tools by keyword when the exact name is unknown', async () => {
    const result = await tool.execute(
      { query: 'browser screenshot' }, 'call-1', undefined, false, false, { agentId: 'agent-a' },
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('chrome_take_screenshot');
    expect(activations.get('agent-a')).toContain('chrome_take_screenshot');
  });

  it('loads several tools at once for a multi-step integration', async () => {
    const result = await tool.execute(
      { query: 'select:chrome_navigate_page,chrome_take_screenshot' },
      'call-1', undefined, false, false, { agentId: 'agent-a' },
    );

    expect(result.success).toBe(true);
    expect(activations.get('agent-a')).toEqual(
      expect.arrayContaining(['chrome_navigate_page', 'chrome_take_screenshot']),
    );
    expect(activations.getRequested('agent-a')).toEqual([
      'chrome_take_screenshot',
      'chrome_navigate_page',
    ]);
  });

  it('activates per agent so a delegate never alters its parent surface', async () => {
    await tool.execute(
      { query: 'select:web-fetch' }, 'call-1', undefined, false, false, { agentId: 'agent-a' },
    );

    expect(activations.get('agent-a')).toContain('web-fetch');
    expect(activations.get('agent-b')).toEqual([]);
  });

  it('reports the available surface when nothing matches', async () => {
    const result = await tool.execute(
      { query: 'nonexistent-capability' }, 'call-1', undefined, false, false, { agentId: 'agent-a' },
    );

    expect(result.success).toBe(false);
    // The caller must be able to recover, so list what does exist.
    expect(result.suggestion).toContain('chrome_take_screenshot');
    expect(activations.get('agent-a')).toEqual([]);
  });

  it('rejects an empty query with a usable example', async () => {
    const result = await tool.execute(
      { query: '   ' }, 'call-1', undefined, false, false, { agentId: 'agent-a' },
    );

    expect(result.success).toBe(false);
    expect(result.suggestion).toContain('select:');
  });
});
