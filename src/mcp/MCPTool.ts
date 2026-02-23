/**
 * MCPTool - BaseTool wrapper for a single MCP server tool
 *
 * One instance per discovered MCP tool. Provides getFunctionDefinition()
 * that converts MCP JSON Schema to Code-Ally FunctionDefinition format,
 * and executeImpl() that delegates to MCPServerManager.
 */

import { BaseTool } from '@tools/BaseTool.js';
import type { ToolResult, FunctionDefinition, ParameterSchema } from '@shared/index.js';
import type { ActivityStream } from '@services/ActivityStream.js';
import type { MCPServerManager } from './MCPServerManager.js';
import type { MCPToolDefinition } from './types.js';
import { toKebabCase } from '@utils/namingValidation.js';
import { logger } from '@services/Logger.js';

export class MCPTool extends BaseTool {
  readonly name: string;
  readonly description: string;
  readonly requiresConfirmation: boolean;
  readonly displayName: string;
  readonly pluginName: string;

  private readonly serverName: string;
  private readonly originalToolName: string;
  private readonly inputSchema: Record<string, any>;
  private readonly serverManager: MCPServerManager;

  constructor(
    serverName: string,
    definition: MCPToolDefinition,
    requiresConfirmation: boolean,
    serverManager: MCPServerManager,
    activityStream: ActivityStream
  ) {
    super(activityStream);

    this.serverName = serverName;
    this.originalToolName = definition.name;
    this.inputSchema = definition.inputSchema;
    this.serverManager = serverManager;

    // Naming: mcp-{serverName}-{toolName} all kebab-case
    const serverPart = toKebabCase(serverName);
    const toolPart = toKebabCase(definition.name);
    this.name = `mcp-${serverPart}-${toolPart}`;

    this.description = definition.description || `MCP tool ${definition.name} from ${serverName}`;
    this.requiresConfirmation = requiresConfirmation;
    this.pluginName = `mcp:${serverName}`;

    // Human-readable display: "ServerName / Tool Name"
    const displayServer = serverName.charAt(0).toUpperCase() + serverName.slice(1);
    const displayTool = definition.name
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
    this.displayName = `${displayServer} / ${displayTool}`;
  }

  /**
   * Convert MCP JSON Schema inputSchema to Code-Ally FunctionDefinition format
   */
  getFunctionDefinition(): FunctionDefinition {
    const properties: Record<string, ParameterSchema> = {};
    const required: string[] = [];

    if (this.inputSchema.properties) {
      for (const [key, schema] of Object.entries(this.inputSchema.properties)) {
        properties[key] = this.convertSchema(schema as Record<string, any>);
      }
    }

    if (Array.isArray(this.inputSchema.required)) {
      required.push(...this.inputSchema.required);
    }

    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties,
          required: required.length > 0 ? required : undefined,
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    try {
      // Strip 'description' meta-parameter if present (Code-Ally injects it)
      const callArgs = { ...args };
      delete callArgs.description;

      // Ensure server is connected (lazy start)
      await this.serverManager.ensureConnected(this.serverName);

      // Call the tool
      const result = await this.serverManager.callTool(
        this.serverName,
        this.originalToolName,
        callArgs
      );

      // Convert MCP result to ToolResult
      if (result.isError) {
        const errorText = result.content
          .filter(c => c.type === 'text' && c.text)
          .map(c => c.text)
          .join('\n') || 'MCP tool returned an error';
        return this.formatErrorResponse(errorText, 'plugin_error');
      }

      const contentText = result.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text)
        .join('\n');

      return this.formatSuccessResponse({ content: contentText || 'Success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[MCPTool] ${this.name} execution failed: ${message}`);
      return this.formatErrorResponse(message, 'plugin_error');
    }
  }

  /**
   * Convert a JSON Schema property to Code-Ally ParameterSchema
   */
  private convertSchema(schema: Record<string, any>): ParameterSchema {
    const result: ParameterSchema = {
      type: this.mapSchemaType(schema.type),
    };

    if (schema.description) {
      result.description = schema.description;
    }

    if (schema.enum) {
      result.enum = schema.enum;
    }

    if (schema.items && result.type === 'array') {
      result.items = this.convertSchema(schema.items);
    }

    if (schema.properties && result.type === 'object') {
      const nestedProps: Record<string, ParameterSchema> = {};
      for (const [key, val] of Object.entries(schema.properties)) {
        nestedProps[key] = this.convertSchema(val as Record<string, any>);
      }
      result.properties = nestedProps;
      if (Array.isArray(schema.required)) {
        result.required = schema.required;
      }
    }

    return result;
  }

  private mapSchemaType(type: string | undefined): ParameterSchema['type'] {
    const validTypes: ParameterSchema['type'][] = ['string', 'number', 'integer', 'boolean', 'array', 'object'];
    if (type && validTypes.includes(type as ParameterSchema['type'])) {
      return type as ParameterSchema['type'];
    }
    return 'string';
  }
}
