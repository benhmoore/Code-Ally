# BackgroundToolWrapper Implementation

A TypeScript implementation that wraps tools provided by background plugin processes (daemons) and enables JSON-RPC communication over Unix domain sockets.

## Overview

BackgroundToolWrapper enables plugins to provide tools that communicate with persistent background daemon processes via JSON-RPC 2.0. This is fundamentally different from ExecutableToolWrapper, which spawns a new process for each tool invocation.

### Key Differences from ExecutableToolWrapper

| Feature | ExecutableToolWrapper | BackgroundToolWrapper |
|---------|----------------------|----------------------|
| Process lifecycle | Spawns new process per call | Uses persistent daemon |
| Communication | stdin/stdout (JSON) | Unix socket (JSON-RPC 2.0) |
| Startup overhead | High (process spawn) | Low (socket connection) |
| State management | Stateless | Can maintain state |
| Response format | stdout parsing | Structured RPC result |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Plugin Tool Call                       │
└────────────────┬────────────────────────────────────────────┘
                 │
                 v
┌─────────────────────────────────────────────────────────────┐
│              BackgroundToolWrapper.execute()                │
│  1. Capture params for logging                             │
│  2. Check if daemon is running (ProcessManager)            │
│  3. Send JSON-RPC request (SocketClient)                   │
│  4. Convert RPC response to ToolResult                     │
│  5. Handle errors gracefully                               │
└────────────────┬────────────────────────────────────────────┘
                 │
                 v
┌─────────────────────────────────────────────────────────────┐
│                   SocketClient.sendRequest()                │
│  - Create socket connection                                │
│  - Send JSON-RPC 2.0 request                              │
│  - Wait for response                                       │
│  - Validate response format                               │
│  - Return result or throw error                           │
└────────────────┬────────────────────────────────────────────┘
                 │
                 v
┌─────────────────────────────────────────────────────────────┐
│            Background Daemon Process                        │
│  - Listens on Unix socket                                  │
│  - Receives JSON-RPC requests                              │
│  - Processes method calls                                  │
│  - Returns JSON-RPC responses                              │
└─────────────────────────────────────────────────────────────┘
```

## Plugin Manifest Structure

For a plugin to use BackgroundToolWrapper, its `plugin.json` must include:

```json
{
  "name": "my-daemon-plugin",
  "version": "1.0.0",
  "description": "A plugin with background daemon",
  "runtime": "python3",
  "dependencies": {
    "file": "requirements.txt"
  },
  "background": {
    "command": "python3",
    "args": ["daemon.py"],
    "communication": {
      "path": "/Users/user/.ally/plugin-envs/my-daemon-plugin/daemon.sock"
    },
    "healthcheck": {
      "interval": 30000,
      "timeout": 5000,
      "retries": 3
    },
    "startupTimeout": 30000,
    "shutdownGracePeriod": 5000
  },
  "tools": [
    {
      "name": "my_daemon_tool",
      "description": "Calls a method on the daemon",
      "type": "background_rpc",
      "method": "perform_task",
      "requiresConfirmation": false,
      "schema": {
        "type": "object",
        "properties": {
          "input": {
            "type": "string",
            "description": "Input for the task"
          }
        },
        "required": ["input"]
      }
    }
  ]
}
```

### Required Fields

**For background daemon configuration:**
- `background.command`: Command to start the daemon
- `background.args`: Command-line arguments
- `background.communication.path`: Unix socket path for RPC

**For background_rpc tools:**
- `type`: Must be `"background_rpc"`
- `method`: JSON-RPC method name to invoke

## JSON-RPC Protocol

### Request Format

```json
{
  "jsonrpc": "2.0",
  "method": "perform_task",
  "params": {
    "input": "some value"
  },
  "id": 1
}
```

### Success Response

```json
{
  "jsonrpc": "2.0",
  "result": {
    "message": "Task completed successfully",
    "data": {
      "output": "processed result"
    }
  },
  "id": 1
}
```

### Error Response

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32600,
    "message": "Invalid request",
    "data": {}
  },
  "id": 1
}
```

## Error Handling

BackgroundToolWrapper provides comprehensive error handling with categorized error types:

### Process State Errors

**Daemon not running:**
```
Background process 'my-plugin' is not running (state: stopped).
The daemon may have crashed or failed to start.
```

### Connection Errors

**Socket not found:**
```
Cannot connect to background process 'my-plugin'.
The daemon socket is not available. The process may have crashed or not started properly.
```

**Permission denied:**
```
Permission denied accessing socket for 'my-plugin'.
Check socket file permissions at: /path/to/daemon.sock
```

**Connection refused:**
```
Background process 'my-plugin' is not accepting connections.
The daemon may be starting up or in an error state.
```

### Timeout Errors

```
RPC request to 'my-plugin' timed out after 30000ms.
The daemon may be unresponsive or the operation is taking too long.
```

