/**
 * Typed error class for MCP operations
 */

export type MCPErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'SERVER_NOT_FOUND'
  | 'CONNECTION_FAILED'
  | 'TOOL_CALL_FAILED'
  | 'TRANSPORT_ERROR'
  | 'TIMEOUT'
  | 'SERVER_CRASHED'
  | 'PROTOCOL_ERROR'
  | 'ALREADY_CONNECTED';

export class MCPError extends Error {
  readonly code: MCPErrorCode;
  readonly serverName?: string;

  constructor(code: MCPErrorCode, message: string, serverName?: string) {
    super(message);
    this.name = 'MCPError';
    this.code = code;
    this.serverName = serverName;
  }
}
