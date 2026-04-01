/**
 * Tests for ToolManager plugin cache consistency
 *
 * These tests verify that the function definitions cache correctly
 * accounts for plugin enabled/disabled state changes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolManager } from '@tools/ToolManager.js';
import { BaseTool } from '@tools/BaseTool.js';
import { ToolResult } from '@shared/index.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';

// Mock plugin tool (pluginName must use "plugin:" prefix for marketplace plugins)
class PluginToolA extends BaseTool {
  readonly name = 'plugin-tool-a';
  readonly description = 'A tool from plugin A';
  readonly requiresConfirmation = false;
  readonly pluginName = 'plugin:plugin-a';

  protected async executeImpl(_args: any): Promise<ToolResult> {
    return this.formatSuccessResponse({ result: 'plugin A executed' });
  }
}

class PluginToolB extends BaseTool {
  readonly name = 'plugin-tool-b';
  readonly description = 'A tool from plugin B';
  readonly requiresConfirmation = false;
  readonly pluginName = 'plugin:plugin-b';

  protected async executeImpl(_args: any): Promise<ToolResult> {
    return this.formatSuccessResponse({ result: 'plugin B executed' });
  }
}

class CoreTool extends BaseTool {
  readonly name = 'core-tool';
  readonly description = 'A core tool';
  readonly requiresConfirmation = false;

  protected async executeImpl(_args: any): Promise<ToolResult> {
    return this.formatSuccessResponse({ result: 'core executed' });
  }
}

// Mock PluginManager that controls enabled state
class MockPluginManager {
  private enabled: Map<string, boolean> = new Map();

  enable(pluginName: string): void {
    this.enabled.set(pluginName, true);
  }

  disable(pluginName: string): void {
    this.enabled.set(pluginName, false);
  }

  getEnabledPlugins(): Array<{ pluginName: string }> {
    const result: Array<{ pluginName: string }> = [];
    for (const [name, isEnabled] of this.enabled) {
      if (isEnabled) result.push({ pluginName: name });
    }
    return result;
  }

  isPluginEnabled(pluginName: string): boolean {
    return this.enabled.get(pluginName) ?? false;
  }
}

describe('ToolManager - Plugin Cache Consistency', () => {
  let activityStream: ActivityStream;
  let pluginToolA: PluginToolA;
  let pluginToolB: PluginToolB;
  let coreTool: CoreTool;
  let toolManager: ToolManager;
  let mockPluginManager: MockPluginManager;
  let registry: ServiceRegistry;

  beforeEach(() => {
    activityStream = new ActivityStream();
    pluginToolA = new PluginToolA(activityStream);
    pluginToolB = new PluginToolB(activityStream);
    coreTool = new CoreTool(activityStream);
    toolManager = new ToolManager([pluginToolA, pluginToolB, coreTool]);

    mockPluginManager = new MockPluginManager();
    registry = ServiceRegistry.getInstance();
    registry.registerInstance('plugin_manager', mockPluginManager);
  });

  afterEach(() => {
    registry['_services'].delete('plugin_manager');
  });

  it('should return different definitions when plugin enabled state changes', () => {
    mockPluginManager.enable('plugin-a');
    mockPluginManager.enable('plugin-b');

    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1).toHaveLength(3);
    expect(defs1.map(d => d.function.name)).toContain('plugin-tool-a');
    expect(defs1.map(d => d.function.name)).toContain('plugin-tool-b');
    expect(defs1.map(d => d.function.name)).toContain('core-tool');

    mockPluginManager.disable('plugin-a');

    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2).toHaveLength(2);
    expect(defs2.map(d => d.function.name)).not.toContain('plugin-tool-a');
    expect(defs2.map(d => d.function.name)).toContain('plugin-tool-b');
    expect(defs2.map(d => d.function.name)).toContain('core-tool');
  });

  it('should not return cached definitions with disabled plugins', () => {
    mockPluginManager.enable('plugin-a');

    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1.map(d => d.function.name)).toContain('plugin-tool-a');

    mockPluginManager.disable('plugin-a');

    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2.map(d => d.function.name)).not.toContain('plugin-tool-a');
    expect(defs2.map(d => d.function.name)).toContain('core-tool');
  });

  it('should cache separately for different activation states', () => {
    mockPluginManager.enable('plugin-a');
    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1).toHaveLength(2);

    mockPluginManager.disable('plugin-a');
    mockPluginManager.enable('plugin-b');
    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2).toHaveLength(2);
    expect(defs2.map(d => d.function.name)).toContain('plugin-tool-b');
    expect(defs2.map(d => d.function.name)).not.toContain('plugin-tool-a');

    mockPluginManager.disable('plugin-b');
    mockPluginManager.enable('plugin-a');
    const defs3 = toolManager.getFunctionDefinitions();
    expect(defs3).toHaveLength(2);
    expect(defs3.map(d => d.function.name)).toContain('plugin-tool-a');
    expect(defs3.map(d => d.function.name)).not.toContain('plugin-tool-b');
  });

  it('should always include core tools regardless of plugin state', () => {
    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1.map(d => d.function.name)).toContain('core-tool');

    mockPluginManager.enable('plugin-a');
    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2.map(d => d.function.name)).toContain('core-tool');

    mockPluginManager.enable('plugin-b');
    const defs3 = toolManager.getFunctionDefinitions();
    expect(defs3.map(d => d.function.name)).toContain('core-tool');
  });

  it('should handle excludeTools with plugin state changes', () => {
    mockPluginManager.enable('plugin-a');
    mockPluginManager.enable('plugin-b');

    const defs1 = toolManager.getFunctionDefinitions(['plugin-tool-b']);
    expect(defs1).toHaveLength(2);
    expect(defs1.map(d => d.function.name)).toContain('plugin-tool-a');
    expect(defs1.map(d => d.function.name)).not.toContain('plugin-tool-b');

    mockPluginManager.disable('plugin-a');

    const defs2 = toolManager.getFunctionDefinitions(['plugin-tool-b']);
    expect(defs2).toHaveLength(1);
    expect(defs2.map(d => d.function.name)).toContain('core-tool');
  });

  it('should invalidate cache when tools are registered/unregistered', () => {
    mockPluginManager.enable('plugin-a');

    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1).toHaveLength(2);

    const newTool = new CoreTool(activityStream);
    (newTool as any).name = 'new-core-tool';
    toolManager.registerTool(newTool);

    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2).toHaveLength(3);
    expect(defs2.map(d => d.function.name)).toContain('new-core-tool');

    toolManager.unregisterTool('new-core-tool');

    const defs3 = toolManager.getFunctionDefinitions();
    expect(defs3).toHaveLength(2);
    expect(defs3.map(d => d.function.name)).not.toContain('new-core-tool');
  });

  it('should handle state changes between multiple plugin combinations', () => {
    mockPluginManager.enable('plugin-a');
    mockPluginManager.enable('plugin-b');
    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1).toHaveLength(3);
    expect(defs1.map(d => d.function.name)).toEqual(
      expect.arrayContaining(['plugin-tool-a', 'plugin-tool-b', 'core-tool'])
    );

    mockPluginManager.disable('plugin-a');

    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2).toHaveLength(2);
    expect(defs2.map(d => d.function.name)).toEqual(
      expect.arrayContaining(['plugin-tool-b', 'core-tool'])
    );
    expect(defs2.map(d => d.function.name)).not.toContain('plugin-tool-a');
  });
});
