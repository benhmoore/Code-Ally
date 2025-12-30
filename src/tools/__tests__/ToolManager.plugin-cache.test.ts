/**
 * Tests for ToolManager plugin activation cache consistency
 *
 * These tests verify that the function definitions cache correctly
 * accounts for plugin activation state changes (Phase 2.3 bug fix).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolManager } from '@tools/ToolManager.js';
import { BaseTool } from '@tools/BaseTool.js';
import { ToolResult } from '@shared/index.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';

// Mock plugin tool
class PluginToolA extends BaseTool {
  readonly name = 'plugin-tool-a';
  readonly description = 'A tool from plugin A';
  readonly requiresConfirmation = false;
  readonly pluginName = 'plugin-a'; // Mark as plugin tool

  protected async executeImpl(args: any): Promise<ToolResult> {
    return this.formatSuccessResponse({
      result: 'plugin A executed',
    });
  }
}

class PluginToolB extends BaseTool {
  readonly name = 'plugin-tool-b';
  readonly description = 'A tool from plugin B';
  readonly requiresConfirmation = false;
  readonly pluginName = 'plugin-b'; // Mark as plugin tool

  protected async executeImpl(args: any): Promise<ToolResult> {
    return this.formatSuccessResponse({
      result: 'plugin B executed',
    });
  }
}

class CoreTool extends BaseTool {
  readonly name = 'core-tool';
  readonly description = 'A core tool';
  readonly requiresConfirmation = false;
  // No pluginName - core tool

  protected async executeImpl(args: any): Promise<ToolResult> {
    return this.formatSuccessResponse({
      result: 'core executed',
    });
  }
}

// Mock PluginActivationManager
class MockPluginActivationManager {
  private activePlugins: Set<string> = new Set();

  activate(pluginName: string): void {
    this.activePlugins.add(pluginName);
  }

  deactivate(pluginName: string): void {
    this.activePlugins.delete(pluginName);
  }

  getActivePlugins(): string[] {
    return Array.from(this.activePlugins);
  }

  isActive(pluginName: string): boolean {
    return this.activePlugins.has(pluginName);
  }
}

describe('ToolManager - Plugin Cache Consistency', () => {
  let activityStream: ActivityStream;
  let pluginToolA: PluginToolA;
  let pluginToolB: PluginToolB;
  let coreTool: CoreTool;
  let toolManager: ToolManager;
  let mockActivationManager: MockPluginActivationManager;
  let registry: ServiceRegistry;

  beforeEach(() => {
    activityStream = new ActivityStream();
    pluginToolA = new PluginToolA(activityStream);
    pluginToolB = new PluginToolB(activityStream);
    coreTool = new CoreTool(activityStream);
    toolManager = new ToolManager([pluginToolA, pluginToolB, coreTool]);

    // Setup mock PluginActivationManager
    mockActivationManager = new MockPluginActivationManager();
    registry = ServiceRegistry.getInstance();
    registry.registerInstance('plugin_activation_manager', mockActivationManager);
  });

  afterEach(() => {
    // Clean up registry
    registry['_services'].delete('plugin_activation_manager');
  });

  it('should return different definitions when plugin activation changes', () => {
    // Activate both plugins initially
    mockActivationManager.activate('plugin-a');
    mockActivationManager.activate('plugin-b');

    // First call - should include both plugin tools + core tool
    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1).toHaveLength(3);
    expect(defs1.map(d => d.function.name)).toContain('plugin-tool-a');
    expect(defs1.map(d => d.function.name)).toContain('plugin-tool-b');
    expect(defs1.map(d => d.function.name)).toContain('core-tool');

    // Deactivate plugin A
    mockActivationManager.deactivate('plugin-a');

    // Second call - should NOT include plugin A tool (BUG FIX)
    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2).toHaveLength(2);
    expect(defs2.map(d => d.function.name)).not.toContain('plugin-tool-a');
    expect(defs2.map(d => d.function.name)).toContain('plugin-tool-b');
    expect(defs2.map(d => d.function.name)).toContain('core-tool');
  });

  it('should not return cached definitions with deactivated plugins', () => {
    // Start with plugin A active
    mockActivationManager.activate('plugin-a');

    // First call - caches definitions with plugin A
    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1.map(d => d.function.name)).toContain('plugin-tool-a');

    // Deactivate plugin A
    mockActivationManager.deactivate('plugin-a');

    // Second call - should generate new definitions WITHOUT plugin A
    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2.map(d => d.function.name)).not.toContain('plugin-tool-a');
    expect(defs2.map(d => d.function.name)).toContain('core-tool');
  });

  it('should cache separately for different activation states', () => {
    // State 1: Plugin A active
    mockActivationManager.activate('plugin-a');
    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1).toHaveLength(2); // plugin A + core

    // State 2: Plugin B active (plugin A deactivated)
    mockActivationManager.deactivate('plugin-a');
    mockActivationManager.activate('plugin-b');
    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2).toHaveLength(2); // plugin B + core
    expect(defs2.map(d => d.function.name)).toContain('plugin-tool-b');
    expect(defs2.map(d => d.function.name)).not.toContain('plugin-tool-a');

    // Back to State 1: Plugin A active again
    mockActivationManager.deactivate('plugin-b');
    mockActivationManager.activate('plugin-a');
    const defs3 = toolManager.getFunctionDefinitions();
    expect(defs3).toHaveLength(2); // plugin A + core
    expect(defs3.map(d => d.function.name)).toContain('plugin-tool-a');
    expect(defs3.map(d => d.function.name)).not.toContain('plugin-tool-b');
  });

  it('should always include core tools regardless of plugin state', () => {
    // No plugins active
    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1.map(d => d.function.name)).toContain('core-tool');

    // Plugin A active
    mockActivationManager.activate('plugin-a');
    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2.map(d => d.function.name)).toContain('core-tool');

    // Both plugins active
    mockActivationManager.activate('plugin-b');
    const defs3 = toolManager.getFunctionDefinitions();
    expect(defs3.map(d => d.function.name)).toContain('core-tool');
  });

  it('should handle excludeTools with plugin activation changes', () => {
    mockActivationManager.activate('plugin-a');
    mockActivationManager.activate('plugin-b');

    // Get definitions excluding plugin_tool_b
    const defs1 = toolManager.getFunctionDefinitions(['plugin-tool-b']);
    expect(defs1).toHaveLength(2);
    expect(defs1.map(d => d.function.name)).toContain('plugin-tool-a');
    expect(defs1.map(d => d.function.name)).not.toContain('plugin-tool-b');

    // Deactivate plugin A
    mockActivationManager.deactivate('plugin-a');

    // Should not include plugin A (deactivated) or plugin B (excluded)
    const defs2 = toolManager.getFunctionDefinitions(['plugin-tool-b']);
    expect(defs2).toHaveLength(1);
    expect(defs2.map(d => d.function.name)).toContain('core-tool');
    expect(defs2.map(d => d.function.name)).not.toContain('plugin-tool-a');
    expect(defs2.map(d => d.function.name)).not.toContain('plugin-tool-b');
  });

  it('should invalidate cache when tools are registered/unregistered', () => {
    mockActivationManager.activate('plugin-a');

    // Initial state
    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1).toHaveLength(2);

    // Register a new tool
    const newTool = new CoreTool(activityStream);
    newTool.name = 'new-core-tool' as any; // Override name for test
    toolManager.registerTool(newTool);

    // Should include the new tool
    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2).toHaveLength(3);
    expect(defs2.map(d => d.function.name)).toContain('new-core-tool');

    // Unregister the tool
    toolManager.unregisterTool('new-core-tool');

    // Should not include the removed tool
    const defs3 = toolManager.getFunctionDefinitions();
    expect(defs3).toHaveLength(2);
    expect(defs3.map(d => d.function.name)).not.toContain('new-core-tool');
  });

  it('should handle activation state changes between multiple plugin combinations', () => {
    // Test the exact bug scenario from the issue description

    // Step 1: First call with plugins A,B active
    mockActivationManager.activate('plugin-a');
    mockActivationManager.activate('plugin-b');
    const defs1 = toolManager.getFunctionDefinitions();
    expect(defs1).toHaveLength(3);
    expect(defs1.map(d => d.function.name)).toEqual(
      expect.arrayContaining(['plugin-tool-a', 'plugin-tool-b', 'core-tool'])
    );

    // Step 2: Plugin A is deactivated
    mockActivationManager.deactivate('plugin-a');

    // Step 3: Second call should NOT return cached definitions with plugin A
    const defs2 = toolManager.getFunctionDefinitions();
    expect(defs2).toHaveLength(2);
    expect(defs2.map(d => d.function.name)).toEqual(
      expect.arrayContaining(['plugin-tool-b', 'core-tool'])
    );
    expect(defs2.map(d => d.function.name)).not.toContain('plugin-tool-a');
  });
});
