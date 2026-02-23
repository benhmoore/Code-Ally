/**
 * Shared types for MCP (Model Context Protocol) server integration
 */

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string; [key: string]: any }>;
  isError: boolean;
}

export enum MCPServerStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

export interface MCPServerStatusInfo {
  status: MCPServerStatus;
  toolCount?: number;
  error?: string;
}
