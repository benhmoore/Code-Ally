import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ToolSearchTool } from '@tools/ToolSearchTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ToolActivationRegistry } from '@services/ToolActivationRegistry.js';
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
    // The full schema must come back, so the model can call it immediately.
    expect(result.content).toContain('"parameters"');
    expect(activations.get('agent-a')).toContain('chrome_take_screenshot');
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
