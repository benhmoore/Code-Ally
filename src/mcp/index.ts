/**
 * MCP (Model Context Protocol) module
 *
 * Provides integration with MCP-compatible servers, allowing Code-Ally
 * to connect to external tool providers (filesystem, GitHub, databases, etc.)
 */

export { MCPServerManager } from './MCPServerManager.js';
export { MCPTool } from './MCPTool.js';
export { MCPToolFactory } from './MCPToolFactory.js';
export { MCPError } from './MCPError.js';
export type { MCPErrorCode } from './MCPError.js';
export type { MCPConfig, MCPServerConfig } from './MCPConfig.js';
export { applyConfigDefaults } from './MCPConfig.js';
export type { MCPToolDefinition, MCPToolResult, MCPServerStatusInfo } from './types.js';
export { MCPServerStatus } from './types.js';
export { MCP_PRESETS, MCP_PRESET_ORDER, buildConfigFromPreset } from './MCPPresets.js';
export type { MCPPreset } from './MCPPresets.js';
