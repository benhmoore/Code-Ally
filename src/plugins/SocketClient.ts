/**
 * SocketClient - JSON-RPC 2.0 communication over Unix domain sockets
 *
 * Provides a simple, stateless client for communicating with background plugin
 * processes using the JSON-RPC 2.0 protocol over Unix domain sockets.
 *
 * Design decisions:
 * - Stateless: Each request creates a new socket connection (simple, reliable)
 * - Streaming JSON parser: Handles partial responses by accumulating chunks
 * - Comprehensive error handling: Distinguishes between connection, timeout, and protocol errors
 * - Request ID correlation: Uses incrementing counter for unique request IDs
 * - Timeout support: Configurable per-request with sensible defaults
 * - Clean resource management: Ensures socket cleanup in all code paths
 *
 * JSON-RPC 2.0 protocol:
 * - Request: { jsonrpc: "2.0", method: "...", params: {...}, id: N }
 * - Success: { jsonrpc: "2.0", result: {...}, id: N }
 * - Error: { jsonrpc: "2.0", error: { code: N, message: "..." }, id: N }
 *
 * Error types handled:
 * - ENOENT: Socket file doesn't exist (daemon not running)
 * - EACCES: Permission denied accessing socket
 * - ECONNREFUSED: Daemon not accepting connections
 * - Timeout: No response within timeout period
 * - Invalid JSON: Response is not parseable JSON
 * - Invalid JSON-RPC: Response doesn't match JSON-RPC 2.0 format
 * - RPC Error: Response contains error field (application-level error)
 */

import * as net from 'net';
import { logger } from '../services/Logger.js';
import { PLUGIN_TIMEOUTS, PLUGIN_CONSTRAINTS } from './constants.js';

/**
 * JSON-RPC 2.0 request format
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id: number;
}

/**
 * JSON-RPC 2.0 success response format
 */
export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  result: any;
  id: number;
}

/**
 * JSON-RPC 2.0 error response format
 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  error: {
    code: number;
    message: string;
    data?: any;
  };
  id: number;
}

/**
 * Union type for all valid JSON-RPC responses
 */
export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/**
 * SocketClient class for JSON-RPC communication over Unix domain sockets
 */
export class SocketClient {
  /**
   * Request ID counter for generating unique IDs
   * Using a counter ensures IDs are unique within this process
   */
  private requestIdCounter = 0;

  /**
   * Default timeout for RPC requests (30 seconds)
   * Can be overridden per-request
   */
  private readonly defaultTimeout = PLUGIN_TIMEOUTS.RPC_REQUEST_TIMEOUT || 30000;

  /**
   * Send a JSON-RPC request to a Unix socket and wait for response
   *
   * This is a stateless operation - creates a new socket connection for each request,
   * sends the JSON-RPC request, waits for the complete response, then cleans up.
   *
   * @param socketPath - Path to Unix domain socket
   * @param method - RPC method name
   * @param params - RPC method parameters (optional)
   * @param timeout - Request timeout in ms (default: 30000)
   * @returns Promise resolving to the RPC result (the 'result' field from success response)
   * @throws Error with descriptive message for connection failures, timeouts, or RPC errors
   */
  async sendRequest(
    socketPath: string,
    method: string,
    params?: any,
    timeout?: number
  ): Promise<any> {
    // Issue #10: Validate socket path length
    if (socketPath.length > PLUGIN_CONSTRAINTS.MAX_SOCKET_PATH_LENGTH) {
      throw new Error(
        `Socket path exceeds maximum length of ${PLUGIN_CONSTRAINTS.MAX_SOCKET_PATH_LENGTH} characters: ${socketPath}`
      );
    }

    const requestTimeout = timeout ?? this.defaultTimeout;
    const requestId = this.generateRequestId();

    logger.debug(
      `[SocketClient] Sending RPC request: socket=${socketPath}, method=${method}, id=${requestId}, timeout=${requestTimeout}ms`
    );

    // Build JSON-RPC 2.0 request
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id: requestId,
    };

    return new Promise((resolve, reject) => {
      // Create socket connection
      const socket = net.createConnection({ path: socketPath });
      let timeoutId: NodeJS.Timeout;
      let dataBuffer = ''; // Accumulate response chunks
      // Issue #1-4: Add settled flag to prevent race conditions
      let settled = false;

      /**
       * Cleanup function - ensures socket is destroyed and timeout is cleared
       * Called in all exit paths (success, error, timeout)
       */
      const cleanup = () => {
        clearTimeout(timeoutId);
        // Issue #3: Check if socket is already destroyed before destroying
        if (!socket.destroyed) {
          socket.destroy();
        }
      };

      /**
       * Timeout handler - fires if no response received within timeout period
       */
      timeoutId = setTimeout(() => {
        // Issue #1: Check settled flag before rejecting
        if (!settled) {
          settled = true;
          cleanup();
          const errorMsg = `RPC request timeout after ${requestTimeout}ms: socket=${socketPath}, method=${method}, id=${requestId}`;
          logger.debug(`[SocketClient] ${errorMsg}`);
          reject(new Error(errorMsg));
        }
      }, requestTimeout);

      /**
       * Connection established - send the JSON-RPC request
       */
      socket.on('connect', () => {
        logger.debug(`[SocketClient] Connected to socket: ${socketPath}`);
        // Issue #5: Move JSON.stringify inside try block
        try {
          const requestJson = JSON.stringify(request) + '\n'; // Add newline delimiter
          socket.write(requestJson);
          logger.debug(`[SocketClient] Sent request: ${requestJson.trim()}`);
        } catch (error) {
          // Issue #2: Check settled flag before rejecting
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(
                `Failed to send RPC request: ${error instanceof Error ? error.message : String(error)}`
              )
            );
          }
        }
      });

