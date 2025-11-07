# BackgroundProcessManager

A robust process lifecycle manager for background plugin processes (daemons) in the Ally CLI application.

## Overview

The `BackgroundProcessManager` handles the complete lifecycle of long-running background processes that work alongside the main Ally application. It provides automatic health monitoring, crash recovery, graceful shutdown, and comprehensive state tracking.

## Features

- **Process Lifecycle Management**: Start, stop, and monitor background processes
- **Health Monitoring**: Automatic health checks via socket connections
- **Auto-Restart**: Automatic restart on crashes with exponential backoff
- **Graceful Shutdown**: SIGTERM followed by SIGKILL after grace period
- **Orphan Cleanup**: Detects and cleans up processes from previous runs
- **State Tracking**: Comprehensive state and error tracking
- **Resource Management**: Automatic cleanup of PID files and resources

## Architecture

### Process States

```typescript
enum ProcessState {
  STARTING = 'starting',  // Process is being started
  RUNNING = 'running',    // Process is healthy and running
  STOPPING = 'stopping',  // Process is being stopped
  STOPPED = 'stopped',    // Process is stopped
  ERROR = 'error'         // Process encountered an error
}
```

### File Structure

For each background process, the following files are managed:

```
~/.ally/plugin-envs/{plugin_name}/
├── daemon.pid          # Process ID file
├── daemon.sock         # Unix socket for IPC
├── bin/
│   └── python3         # Virtual environment Python interpreter
└── .installed          # Environment state marker
```

### Health Monitoring

Health checks are performed by attempting to connect to the process's Unix socket:

1. Connect to socket at configured interval
2. If connection succeeds → process is healthy
3. If connection fails → increment failure counter
4. If failures exceed retry limit → terminate and restart process

### Auto-Restart Logic

When a process crashes or becomes unhealthy:

1. Check if restart attempts < maximum (default: 3)
2. Clean up process resources (PID file, etc.)
3. Wait for restart delay with exponential backoff
4. Attempt to restart the process
5. If restart succeeds → reset counter and continue monitoring
6. If restart fails → mark as ERROR state

## Configuration

### BackgroundProcessConfig

```typescript
interface BackgroundProcessConfig {
  // Required fields
  pluginName: string;              // Plugin identifier
  pluginPath: string;              // Absolute path to plugin directory
  command: string;                 // Command to execute (e.g., Python path)
  args: string[];                  // Command arguments
  socketPath: string;              // Unix socket path for IPC
  startupTimeout: number;          // Startup timeout (ms)
  shutdownGracePeriod: number;     // Grace period before SIGKILL (ms)

  // Optional fields
  envVars?: Record<string, string>; // Environment variables
  healthcheck?: {
    interval: number;               // Health check interval (ms)
    timeout: number;                // Health check timeout (ms)
    retries: number;                // Failures before unhealthy
  };
}
```

### Default Timeouts

Defined in `src/plugins/constants.ts`:

```typescript
export const PLUGIN_TIMEOUTS = {
  BACKGROUND_PROCESS_STARTUP: 30000,                      // 30 seconds
  BACKGROUND_PROCESS_SHUTDOWN_GRACE_PERIOD: 5000,         // 5 seconds
  BACKGROUND_PROCESS_HEALTH_CHECK_INTERVAL: 30000,        // 30 seconds
  BACKGROUND_PROCESS_HEALTH_CHECK_TIMEOUT: 5000,          // 5 seconds
  BACKGROUND_PROCESS_MAX_HEALTH_CHECK_FAILURES: 3,        // 3 failures
  BACKGROUND_PROCESS_MAX_RESTART_ATTEMPTS: 3,             // 3 attempts
  BACKGROUND_PROCESS_RESTART_DELAY: 5000,                 // 5 seconds
};
```

## API Reference

### Constructor

```typescript
const manager = new BackgroundProcessManager();
```

Creates a new instance of the background process manager.

