/**
 * MCPToolFactory - Creates MCPTool instances from discovered MCP tool definitions
 */

import type { BaseTool } from '@tools/BaseTool.js';
import type { ActivityStream } from '@services/ActivityStream.js';
import type { MCPServerManager } from './MCPServerManager.js';
import type { MCPToolDefinition } from './types.js';
import { MCPTool } from './MCPTool.js';

export class MCPToolFactory {
  /**
   * Create BaseTool instances for all discovered tools from a server
   */
  static createTools(
    serverName: string,
    definitions: MCPToolDefinition[],
    requiresConfirmation: boolean,
    serverManager: MCPServerManager,
    activityStream: ActivityStream
  ): BaseTool[] {
    return definitions.map(def =>
      new MCPTool(serverName, def, requiresConfirmation, serverManager, activityStream)
    );
  }
}