      /**
       * Data received - accumulate chunks and parse when complete
       *
       * JSON-RPC responses may arrive in multiple chunks, so we accumulate
       * the data until we have valid JSON. We attempt to parse after each chunk
       * in case the response is complete.
       */
      socket.on('data', (chunk) => {
        // Issue #2: Early return if already settled
        if (settled) return;

        dataBuffer += chunk.toString();
        logger.debug(
          `[SocketClient] Received data chunk (${chunk.length} bytes), total buffer: ${dataBuffer.length} bytes`
        );

        // Issue #7: Check buffer size against MAX_RESPONSE_SIZE
        if (dataBuffer.length > PLUGIN_CONSTRAINTS.MAX_RPC_RESPONSE_SIZE) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(
              new Error(
                `Response size exceeds maximum allowed size of ${PLUGIN_CONSTRAINTS.MAX_RPC_RESPONSE_SIZE} bytes`
              )
            );
          }
          return;
        }

        // Try to parse the accumulated data
        try {
          // Issue #6: Trim whitespace before parsing
          const response = JSON.parse(dataBuffer.trim());

          // Validate JSON-RPC format
          if (!this.validateResponse(response)) {
            if (!settled) {
              settled = true;
              cleanup();
              reject(
                new Error(
                  `Invalid JSON-RPC response format: ${JSON.stringify(response)}`
                )
              );
            }
            return;
          }

          // Check if response ID matches request ID
          if (response.id !== requestId) {
            if (!settled) {
              settled = true;
              cleanup();
              reject(
                new Error(
                  `Response ID mismatch: expected ${requestId}, got ${response.id}`
                )
              );
            }
            return;
          }

          // Check for JSON-RPC error
          if ('error' in response) {
            if (!settled) {
              settled = true;
              cleanup();
              const errorResponse = response as JsonRpcErrorResponse;
              const errorMsg = `RPC error (code ${errorResponse.error.code}): ${errorResponse.error.message}`;
              logger.debug(`[SocketClient] ${errorMsg}`);
              reject(new Error(errorMsg));
            }
            return;
          }

          // Success - return the result
          if (!settled) {
            settled = true;
            cleanup();
            logger.debug(
              `[SocketClient] RPC success: method=${method}, id=${requestId}`
            );
            resolve((response as JsonRpcSuccessResponse).result);
          }
        } catch (error) {
          // JSON parse error - likely incomplete data, wait for more chunks
          logger.debug(
            `[SocketClient] JSON parse pending (incomplete data): ${error instanceof Error ? error.message : String(error)}`
          );
          // Don't reject yet - more data may be coming
        }
      });

      /**
       * Socket error handler
       * Handles connection failures, permission errors, etc.
       */
      socket.on('error', (error: NodeJS.ErrnoException) => {
        // Issue #2: Check settled flag before rejecting
        if (!settled) {
          settled = true;
          cleanup();
          let errorMsg = `Socket error: ${error.message}`;

          // Provide more context for common error codes
          if (error.code === 'ENOENT') {
            errorMsg = `Socket file not found: ${socketPath} (daemon may not be running)`;
          } else if (error.code === 'EACCES') {
            errorMsg = `Permission denied accessing socket: ${socketPath}`;
          } else if (error.code === 'ECONNREFUSED') {
            errorMsg = `Connection refused: ${socketPath} (daemon not accepting connections)`;
          }

          logger.debug(`[SocketClient] ${errorMsg}`);
          reject(new Error(errorMsg));
        }
      });

      /**
       * Socket closed before receiving complete response
       * This happens if the daemon closes the connection prematurely
       */
      socket.on('close', (hadError) => {
        // Issue #4: Check if already settled or if error handler already fired
        if (hadError || settled) {
          return;
        }

        // If we have accumulated data but it's not valid JSON, reject
        if (dataBuffer.length > 0) {
          settled = true;
          cleanup();
          reject(
            new Error(
              `Socket closed with incomplete response: ${dataBuffer.substring(0, 200)}`
            )
          );
        }
        // Otherwise, the connection closed cleanly and we already resolved
      });
    });
  }

  /**
   * Check if a socket is accessible (for health checks)
   *
   * Attempts to connect to the socket and immediately disconnect.
   * Useful for checking if a daemon is alive and accepting connections.
   *
   * @param socketPath - Path to Unix domain socket
   * @param timeout - Connection timeout in ms (default: 5 seconds)
   * @returns Promise that resolves if socket is reachable, rejects otherwise
   */
  async checkConnection(socketPath: string, timeout?: number): Promise<void> {
    // Issue #10: Validate socket path length
    if (socketPath.length > PLUGIN_CONSTRAINTS.MAX_SOCKET_PATH_LENGTH) {
      throw new Error(
        `Socket path exceeds maximum length of ${PLUGIN_CONSTRAINTS.MAX_SOCKET_PATH_LENGTH} characters: ${socketPath}`
      );
    }

    const connectionTimeout =
      timeout ?? PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_HEALTH_CHECK_TIMEOUT;

    logger.debug(
      `[SocketClient] Checking socket connection: ${socketPath} (timeout: ${connectionTimeout}ms)`
    );

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      let timeoutId: NodeJS.Timeout;
      // Issue #9: Add settled flag to prevent race conditions
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeoutId);
        // Issue #9: Check if socket is already destroyed before destroying
        if (!socket.destroyed) {
          socket.destroy();
        }
      };

      timeoutId = setTimeout(() => {
        // Issue #9: Check settled flag before rejecting
        if (!settled) {
          settled = true;
          cleanup();
          const errorMsg = `Socket connection check timeout: ${socketPath}`;
          logger.debug(`[SocketClient] ${errorMsg}`);
          reject(new Error(errorMsg));
        }
      }, connectionTimeout);

      socket.on('connect', () => {
        // Issue #9: Check settled flag before resolving
        if (!settled) {
          settled = true;
          cleanup();
          logger.debug(`[SocketClient] Socket is reachable: ${socketPath}`);
          resolve();
        }
      });

      socket.on('error', (error: NodeJS.ErrnoException) => {
        // Issue #9: Check settled flag before rejecting
        if (!settled) {
          settled = true;
          cleanup();
          let errorMsg = `Socket connection check failed: ${error.message}`;

          if (error.code === 'ENOENT') {
            errorMsg = `Socket file not found: ${socketPath}`;
          } else if (error.code === 'EACCES') {
            errorMsg = `Permission denied: ${socketPath}`;
          } else if (error.code === 'ECONNREFUSED') {
            errorMsg = `Connection refused: ${socketPath}`;
          }

          logger.debug(`[SocketClient] ${errorMsg}`);
          reject(new Error(errorMsg));
        }
      });
    });
  }

  /**
   * Generate unique request ID
   *
   * Uses a simple incrementing counter. In a long-running process, this could
   * theoretically overflow, but at 1 million requests per second, it would take
   * ~285 years to overflow a 32-bit integer, and ~285 million years for a 53-bit
   * safe integer in JavaScript.
   *
   * @returns Unique request ID as a number
   */
  private generateRequestId(): number {
    return ++this.requestIdCounter;
  }

  /**
   * Validate JSON-RPC 2.0 response format
   *
   * Type guard that checks if the response object conforms to JSON-RPC 2.0 spec.
   * A valid response must have:
   * - jsonrpc field with value "2.0"
   * - id field (number or string)
   * - Either result field (success) OR error field (error)
   *
   * @param response - Object to validate
   * @returns True if response is valid JSON-RPC 2.0 format, false otherwise
   */
  private validateResponse(response: any): response is JsonRpcResponse {
    // Must be an object
    if (!response || typeof response !== 'object') {
      logger.debug('[SocketClient] Response validation failed: not an object');
      return false;
    }

    // Must have jsonrpc: "2.0"
    if (response.jsonrpc !== '2.0') {
      logger.debug(
        `[SocketClient] Response validation failed: invalid jsonrpc version: ${response.jsonrpc}`
      );
      return false;
    }

    // Must have id field
    if (response.id === undefined) {
      logger.debug('[SocketClient] Response validation failed: missing id field');
      return false;
    }

    // Must have either result or error field (but not both)
    const hasResult = 'result' in response;
    const hasError = 'error' in response;

    if (!hasResult && !hasError) {
      logger.debug(
        '[SocketClient] Response validation failed: missing result and error fields'
      );
      return false;
    }

    if (hasResult && hasError) {
      logger.debug(
        '[SocketClient] Response validation failed: has both result and error fields'
      );
      return false;
    }

    // If error field present, validate error structure
    if (hasError) {
      const error = response.error;
      if (!error || typeof error !== 'object') {
        logger.debug(
          '[SocketClient] Response validation failed: error field is not an object'
        );
        return false;
      }

      if (typeof error.code !== 'number') {
        logger.debug(
          '[SocketClient] Response validation failed: error.code is not a number'
        );
        return false;
      }

      if (typeof error.message !== 'string') {
        logger.debug(
          '[SocketClient] Response validation failed: error.message is not a string'
        );
        return false;
      }
    }

    return true;
  }
}