### startProcess(config)

```typescript
async startProcess(config: BackgroundProcessConfig): Promise<void>
```

Starts a background process with the given configuration.

**Behavior:**
1. Checks for orphaned processes and cleans them up
2. Spawns the process with proper environment
3. Writes PID file
4. Waits for socket to be ready
5. Starts health monitoring (if configured)

**Throws:**
- If process is already running
- If during shutdown
- If startup fails or times out

**Example:**
```typescript
await manager.startProcess({
  pluginName: 'search-plugin',
  pluginPath: '/path/to/plugin',
  command: '/path/to/python',
  args: ['daemon.py'],
  socketPath: '/path/to/daemon.sock',
  startupTimeout: 30000,
  shutdownGracePeriod: 5000,
  healthcheck: {
    interval: 30000,
    timeout: 5000,
    retries: 3,
  },
});
```

### stopProcess(pluginName)

```typescript
async stopProcess(pluginName: string): Promise<void>
```

Gracefully stops a background process.

**Behavior:**
1. Stops health monitoring
2. Sends SIGTERM to process
3. Waits for grace period
4. Sends SIGKILL if still running
5. Cleans up PID file and resources

**Example:**
```typescript
await manager.stopProcess('search-plugin');
```

### stopAllProcesses()

```typescript
async stopAllProcesses(): Promise<void>
```

Stops all tracked background processes in parallel. Used during application shutdown.

**Example:**
```typescript
process.on('SIGTERM', async () => {
  await manager.stopAllProcesses();
  process.exit(0);
});
```

### isRunning(pluginName)

```typescript
isRunning(pluginName: string): boolean
```

Check if a process is currently running.

**Returns:** `true` if process state is RUNNING, `false` otherwise

**Example:**
```typescript
if (manager.isRunning('search-plugin')) {
  console.log('Process is running');
}
```

### getState(pluginName)

```typescript
getState(pluginName: string): ProcessState | undefined
```

Get the current state of a process.

**Returns:** Current `ProcessState` or `undefined` if not tracked

**Example:**
```typescript
const state = manager.getState('search-plugin');
if (state === ProcessState.ERROR) {
  console.log('Process is in error state');
}
```

### getPid(pluginName)

```typescript
getPid(pluginName: string): number | undefined
```

Get the process ID of a running process.

**Returns:** PID number or `undefined` if not running

**Example:**
```typescript
const pid = manager.getPid('search-plugin');
console.log(`Process ID: ${pid}`);
```

### getProcessInfo(pluginName)

```typescript
getProcessInfo(pluginName: string): Readonly<ProcessInfo> | undefined
```

Get detailed information about a process.

**Returns:** Process information object or `undefined` if not tracked

**ProcessInfo fields:**
- `state`: Current state
- `pid`: Process ID (if running)
- `config`: Process configuration
- `failedHealthChecks`: Current failed health check count
- `restartAttempts`: Number of restart attempts
- `lastError`: Last error message (if any)
- `lastStateChange`: Timestamp of last state change

**Example:**
```typescript
const info = manager.getProcessInfo('search-plugin');
if (info) {
  console.log(`State: ${info.state}`);
  console.log(`Failed health checks: ${info.failedHealthChecks}`);
  console.log(`Restart attempts: ${info.restartAttempts}`);
}
```

## Usage Patterns

### Basic Usage

