/**
 * Background Plugin Integration Tests
 *
 * Comprehensive integration tests for the complete background plugin lifecycle:
 * - Manifest validation (5 tests)
 * - Background process lifecycle (4 tests) - start, stop, timeouts, failures
 * - Socket communication (3 tests) - JSON-RPC, errors, timeouts
 * - BackgroundToolWrapper integration (3 tests) - execution, errors, RPC errors
 * - Process state management (2 tests) - state transitions, PID tracking
 * - Error handling and edge cases (3 tests) - invalid JSON, ID mismatch, multi-process
 * - Full plugin loading flow (1 test) - end-to-end workflow
 *
 * Total: 21 integration tests
 *
 * These tests use real processes and sockets (not mocks) to verify
 * end-to-end functionality. They create temporary Node.js daemon processes
 * that implement JSON-RPC 2.0 protocol over Unix domain sockets.
 *
 * Test Helpers:
 * - createEchoDaemon: Creates a simple daemon that echoes back RPC requests
 * - createFailingDaemon: Creates a daemon that exits immediately
 * - createSlowStartDaemon: Creates a daemon with configurable startup delay
 *
 * Key Coverage:
 * - PluginLoader.validatePluginManifest() - manifest validation logic
 * - BackgroundProcessManager - process lifecycle, PID management, graceful shutdown
 * - SocketClient - JSON-RPC 2.0 communication, error handling
 * - BackgroundToolWrapper - tool execution, error formatting
 * - Full integration - plugin loading → daemon startup → tool execution → shutdown
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PluginLoader } from '../PluginLoader.js';
import { BackgroundProcessManager } from '../BackgroundProcessManager.js';
import { SocketClient } from '../SocketClient.js';
import { BackgroundToolWrapper } from '../BackgroundToolWrapper.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { PluginConfigManager } from '@plugins/PluginConfigManager.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import * as os from 'os';
import type { PluginManifest, ToolDefinition } from '../PluginLoader.js';
import type { BackgroundProcessConfig } from '../BackgroundProcessManager.js';

// Mock logger to avoid console spam during tests
vi.mock('../../services/Logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Background Plugin Integration', () => {
  let tempDir: string;
  let processManager: BackgroundProcessManager;
  let socketClient: SocketClient;
  let activityStream: ActivityStream;
  let configManager: PluginConfigManager;
  let pluginLoader: PluginLoader;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = await fs.mkdtemp(join(os.tmpdir(), 'bg-plugin-test-'));

    // Initialize services
    processManager = new BackgroundProcessManager();
    socketClient = new SocketClient();
    const { EventSubscriptionManager } = await import('../EventSubscriptionManager.js');
    const eventSubscriptionManager = new EventSubscriptionManager(socketClient, processManager);
    activityStream = new ActivityStream(undefined, eventSubscriptionManager);
    configManager = new PluginConfigManager();
    pluginLoader = new PluginLoader(
      activityStream,
      configManager,
      socketClient,
      processManager,
      eventSubscriptionManager
    );
  });

  afterEach(async () => {
    // Stop all processes
    await processManager.stopAllProcesses();

    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper: Create a simple Node.js echo daemon that responds to JSON-RPC requests
   * Returns the path to the daemon script
   */
  async function createEchoDaemon(socketPath: string): Promise<string> {
    const daemonCode = `
const net = require('net');
const fs = require('fs');

const socket = '${socketPath}';
if (fs.existsSync(socket)) {
  fs.unlinkSync(socket);
}

const server = net.createServer((client) => {
  let buffer = '';

  client.on('data', (chunk) => {
    buffer += chunk.toString();
    try {
      const request = JSON.parse(buffer);
      const response = {
        jsonrpc: '2.0',
        result: { echo: request.params, method: request.method },
        id: request.id
      };
      client.write(JSON.stringify(response) + '\\n');
      client.end();
      buffer = '';
    } catch (e) {
      // Incomplete JSON, wait for more data
    }
  });
});

server.listen(socket);
console.log('Echo daemon started on socket:', socket);

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  server.close();
  if (fs.existsSync(socket)) {
    fs.unlinkSync(socket);
  }
  process.exit(0);
});
`;

    const daemonPath = join(tempDir, 'echo-daemon.js');
    await fs.writeFile(daemonPath, daemonCode);
    return daemonPath;
  }

  /**
   * Helper: Create a failing daemon that exits immediately
   */
  async function createFailingDaemon(): Promise<string> {
    const daemonCode = `
console.error('Daemon failed to start');
process.exit(1);
`;

    const daemonPath = join(tempDir, 'failing-daemon.js');
    await fs.writeFile(daemonPath, daemonCode);
    return daemonPath;
  }

  /**
   * Helper: Create a slow-start daemon that takes a while to create the socket
   */
  async function createSlowStartDaemon(socketPath: string, delayMs: number): Promise<string> {
    const daemonCode = `
const net = require('net');
const fs = require('fs');

console.log('Slow daemon starting, will delay ${delayMs}ms before creating socket');

setTimeout(() => {
  const socket = '${socketPath}';
  if (fs.existsSync(socket)) {
    fs.unlinkSync(socket);
  }

  const server = net.createServer((client) => {
    let buffer = '';

    client.on('data', (chunk) => {
      buffer += chunk.toString();
      try {
        const request = JSON.parse(buffer);
        const response = {
          jsonrpc: '2.0',
          result: { message: 'slow daemon ready', params: request.params },
          id: request.id
        };
        client.write(JSON.stringify(response) + '\\n');
        client.end();
        buffer = '';
      } catch (e) {
        // Incomplete JSON, wait for more data
      }
    });
  });

  server.listen(socket);
  console.log('Slow daemon socket created after delay');

  process.on('SIGTERM', () => {
    server.close();
    if (fs.existsSync(socket)) {
      fs.unlinkSync(socket);
    }
    process.exit(0);
  });
}, ${delayMs});
`;

    const daemonPath = join(tempDir, 'slow-daemon.js');
    await fs.writeFile(daemonPath, daemonCode);
    return daemonPath;
  }

  describe('Manifest Validation', () => {
    it('should validate correct background plugin manifest', async () => {
      const manifest: PluginManifest = {
        name: 'test-background-plugin',
        version: '1.0.0',
        description: 'Test background plugin',
        background: {
          enabled: true,
          command: 'node',
          args: ['daemon.js'],
          communication: {
            type: 'socket',
            path: join(tempDir, 'test.sock'),
          },
          healthcheck: {
            interval: 10000,
            timeout: 2000,
            retries: 3,
          },
          startup_timeout: 5000,
          shutdown_grace_period: 2000,
        },
        tools: [
          {
            name: 'test-tool',
            description: 'Test tool',
            type: 'background_rpc',
            method: 'test.method',
            schema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      };

      // Access private method via type assertion for testing
      const validation = (pluginLoader as any).validatePluginManifest(manifest);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should reject manifest missing background.command', async () => {
      const manifest: PluginManifest = {
        name: 'invalid-plugin',
        version: '1.0.0',
        description: 'Invalid plugin',
        background: {
          enabled: true,
          command: '', // Empty command
          args: ['daemon.js'],
          communication: {
            type: 'socket',
            path: join(tempDir, 'test.sock'),
          },
        },
        tools: [
          {
            name: 'test_tool',
            description: 'Test tool',
            type: 'background_rpc',
            method: 'test.method',
          },
        ],
      };

      const validation = (pluginLoader as any).validatePluginManifest(manifest);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain("Background plugin missing 'background.command'");
    });

    it('should reject manifest with tool type mismatch', async () => {
      const manifest: PluginManifest = {
        name: 'mismatched-plugin',
        version: '1.0.0',
        description: 'Plugin with type mismatch',
        background: {
          enabled: false, // Background disabled
          command: 'node',
          args: ['daemon.js'],
          communication: {
            type: 'socket',
            path: join(tempDir, 'test.sock'),
          },
        },
        tools: [
          {
            name: 'test_tool',
            description: 'Test tool',
            type: 'background_rpc', // But tool requires background
            method: 'test.method',
          },
        ],
      };

      const validation = (pluginLoader as any).validatePluginManifest(manifest);

      expect(validation.valid).toBe(false);
      expect(
        validation.errors.some(e =>
          e.includes("has type 'background_rpc' but plugin does not have background.enabled = true")
        )
      ).toBe(true);
    });

    it('should reject manifest with missing RPC method', async () => {
      const manifest: PluginManifest = {
        name: 'no-method-plugin',
        version: '1.0.0',
        description: 'Plugin missing method',
        background: {
          enabled: true,
          command: 'node',
          args: ['daemon.js'],
          communication: {
            type: 'socket',
            path: join(tempDir, 'test.sock'),
          },
        },
        tools: [
          {
            name: 'test_tool',
            description: 'Test tool',
            type: 'background_rpc',
            // Missing method field
          },
        ],
      };

      const validation = (pluginLoader as any).validatePluginManifest(manifest);

      expect(validation.valid).toBe(false);
      expect(
        validation.errors.some(e => e.includes("but missing 'method' field"))
      ).toBe(true);
    });

    it('should reject manifest with socket path too long', async () => {
      const longPath = '/'.padEnd(120, 'a'); // Path longer than 104 chars

      const manifest: PluginManifest = {
        name: 'long-path-plugin',
        version: '1.0.0',
        description: 'Plugin with long socket path',
        background: {
          enabled: true,
          command: 'node',
          args: ['daemon.js'],
          communication: {
            type: 'socket',
            path: longPath,
          },
        },
        tools: [
          {
            name: 'test_tool',
            description: 'Test tool',
            type: 'background_rpc',
            method: 'test.method',
          },
        ],
      };

      const validation = (pluginLoader as any).validatePluginManifest(manifest);

      expect(validation.valid).toBe(false);
      expect(
        validation.errors.some(e => e.includes('Socket path exceeds maximum length'))
      ).toBe(true);
    });
  });

  describe('Background Process Lifecycle', () => {
    it('should start and stop simple daemon', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'daemon.sock');
      const daemonPath = await createEchoDaemon(socketPath);

      const config: BackgroundProcessConfig = {
        pluginName: 'echo-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      // Start the daemon
      await processManager.startProcess(config);

      // Verify process is running
      expect(processManager.isRunning('echo-plugin')).toBe(true);

      // Verify PID is tracked
      const pid = processManager.getPid('echo-plugin');
      expect(pid).toBeDefined();
      expect(typeof pid).toBe('number');

      // Verify socket file was created
      const socketExists = await fs
        .access(socketPath)
        .then(() => true)
        .catch(() => false);
      expect(socketExists).toBe(true);

      // Stop the daemon
      await processManager.stopProcess('echo-plugin');

      // Verify process is stopped
      expect(processManager.isRunning('echo-plugin')).toBe(false);
    });

    it('should handle daemon startup timeout', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'slow-daemon.sock');
      // Create daemon that takes 8 seconds to start, but timeout is 3 seconds
      const daemonPath = await createSlowStartDaemon(socketPath, 8000);

      const config: BackgroundProcessConfig = {
        pluginName: 'slow-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 3000, // 3 second timeout
        shutdownGracePeriod: 2000,
      };

      // Should timeout
      await expect(processManager.startProcess(config)).rejects.toThrow(/Timeout waiting for socket/);
    });

    it('should handle daemon that fails to start', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'failing.sock');
      const daemonPath = await createFailingDaemon();

      const config: BackgroundProcessConfig = {
        pluginName: 'failing-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 3000,
        shutdownGracePeriod: 2000,
      };

      // Should fail to start
      await expect(processManager.startProcess(config)).rejects.toThrow();
    });

    it('should prevent duplicate process starts', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'duplicate-test.sock');
      const daemonPath = await createEchoDaemon(socketPath);

      const config: BackgroundProcessConfig = {
        pluginName: 'duplicate-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      // Start the daemon
      await processManager.startProcess(config);

      // Try to start again - should fail
      await expect(processManager.startProcess(config)).rejects.toThrow(/already/);

      // Cleanup
      await processManager.stopProcess('duplicate-plugin');
    });
  });

  describe('SocketClient Communication', () => {
    it('should send JSON-RPC request and receive response', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'rpc-test.sock');
      const daemonPath = await createEchoDaemon(socketPath);

      const config: BackgroundProcessConfig = {
        pluginName: 'rpc-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      // Start daemon
      await processManager.startProcess(config);

      // Send RPC request
      const result = await socketClient.sendRequest(
        socketPath,
        'test.method',
        { foo: 'bar', num: 42 },
        5000
      );

      // Verify response
      expect(result).toBeDefined();
      expect(result.method).toBe('test.method');
      expect(result.echo).toEqual({ foo: 'bar', num: 42 });

      // Cleanup
      await processManager.stopProcess('rpc-plugin');
    });

    it('should handle connection error when daemon not running', { timeout: 5000 }, async () => {
      const socketPath = join(tempDir, 'nonexistent.sock');

      // Try to send request to non-existent socket
      await expect(
        socketClient.sendRequest(socketPath, 'test.method', {}, 2000)
      ).rejects.toThrow(/Socket file not found/);
    });

    it('should handle RPC timeout', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'timeout-test.sock');

      // Create a daemon that never responds
      const daemonCode = `
const net = require('net');
const fs = require('fs');

const socket = '${socketPath}';
if (fs.existsSync(socket)) {
  fs.unlinkSync(socket);
}

const server = net.createServer((client) => {
  // Accept connection but never respond
  client.on('data', () => {
    // Ignore data, never send response
  });
});

server.listen(socket);
console.log('Non-responding daemon started');

process.on('SIGTERM', () => {
  server.close();
  if (fs.existsSync(socket)) {
    fs.unlinkSync(socket);
  }
  process.exit(0);
});
`;

      const daemonPath = join(tempDir, 'timeout-daemon.js');
      await fs.writeFile(daemonPath, daemonCode);

      const config: BackgroundProcessConfig = {
        pluginName: 'timeout-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      // Start daemon
      await processManager.startProcess(config);

      // Send request with short timeout - should timeout
      await expect(
        socketClient.sendRequest(socketPath, 'test.method', {}, 1000)
      ).rejects.toThrow(/timeout/);

      // Cleanup
      await processManager.stopProcess('timeout-plugin');
    });
  });

  describe('BackgroundToolWrapper Integration', () => {
    it('should execute tool successfully', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'tool-test.sock');
      const daemonPath = await createEchoDaemon(socketPath);

      const config: BackgroundProcessConfig = {
        pluginName: 'tool-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      // Start daemon
      await processManager.startProcess(config);

      // Create tool definition
      const toolDef: ToolDefinition = {
        name: 'test_tool',
        description: 'Test RPC tool',
        type: 'background_rpc',
        method: 'my.rpc.method',
        schema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
      };

      const manifest: PluginManifest = {
        name: 'tool-plugin',
        version: '1.0.0',
        description: 'Test plugin',
        background: {
          enabled: true,
          command: 'node',
          args: [daemonPath],
          communication: {
            type: 'socket',
            path: socketPath,
          },
        },
        tools: [toolDef],
      };

      // Create tool wrapper
      const tool = new BackgroundToolWrapper(
        toolDef,
        manifest,
        activityStream,
        socketClient,
        processManager,
        5000
      );

      // Execute tool
      const result = await tool.execute({ message: 'Hello, daemon!' });

      // Verify result
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.method).toBe('my.rpc.method');
      expect(result.data.echo).toEqual({ message: 'Hello, daemon!' });

      // Cleanup
      await processManager.stopProcess('tool-plugin');
    });

    it('should handle daemon not running error', { timeout: 5000 }, async () => {
      const socketPath = join(tempDir, 'not-running.sock');

      const toolDef: ToolDefinition = {
        name: 'test_tool',
        description: 'Test RPC tool',
        type: 'background_rpc',
        method: 'my.rpc.method',
      };

      const manifest: PluginManifest = {
        name: 'not-running-plugin',
        version: '1.0.0',
        description: 'Test plugin',
        background: {
          enabled: true,
          command: 'node',
          args: ['daemon.js'],
          communication: {
            type: 'socket',
            path: socketPath,
          },
        },
        tools: [toolDef],
      };

      // Create tool wrapper (but don't start daemon)
      const tool = new BackgroundToolWrapper(
        toolDef,
        manifest,
        activityStream,
        socketClient,
        processManager,
        5000
      );

      // Execute tool - should fail with appropriate error
      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('has not been started');
    });

    it('should handle RPC error response', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'error-test.sock');

      // Create daemon that returns RPC error
      const daemonCode = `
const net = require('net');
const fs = require('fs');

const socket = '${socketPath}';
if (fs.existsSync(socket)) {
  fs.unlinkSync(socket);
}

const server = net.createServer((client) => {
  let buffer = '';

  client.on('data', (chunk) => {
    buffer += chunk.toString();
    try {
      const request = JSON.parse(buffer);
      const response = {
        jsonrpc: '2.0',
        error: {
          code: -32601,
          message: 'Method not found'
        },
        id: request.id
      };
      client.write(JSON.stringify(response) + '\\n');
      client.end();
      buffer = '';
    } catch (e) {
      // Incomplete JSON
    }
  });
});

server.listen(socket);

process.on('SIGTERM', () => {
  server.close();
  if (fs.existsSync(socket)) {
    fs.unlinkSync(socket);
  }
  process.exit(0);
});
`;

      const daemonPath = join(tempDir, 'error-daemon.js');
      await fs.writeFile(daemonPath, daemonCode);

      const config: BackgroundProcessConfig = {
        pluginName: 'error-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      // Start daemon
      await processManager.startProcess(config);

      const toolDef: ToolDefinition = {
        name: 'error_tool',
        description: 'Tool that returns error',
        type: 'background_rpc',
        method: 'nonexistent.method',
      };

      const manifest: PluginManifest = {
        name: 'error-plugin',
        version: '1.0.0',
        description: 'Test plugin',
        background: {
          enabled: true,
          command: 'node',
          args: [daemonPath],
          communication: {
            type: 'socket',
            path: socketPath,
          },
        },
        tools: [toolDef],
      };

      const tool = new BackgroundToolWrapper(
        toolDef,
        manifest,
        activityStream,
        socketClient,
        processManager,
        5000
      );

      // Execute tool - should get RPC error
      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('RPC error');
      expect(result.error).toContain('Method not found');

      // Cleanup
      await processManager.stopProcess('error-plugin');
    });
  });

  describe('Process State Management', () => {
    it('should track process state transitions correctly', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'state-test.sock');
      const daemonPath = await createEchoDaemon(socketPath);

      const config: BackgroundProcessConfig = {
        pluginName: 'state-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      // Initially no state
      expect(processManager.getState('state-plugin')).toBeUndefined();

      // Start process
      await processManager.startProcess(config);

      // Should be running
      expect(processManager.getState('state-plugin')).toBe('running');

      // Get detailed info
      const info = processManager.getProcessInfo('state-plugin');
      expect(info).toBeDefined();
      expect(info?.state).toBe('running');
      expect(info?.pid).toBeDefined();
      expect(info?.config.pluginName).toBe('state-plugin');

      // Stop process
      await processManager.stopProcess('state-plugin');

      // Should be stopped
      expect(processManager.getState('state-plugin')).toBe('stopped');
    });

    it('should provide PID information', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'pid-test.sock');
      const daemonPath = await createEchoDaemon(socketPath);

      const config: BackgroundProcessConfig = {
        pluginName: 'pid-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      // No PID initially
      expect(processManager.getPid('pid-plugin')).toBeUndefined();

      // Start process
      await processManager.startProcess(config);

      // Should have PID
      const pid = processManager.getPid('pid-plugin');
      expect(pid).toBeDefined();
      expect(typeof pid).toBe('number');
      expect(pid).toBeGreaterThan(0);

      // Cleanup
      await processManager.stopProcess('pid-plugin');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle invalid JSON response', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'invalid-json.sock');

      // Create daemon that returns invalid JSON
      const daemonCode = `
const net = require('net');
const fs = require('fs');

const socket = '${socketPath}';
if (fs.existsSync(socket)) {
  fs.unlinkSync(socket);
}

const server = net.createServer((client) => {
  client.on('data', () => {
    // Send invalid JSON (not a complete JSON-RPC response)
    client.write('{ invalid json here }\\n');
    client.end();
  });
});

server.listen(socket);

process.on('SIGTERM', () => {
  server.close();
  if (fs.existsSync(socket)) {
    fs.unlinkSync(socket);
  }
  process.exit(0);
});
`;

      const daemonPath = join(tempDir, 'invalid-json-daemon.js');
      await fs.writeFile(daemonPath, daemonCode);

      const config: BackgroundProcessConfig = {
        pluginName: 'invalid-json-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      // Start daemon
      await processManager.startProcess(config);

      // Try to send request - should fail with JSON parse error
      await expect(
        socketClient.sendRequest(socketPath, 'test', {}, 2000)
      ).rejects.toThrow();

      // Cleanup
      await processManager.stopProcess('invalid-json-plugin');
    });

    it('should handle response ID mismatch', { timeout: 10000 }, async () => {
      const socketPath = join(tempDir, 'id-mismatch.sock');

      // Create daemon that returns wrong ID
      const daemonCode = `
const net = require('net');
const fs = require('fs');

const socket = '${socketPath}';
if (fs.existsSync(socket)) {
  fs.unlinkSync(socket);
}

const server = net.createServer((client) => {
  let buffer = '';

  client.on('data', (chunk) => {
    buffer += chunk.toString();
    try {
      const request = JSON.parse(buffer);
      const response = {
        jsonrpc: '2.0',
        result: { test: 'data' },
        id: 999999 // Wrong ID
      };
      client.write(JSON.stringify(response) + '\\n');
      client.end();
      buffer = '';
    } catch (e) {
      // Incomplete JSON
    }
  });
});

server.listen(socket);

process.on('SIGTERM', () => {
  server.close();
  if (fs.existsSync(socket)) {
    fs.unlinkSync(socket);
  }
  process.exit(0);
});
`;

      const daemonPath = join(tempDir, 'id-mismatch-daemon.js');
      await fs.writeFile(daemonPath, daemonCode);

      const config: BackgroundProcessConfig = {
        pluginName: 'id-mismatch-plugin',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath],
        socketPath: socketPath,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      // Start daemon
      await processManager.startProcess(config);

      // Try to send request - should fail with ID mismatch
      await expect(
        socketClient.sendRequest(socketPath, 'test', {}, 2000)
      ).rejects.toThrow(/mismatch/);

      // Cleanup
      await processManager.stopProcess('id-mismatch-plugin');
    });

    it('should handle stopAllProcesses gracefully', { timeout: 10000 }, async () => {
      // Create first daemon
      const socketPath1 = join(tempDir, 'multi1.sock');
      const daemon1Code = `
const net = require('net');
const fs = require('fs');

const socket = '${socketPath1}';
if (fs.existsSync(socket)) {
  fs.unlinkSync(socket);
}

const server = net.createServer((client) => {
  let buffer = '';
  client.on('data', (chunk) => {
    buffer += chunk.toString();
    try {
      const request = JSON.parse(buffer);
      const response = {
        jsonrpc: '2.0',
        result: { echo: request.params, method: request.method },
        id: request.id
      };
      client.write(JSON.stringify(response) + '\\n');
      client.end();
      buffer = '';
    } catch (e) {}
  });
});

server.listen(socket);

process.on('SIGTERM', () => {
  server.close();
  if (fs.existsSync(socket)) {
    fs.unlinkSync(socket);
  }
  process.exit(0);
});
`;
      const daemonPath1 = join(tempDir, 'multi-daemon-1.js');
      await fs.writeFile(daemonPath1, daemon1Code);

      // Create second daemon
      const socketPath2 = join(tempDir, 'multi2.sock');
      const daemon2Code = `
const net = require('net');
const fs = require('fs');

const socket = '${socketPath2}';
if (fs.existsSync(socket)) {
  fs.unlinkSync(socket);
}

const server = net.createServer((client) => {
  let buffer = '';
  client.on('data', (chunk) => {
    buffer += chunk.toString();
    try {
      const request = JSON.parse(buffer);
      const response = {
        jsonrpc: '2.0',
        result: { echo: request.params, method: request.method },
        id: request.id
      };
      client.write(JSON.stringify(response) + '\\n');
      client.end();
      buffer = '';
    } catch (e) {}
  });
});

server.listen(socket);

process.on('SIGTERM', () => {
  server.close();
  if (fs.existsSync(socket)) {
    fs.unlinkSync(socket);
  }
  process.exit(0);
});
`;
      const daemonPath2 = join(tempDir, 'multi-daemon-2.js');
      await fs.writeFile(daemonPath2, daemon2Code);

      const config1: BackgroundProcessConfig = {
        pluginName: 'multi-plugin-1',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath1],
        socketPath: socketPath1,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      const config2: BackgroundProcessConfig = {
        pluginName: 'multi-plugin-2',
        pluginPath: tempDir,
        command: 'node',
        args: [daemonPath2],
        socketPath: socketPath2,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };

      // Start both
      await processManager.startProcess(config1);
      await processManager.startProcess(config2);

      expect(processManager.isRunning('multi-plugin-1')).toBe(true);
      expect(processManager.isRunning('multi-plugin-2')).toBe(true);

      // Stop all
      await processManager.stopAllProcesses();

      expect(processManager.isRunning('multi-plugin-1')).toBe(false);
      expect(processManager.isRunning('multi-plugin-2')).toBe(false);
    });
  });

  describe('Full Plugin Loading Flow', () => {
    it('should load plugin, start background process, and call tool', { timeout: 15000 }, async () => {
      // Create plugin directory structure
      const pluginDir = join(tempDir, 'plugins', 'full-test-plugin');
      await fs.mkdir(pluginDir, { recursive: true });

      const socketPath = join(tempDir, 'full-test.sock');
      const daemonPath = join(pluginDir, 'daemon.js');

      // Create daemon script
      const daemonCode = `
const net = require('net');
const fs = require('fs');

const socket = '${socketPath}';
if (fs.existsSync(socket)) {
  fs.unlinkSync(socket);
}

const server = net.createServer((client) => {
  let buffer = '';

  client.on('data', (chunk) => {
    buffer += chunk.toString();
    try {
      const request = JSON.parse(buffer);

      // Implement different methods
      let result;
      if (request.method === 'greet') {
        result = {
          message: \`Hello, \${request.params?.name || 'stranger'}!\`,
          timestamp: Date.now()
        };
      } else if (request.method === 'calculate') {
        result = {
          sum: (request.params?.a || 0) + (request.params?.b || 0)
        };
      } else {
        result = { error: 'Unknown method' };
      }

      const response = {
        jsonrpc: '2.0',
        result: result,
        id: request.id
      };
      client.write(JSON.stringify(response) + '\\n');
      client.end();
      buffer = '';
    } catch (e) {
      // Incomplete JSON
    }
  });
});

server.listen(socket);
console.log('Full test daemon started');

process.on('SIGTERM', () => {
  server.close();
  if (fs.existsSync(socket)) {
    fs.unlinkSync(socket);
  }
  process.exit(0);
});
`;

      await fs.writeFile(daemonPath, daemonCode);

      // Create plugin manifest
      const manifest: PluginManifest = {
        name: 'full-test-plugin',
        version: '1.0.0',
        description: 'Full integration test plugin',
        background: {
          enabled: true,
          command: 'node',
          args: ['daemon.js'],
          communication: {
            type: 'socket',
            path: socketPath,
          },
          startup_timeout: 5000,
          shutdown_grace_period: 2000,
        },
        tools: [
          {
            name: 'greet',
            description: 'Greet a person',
            type: 'background_rpc',
            method: 'greet',
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
              },
            },
          },
          {
            name: 'calculate',
            description: 'Add two numbers',
            type: 'background_rpc',
            method: 'calculate',
            schema: {
              type: 'object',
              properties: {
                a: { type: 'number' },
                b: { type: 'number' },
              },
            },
          },
        ],
      };

      await fs.writeFile(
        join(pluginDir, 'plugin.json'),
        JSON.stringify(manifest, null, 2)
      );

      // Load plugins
      const { tools, agents, pluginCount } = await pluginLoader.loadPlugins(
        join(tempDir, 'plugins')
      );

      expect(pluginCount).toBe(1);
      expect(tools).toHaveLength(2);
      expect(agents).toHaveLength(0); // No agents in this test
      expect(tools[0].name).toBe('greet');
      expect(tools[1].name).toBe('calculate');

      // Start background process manually (PluginLoader.startBackgroundPlugins assumes Python)
      // In a real scenario, the plugin would use Python, but for testing we use Node.js
      const bgConfig: BackgroundProcessConfig = {
        pluginName: 'full-test-plugin',
        pluginPath: pluginDir,
        command: 'node',
        args: ['daemon.js'],
        socketPath: socketPath,
        startupTimeout: 5000,
        shutdownGracePeriod: 2000,
      };
      await processManager.startProcess(bgConfig);

      // Verify daemon is running
      expect(processManager.isRunning('full-test-plugin')).toBe(true);

      // Execute first tool
      const greetResult = await tools[0].execute({ name: 'Alice' });
      expect(greetResult.success).toBe(true);
      expect(greetResult.data.message).toContain('Alice');

      // Execute second tool
      const calcResult = await tools[1].execute({ a: 10, b: 32 });
      expect(calcResult.success).toBe(true);
      expect(calcResult.data.sum).toBe(42);

      // Stop background process
      await processManager.stopProcess('full-test-plugin');
      expect(processManager.isRunning('full-test-plugin')).toBe(false);
    });
  });
});
