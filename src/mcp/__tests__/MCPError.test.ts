/**
 * Tests for MCPError
 */

import { describe, it, expect } from 'vitest';
import { MCPError } from '@mcp/MCPError.js';

describe('MCPError', () => {
  it('creates error with code and message', () => {
    const error = new MCPError('CONNECTION_FAILED', 'Could not connect');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MCPError');
    expect(error.code).toBe('CONNECTION_FAILED');
    expect(error.message).toBe('Could not connect');
    expect(error.serverName).toBeUndefined();
  });

  it('includes server name when provided', () => {
    const error = new MCPError('TOOL_CALL_FAILED', 'Tool failed', 'filesystem');

    expect(error.serverName).toBe('filesystem');
  });

  it('supports all error codes', () => {
    const codes = [
      'CONFIG_NOT_FOUND',
      'SERVER_NOT_FOUND',
      'CONNECTION_FAILED',
      'TOOL_CALL_FAILED',
      'TRANSPORT_ERROR',
      'TIMEOUT',
      'SERVER_CRASHED',
      'PROTOCOL_ERROR',
      'ALREADY_CONNECTED',
    ] as const;

    for (const code of codes) {
      const error = new MCPError(code, `test ${code}`);
      expect(error.code).toBe(code);
    }
  });
});
