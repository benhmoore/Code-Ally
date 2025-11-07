# Background Process Management - Quick Reference

## Overview

The `BackgroundProcessManager` handles lifecycle management for long-running plugin daemon processes.

## Quick Start

```typescript
import { BackgroundProcessManager } from './BackgroundProcessManager.js';
import { PluginEnvironmentManager } from './PluginEnvironmentManager.js';
import { PLUGIN_ENVS_DIR } from '../config/paths.js';
import { PLUGIN_TIMEOUTS } from './constants.js';
import { join } from 'path';

const manager = new BackgroundProcessManager();
const envManager = new PluginEnvironmentManager();

// Start a daemon
await manager.startProcess({
  pluginName: 'my-plugin',
  pluginPath: '/path/to/plugin',
  command: envManager.getPythonPath('my-plugin'),
  args: ['daemon.py'],
  socketPath: join(PLUGIN_ENVS_DIR, 'my-plugin', 'daemon.sock'),
  startupTimeout: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_STARTUP,
  shutdownGracePeriod: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_SHUTDOWN_GRACE_PERIOD,
  healthcheck: {
    interval: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_HEALTH_CHECK_INTERVAL,
    timeout: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_HEALTH_CHECK_TIMEOUT,
    retries: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_MAX_HEALTH_CHECK_FAILURES,
  },
});

// Stop a daemon
await manager.stopProcess('my-plugin');

// Stop all daemons (on app shutdown)
await manager.stopAllProcesses();
```

## Key Features

✓ Automatic health monitoring via socket connections
✓ Auto-restart on crashes (with retry limits)
✓ Graceful shutdown (SIGTERM → SIGKILL)
✓ Orphan process cleanup
✓ Comprehensive state tracking

## Process States

- `STARTING` - Being started
- `RUNNING` - Healthy and running
- `STOPPING` - Being stopped
- `STOPPED` - Stopped
- `ERROR` - Error state

## Configuration Constants

All defined in `src/plugins/constants.ts`:

```typescript
BACKGROUND_PROCESS_STARTUP: 30000                      // 30s startup timeout
BACKGROUND_PROCESS_SHUTDOWN_GRACE_PERIOD: 5000         // 5s grace period
BACKGROUND_PROCESS_HEALTH_CHECK_INTERVAL: 30000        // Check every 30s
BACKGROUND_PROCESS_HEALTH_CHECK_TIMEOUT: 5000          // 5s health timeout
BACKGROUND_PROCESS_MAX_HEALTH_CHECK_FAILURES: 3        // 3 failures → restart
BACKGROUND_PROCESS_MAX_RESTART_ATTEMPTS: 3             // Max 3 restarts
BACKGROUND_PROCESS_RESTART_DELAY: 5000                 // 5s between restarts
```

## Monitoring

```typescript
// Check if running
const isRunning = manager.isRunning('my-plugin');

// Get state
const state = manager.getState('my-plugin');

// Get PID
const pid = manager.getPid('my-plugin');

// Get detailed info
const info = manager.getProcessInfo('my-plugin');
console.log(info.state);
console.log(info.failedHealthChecks);
console.log(info.restartAttempts);
console.log(info.lastError);
```

## Daemon Requirements

Your daemon MUST:

1. Create a Unix socket at the specified path
2. Accept connections on that socket (for health checks)
3. Handle SIGTERM for graceful shutdown
4. Clean up resources on exit

## Example Python Daemon

```python
import os
import socket
import signal

class Daemon:
    def __init__(self):
        self.socket_path = os.environ.get('SOCKET_PATH')
        self.running = True

    def handle_shutdown(self, signum, frame):
        self.running = False
        # Cleanup socket
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        sys.exit(0)

    def run(self):
        signal.signal(signal.SIGTERM, self.handle_shutdown)

        # Create socket for health checks
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(self.socket_path)
        sock.listen(1)

        # Do your background work...
        while self.running:
            # Accept health check connections
            # Do your work
            pass
```

## Files Created

- `/Users/bhm128/code-ally/src/plugins/BackgroundProcessManager.ts` - Main implementation
- `/Users/bhm128/code-ally/src/plugins/BackgroundProcessManager.example.ts` - 10 usage examples
- `/Users/bhm128/code-ally/src/plugins/__tests__/BackgroundProcessManager.test.ts` - Unit tests
- `/Users/bhm128/code-ally/docs/BackgroundProcessManager.md` - Full documentation
- `/Users/bhm128/code-ally/src/plugins/constants.ts` - Updated with new constants

## Common Patterns

### With Environment Variables

```typescript
await manager.startProcess({
  ...config,
  envVars: {
    API_KEY: process.env.API_KEY,
    PORT: '8080',
  },
});
```

### Error Handling

```typescript
try {
  await manager.startProcess(config);
} catch (error) {
  const info = manager.getProcessInfo(pluginName);
  console.error('Failed:', info?.lastError);
}
```

### Application Shutdown

```typescript
process.on('SIGTERM', async () => {
  await manager.stopAllProcesses();
  process.exit(0);
});
```

## Testing

Run tests:
```bash
npm test -- src/plugins/__tests__/BackgroundProcessManager.test.ts
```

All 12 tests pass ✓

## See Also

- Full documentation: `/Users/bhm128/code-ally/docs/BackgroundProcessManager.md`
- Usage examples: `/Users/bhm128/code-ally/src/plugins/BackgroundProcessManager.example.ts`
- Related: `PluginEnvironmentManager.ts`, `ExecutableToolWrapper.ts`