```typescript
import { BackgroundProcessManager } from './plugins/BackgroundProcessManager.js';
import { PluginEnvironmentManager } from './plugins/PluginEnvironmentManager.js';
import { PLUGIN_ENVS_DIR } from './config/paths.js';
import { PLUGIN_TIMEOUTS } from './plugins/constants.js';
import { join } from 'path';

const manager = new BackgroundProcessManager();
const envManager = new PluginEnvironmentManager();

const pluginName = 'search-plugin';
const pluginPath = '/Users/user/.ally/plugins/search-plugin';

// Start the daemon
await manager.startProcess({
  pluginName,
  pluginPath,
  command: envManager.getPythonPath(pluginName),
  args: ['daemon.py'],
  socketPath: join(PLUGIN_ENVS_DIR, pluginName, 'daemon.sock'),
  startupTimeout: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_STARTUP,
  shutdownGracePeriod: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_SHUTDOWN_GRACE_PERIOD,
  healthcheck: {
    interval: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_HEALTH_CHECK_INTERVAL,
    timeout: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_HEALTH_CHECK_TIMEOUT,
    retries: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_MAX_HEALTH_CHECK_FAILURES,
  },
});

// Later, stop it
await manager.stopProcess(pluginName);
```

### With Environment Variables

```typescript
await manager.startProcess({
  pluginName: 'api-server',
  pluginPath: '/path/to/plugin',
  command: pythonPath,
  args: ['server.py'],
  socketPath: '/path/to/daemon.sock',
  envVars: {
    PORT: '8080',
    API_KEY: process.env.API_KEY,
    LOG_LEVEL: 'debug',
  },
  startupTimeout: 30000,
  shutdownGracePeriod: 5000,
});
```

### Error Handling

```typescript
try {
  await manager.startProcess(config);
} catch (error) {
  if (error.message.includes('already running')) {
    console.log('Process is already running');
  } else if (error.message.includes('Timeout waiting for socket')) {
    console.error('Process started but not responding');
  } else {
    console.error('Startup failed:', error.message);
  }

  // Check error state
  const info = manager.getProcessInfo(pluginName);
  if (info?.state === ProcessState.ERROR) {
    console.error('Last error:', info.lastError);
  }
}
```

### Application Shutdown

```typescript
// Graceful shutdown on SIGTERM/SIGINT
const cleanup = async () => {
  console.log('Shutting down...');
  await manager.stopAllProcesses();
  process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
```

## Integration with Plugin System

### Plugin Manifest

To declare a background daemon in your plugin, add a `daemon` section to `plugin.json`:

```json
{
  "name": "search-plugin",
  "version": "1.0.0",
  "runtime": "python3",
  "daemon": {
    "command": "python3",
    "args": ["daemon.py"],
    "healthcheck": {
      "interval": 30000,
      "timeout": 5000,
      "retries": 3
    }
  }
}
```

### PluginLoader Integration

The `PluginLoader` should use `BackgroundProcessManager` when loading plugins with daemons:

```typescript
import { BackgroundProcessManager } from './BackgroundProcessManager.js';

class PluginLoader {
  private backgroundManager = new BackgroundProcessManager();

  async loadPlugin(manifest: PluginManifest, pluginPath: string): Promise<void> {
    // ... load plugin tools ...

    // Start daemon if defined
    if (manifest.daemon) {
      const command = manifest.daemon.command === 'python3'
        ? this.envManager.getPythonPath(manifest.name)
        : manifest.daemon.command;

      await this.backgroundManager.startProcess({
        pluginName: manifest.name,
        pluginPath,
        command,
        args: manifest.daemon.args,
        socketPath: join(PLUGIN_ENVS_DIR, manifest.name, 'daemon.sock'),
        healthcheck: manifest.daemon.healthcheck,
        startupTimeout: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_STARTUP,
        shutdownGracePeriod: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_SHUTDOWN_GRACE_PERIOD,
      });
    }
  }

  async shutdown(): Promise<void> {
    await this.backgroundManager.stopAllProcesses();
  }
}
```

## Writing Daemon Processes

### Python Example

