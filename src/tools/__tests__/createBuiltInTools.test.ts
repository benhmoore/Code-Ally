import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { createBuiltInTools } from '../createBuiltInTools.js';
import { ToolManager } from '../ToolManager.js';

describe('createBuiltInTools', () => {
  it('is the canonical ordered runtime catalog', () => {
    const tools = createBuiltInTools(new ActivityStream(), DEFAULT_CONFIG);

    expect(tools.map(tool => tool.name)).toEqual([
      'bash', 'bash-output', 'kill-shell', 'cancel-agent', 'wait', 'watch',
      'complete-objective', 'block-objective', 'reconcile-effect', 'read', 'write',
      'write-agent', 'edit-agent', 'delete-agent', 'list-agents', 'write-temp',
      'edit', 'line-edit', 'glob', 'grep', 'ls', 'tool-search', 'tree', 'agent', 'manage-agents',
      'explore', 'plan', 'agent-ask', 'cleanup-call', 'todo-write', 'sessions',
      'lint', 'format', 'ask-user-question', 'web-fetch', 'web-search', 'research',
      'skill', 'memory', 'scheduled-tasks', 'enter-plan-mode', 'exit-plan-mode',
      'write-plan',
    ]);
  });

  it('produces the expected interactive Ally schema surface', () => {
    const manager = new ToolManager(createBuiltInTools(new ActivityStream(), DEFAULT_CONFIG));
    const definitions = manager.getFunctionDefinitions(
      ['complete-objective', 'block-objective', 'reconcile-effect'],
      'ally',
    );

    expect(definitions).toHaveLength(34);
    expect(definitions.map(definition => definition.function.name)).not.toContain('write-agent');
    expect(definitions.map(definition => definition.function.name)).toContain('memory');
  });

  it('keeps todo calls minimal by deriving display text internally', () => {
    const manager = new ToolManager(createBuiltInTools(new ActivityStream(), DEFAULT_CONFIG));
    const definition = manager.getFunctionDefinitions(undefined, 'ally')
      .find(item => item.function.name === 'todo-write');
    const item = (definition?.function.parameters.properties as any)?.todos?.items;

    expect(item?.required).toEqual(['content', 'status']);
    expect(item?.properties).not.toHaveProperty('activeForm');
  });
});
