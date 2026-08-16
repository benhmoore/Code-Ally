/**
 * MCPToolFactory - Creates MCPTool instances from discovered MCP tool definitions
 */

import type { BaseTool } from '@tools/BaseTool.js';
import type { ActivityStream } from '@services/ActivityStream.js';
import type { MCPServerManager } from './MCPServerManager.js';
import type { MCPToolDefinition } from './types.js';
import { MCPTool } from './MCPTool.js';
import type { ToolCapability } from '@tools/ToolCapability.js';

export class MCPToolFactory {
  /**
   * Create BaseTool instances for all discovered tools from a server
   */
  static createTools(
    serverName: string,
    definitions: MCPToolDefinition[],
    capabilities: readonly ToolCapability[],
    serverManager: MCPServerManager,
    activityStream: ActivityStream,
    /** If these tools come from a marketplace plugin, the plugin name */
    ownerPluginName?: string
  ): BaseTool[] {
    return definitions.map(def =>
      new MCPTool(serverName, def, capabilities, serverManager, activityStream, ownerPluginName)
    );
  }
}