```python
#!/usr/bin/env python3
"""
Example daemon process for a plugin.

The daemon should:
1. Create a Unix socket at the path specified in SOCKET_PATH env var
2. Listen for connections (health checks)
3. Perform background work
4. Handle SIGTERM for graceful shutdown
"""

import os
import socket
import signal
import sys
import threading
import time

class DaemonServer:
    def __init__(self):
        self.socket_path = os.environ.get('SOCKET_PATH', '/tmp/daemon.sock')
        self.running = True
        self.socket = None

    def handle_shutdown(self, signum, frame):
        print("Received shutdown signal, cleaning up...")
        self.running = False
        if self.socket:
            self.socket.close()
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        sys.exit(0)

    def start_socket_server(self):
        """Start Unix socket server for health checks"""
        # Remove old socket if exists
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)

        # Create socket
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.bind(self.socket_path)
        self.socket.listen(1)

        print(f"Socket server listening on {self.socket_path}")

        # Accept connections in background
        def accept_connections():
            while self.running:
                try:
                    self.socket.settimeout(1.0)
                    conn, _ = self.socket.accept()
                    conn.close()  # Health check - just close immediately
                except socket.timeout:
                    continue
                except Exception as e:
                    if self.running:
                        print(f"Socket error: {e}")
                    break

        thread = threading.Thread(target=accept_connections, daemon=True)
        thread.start()

    def do_background_work(self):
        """Your actual background work here"""
        while self.running:
            # Example: process queue, monitor files, etc.
            time.sleep(1)

    def run(self):
        # Set up signal handlers
        signal.signal(signal.SIGTERM, self.handle_shutdown)
        signal.signal(signal.SIGINT, self.handle_shutdown)

        # Start socket server for health checks
        self.start_socket_server()

        # Do background work
        self.do_background_work()

if __name__ == '__main__':
    daemon = DaemonServer()
    daemon.run()
```

## Testing

See `src/plugins/__tests__/BackgroundProcessManager.test.ts` for comprehensive unit tests.

Run tests:
```bash
npm test -- src/plugins/__tests__/BackgroundProcessManager.test.ts
```

## Best Practices

1. **Always use default timeouts from constants** unless you have a specific reason to override them
2. **Enable health checking** for production daemons
3. **Handle SIGTERM gracefully** in your daemon code
4. **Use Unix sockets** for IPC (faster and more secure than TCP)
5. **Log to stdout/stderr** for debugging (captured by BackgroundProcessManager)
6. **Clean up resources** on shutdown (files, connections, etc.)
7. **Test crash recovery** by killing your daemon and verifying auto-restart
8. **Monitor restart attempts** to detect persistent failures

## Troubleshooting

### Process won't start

1. Check that the command path is correct
2. Verify the plugin's virtual environment is installed
3. Check socket path doesn't already exist
4. Look for errors in process stdout/stderr (visible in debug logs)

### Process keeps restarting

1. Check daemon logs for startup errors
2. Verify socket is being created properly
3. Increase startup timeout if daemon is slow to start
4. Check for resource conflicts (ports, files, etc.)

### Health checks failing

1. Ensure daemon creates socket at correct path
2. Verify daemon accepts connections on socket
3. Check socket permissions
4. Increase health check timeout for slow responses

### Process won't stop

1. Check if daemon handles SIGTERM properly
2. Increase shutdown grace period
3. Look for stuck cleanup code in daemon

## Future Enhancements

Potential improvements for future versions:

- [ ] HTTP health check support (in addition to socket)
- [ ] Process resource monitoring (CPU, memory)
- [ ] Log file rotation for daemon output
- [ ] Metrics collection (uptime, restart count, etc.)
- [ ] Configurable restart backoff strategies
- [ ] Process group management (start/stop multiple daemons as a group)
- [ ] Daemon upgrade support (rolling restart)

## Related Files

- `src/plugins/BackgroundProcessManager.ts` - Main implementation
- `src/plugins/BackgroundProcessManager.example.ts` - Usage examples
- `src/plugins/__tests__/BackgroundProcessManager.test.ts` - Unit tests
- `src/plugins/constants.ts` - Timeout and configuration constants
- `src/plugins/PluginEnvironmentManager.ts` - Virtual environment management
- `src/config/paths.ts` - Path constants