### RPC Protocol Errors

**Method not found:**
```
Plugin 'my-plugin' RPC error: RPC error (code -32601): Method not found
```

**Invalid params:**
```
Plugin 'my-plugin' RPC error: RPC error (code -32602): Invalid params
```

### Data Errors

**Malformed response:**
```
Invalid response from background process 'my-plugin'.
The daemon may have returned malformed data: Unexpected token...
```

## Usage Example

### Creating a BackgroundToolWrapper

```typescript
import { BackgroundToolWrapper } from './BackgroundToolWrapper.js';
import { SocketClient } from './SocketClient.js';
import { BackgroundProcessManager } from './BackgroundProcessManager.js';
import { ActivityStream } from '../services/ActivityStream.js';

// Initialize dependencies
const activityStream = new ActivityStream();
const socketClient = new SocketClient();
const processManager = new BackgroundProcessManager();

// Tool definition from manifest
const toolDef = {
  name: 'my_daemon_tool',
  description: 'Calls a method on the daemon',
  type: 'background_rpc',
  method: 'perform_task',
  requiresConfirmation: false,
  schema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input for the task' }
    },
    required: ['input']
  }
};

// Plugin manifest
const manifest = {
  name: 'my-daemon-plugin',
  version: '1.0.0',
  description: 'A plugin with background daemon',
  tools: [toolDef],
  background: {
    command: 'python3',
    args: ['daemon.py'],
    communication: {
      path: '/path/to/daemon.sock'
    }
  }
};

// Create wrapper
const tool = new BackgroundToolWrapper(
  toolDef,
  manifest,
  activityStream,
  socketClient,
  processManager,
  30000 // Optional timeout override
);

// Execute tool
const result = await tool.execute({ input: 'test data' });
console.log(result);
```

### Expected Result Format

```typescript
{
  success: true,
  error: '',
  output: 'Task completed successfully',
  data: {
    output: 'processed result'
  }
}
```

## Process Lifecycle

BackgroundToolWrapper does **not** manage the daemon lifecycle - that's handled by BackgroundProcessManager. The wrapper only:

1. Checks if daemon is running before RPC call
2. Returns descriptive error if daemon is not running
3. Does NOT auto-start the daemon

This design prevents unexpected daemon spawning during tool execution. Daemons should be started:
- At application startup
- Explicitly by the user
- By BackgroundProcessManager auto-restart on crash

## Implementation Details

### Constructor Validation

The constructor validates required fields:
- `toolDef.method` must be present for `background_rpc` tools
- `manifest.background.communication.path` must be present
- Throws descriptive errors if validation fails

### Timeout Configuration

Default timeout: 30 seconds (from `PLUGIN_TIMEOUTS.RPC_REQUEST_TIMEOUT`)

Override via constructor:
```typescript
const tool = new BackgroundToolWrapper(
  toolDef,
  manifest,
  activityStream,
  socketClient,
  processManager,
  60000 // 60 second timeout
);
```

### Response Conversion

RPC responses are converted to ToolResult format:

**RPC result:**
```json
{
  "message": "Success message",
  "data": { "key": "value" }
}
```

**ToolResult:**
```typescript
{
  success: true,
  error: '',
  output: 'Success message',
  data: { key: 'value' }
}
```

If `message` is not in RPC result, defaults to: `'Tool executed successfully'`

### Logging

All operations are logged with `[BackgroundToolWrapper]` prefix:

- **Debug**: Initialization, execution start, RPC requests, success
- **Warn**: Daemon not running
- **Error**: RPC failures

## Testing Considerations

When testing BackgroundToolWrapper:

1. **Mock SocketClient**: Mock `sendRequest()` to return test data
2. **Mock ProcessManager**: Mock `isRunning()` and `getState()`
3. **Test error paths**: Simulate connection failures, timeouts, RPC errors
4. **Test response conversion**: Verify RPC result → ToolResult mapping
5. **Test parameter capture**: Verify `captureParams()` is called

## Best Practices

1. **Always validate manifest**: Check `background` config exists before creating wrapper
2. **Use appropriate timeouts**: Long-running operations need higher timeouts
3. **Handle daemon crashes**: Check ProcessManager state and provide clear errors
4. **Log comprehensively**: Use debug logs for troubleshooting RPC issues
5. **Return structured data**: RPC results should have `message` and `data` fields
6. **Document RPC methods**: Each method should have clear input/output schemas

## Related Components

- **SocketClient**: Handles JSON-RPC communication over Unix sockets
- **BackgroundProcessManager**: Manages daemon lifecycle (start/stop/health)
- **ExecutableToolWrapper**: Alternative for stateless, per-call process execution
- **BaseTool**: Abstract base class providing common tool functionality
- **PluginLoader**: Loads plugins and creates appropriate tool wrappers
