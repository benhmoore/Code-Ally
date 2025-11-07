# EventSubscriptionManager

The `EventSubscriptionManager` enables background plugins to subscribe to and receive read-only events from Ally via JSON-RPC notifications sent to their Unix socket.

## Overview

**Purpose**: Allow background plugins to observe Ally's operations without interfering with the main execution flow.

**Key Features**:
- Subscribe plugins to specific event types
- Fire-and-forget event dispatching (non-blocking)
- Automatic daemon status checking
- Comprehensive error handling (plugin failures don't affect Ally)
- JSON-RPC 2.0 notification format

## Architecture

```
┌─────────────┐
│   Ally      │
│  (Events)   │
└──────┬──────┘
       │
       ├─ TOOL_CALL_START
       ├─ AGENT_END
       ├─ TODO_UPDATE
       └─ ...
       │
       v
┌──────────────────────────────┐
│ EventSubscriptionManager     │
│                              │
│ - Filter by subscription     │
│ - Check daemon status        │
│ - Dispatch notifications     │
└──────┬───────────┬───────────┘
       │           │
       v           v
┌──────────┐ ┌──────────┐
│ Plugin A │ │ Plugin B │
│ Daemon   │ │ Daemon   │
└──────────┘ └──────────┘
```

## Approved Events (Phase 1)

Only these 12 event types are available for subscription:

1. `TOOL_CALL_START` - Tool execution begins
2. `TOOL_CALL_END` - Tool execution completes
3. `AGENT_START` - Agent session starts
4. `AGENT_END` - Agent session ends
5. `PERMISSION_REQUEST` - User permission requested
6. `PERMISSION_RESPONSE` - User permission granted/denied
7. `COMPACTION_START` - Context compaction begins
8. `COMPACTION_COMPLETE` - Context compaction completes
9. `CONTEXT_USAGE_UPDATE` - Context usage metrics updated
10. `TODO_UPDATE` - TODO list changed
11. `THOUGHT_COMPLETE` - Agent thought completed
12. `DIFF_PREVIEW` - File diff preview available

## API Reference

### `subscribe(pluginName, socketPath, events)`

Register a plugin's event subscriptions.

**Parameters**:
- `pluginName` (string): Name of the plugin (unique identifier)
- `socketPath` (string): Path to plugin's Unix socket
- `events` (string[]): Array of event types to subscribe to

**Throws**: Error if any event type is not approved

**Example**:
```typescript
eventManager.subscribe('my-plugin', '/tmp/my-plugin.sock', [
  'TOOL_CALL_START',
  'TOOL_CALL_END',
]);
```

### `unsubscribe(pluginName)`

Unregister a plugin's event subscriptions.

**Parameters**:
- `pluginName` (string): Name of the plugin

**Example**:
```typescript
eventManager.unsubscribe('my-plugin');
```

### `dispatch(eventType, eventData)`

Dispatch an event to subscribed plugins (async, fire-and-forget).

**Parameters**:
- `eventType` (string): Type of event (e.g., "TOOL_CALL_START")
- `eventData` (any): Event data payload

**Returns**: Promise<void> (resolves immediately, actual dispatch happens async)

**Example**:
```typescript
await eventManager.dispatch('TOOL_CALL_START', {
  toolName: 'bash',
  arguments: { command: 'ls -la' },
});
```

### `getSubscribers(eventType)`

Get list of plugins subscribed to an event type.

**Parameters**:
- `eventType` (string): Event type to check

**Returns**: string[] (array of plugin names)

**Example**:
```typescript
const subscribers = eventManager.getSubscribers('TOOL_CALL_START');
// ['plugin-a', 'plugin-b']
```

### `isSubscribed(pluginName)`

Check if a plugin has active subscriptions.

**Parameters**:
- `pluginName` (string): Plugin to check

**Returns**: boolean

**Example**:
```typescript
if (eventManager.isSubscribed('my-plugin')) {
  console.log('Plugin is subscribed');
}
```

## JSON-RPC Notification Format

Events are sent to plugins as JSON-RPC 2.0 notifications:

```json
{
  "jsonrpc": "2.0",
  "method": "on_event",
  "params": {
    "event_type": "TOOL_CALL_START",
    "event_data": {
      "toolName": "bash",
      "arguments": { "command": "ls -la" }
    },
    "timestamp": 1699999999999
  }
}
```

**Key Points**:
- No `id` field (notifications don't expect responses)
- Method is always `"on_event"`
- `params.event_type` contains the event type
- `params.event_data` contains the event payload
- `params.timestamp` is when the event was dispatched (Unix milliseconds)

## Plugin Daemon Implementation

Your plugin daemon must implement a handler for the `on_event` method.

### Python Example

```python
import json
import socket
import os

def handle_on_event(params):
    """Handle incoming event notifications"""
    event_type = params['event_type']
    event_data = params['event_data']
    timestamp = params['timestamp']

    # Process the event
    if event_type == 'TOOL_CALL_START':
        log_tool_call(event_data)
    elif event_type == 'AGENT_END':
        update_metrics(event_data)
    # ... handle other event types

def start_daemon(socket_path):
    """Start JSON-RPC server"""
    # Remove stale socket
    if os.path.exists(socket_path):
        os.unlink(socket_path)

    # Create Unix socket
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_path)
    server.listen(1)

    while True:
        conn, _ = server.accept()
        data = conn.recv(4096).decode('utf-8')

        # Parse JSON-RPC request/notification
        request = json.loads(data)

        # Check if it's a notification (no id field)
        if 'id' not in request:
            # It's a notification, no response needed
            if request['method'] == 'on_event':
                handle_on_event(request['params'])
        else:
            # It's a request, send response
            # ... handle other methods
            pass

        conn.close()
```

### TypeScript/Node.js Example

```typescript
import * as net from 'net';
import * as fs from 'fs';

function handleOnEvent(params: any) {
  const { event_type, event_data, timestamp } = params;

  switch (event_type) {
    case 'TOOL_CALL_START':
      console.log('Tool started:', event_data.toolName);
      break;
    case 'AGENT_END':
      console.log('Agent ended, tokens used:', event_data.tokensUsed);
      break;
    // ... handle other event types
  }
}

function startDaemon(socketPath: string) {
  // Remove stale socket
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  const server = net.createServer((socket) => {
    socket.on('data', (data) => {
      const request = JSON.parse(data.toString());

      // Check if it's a notification (no id field)
      if (!('id' in request)) {
        if (request.method === 'on_event') {
          handleOnEvent(request.params);
        }
      } else {
        // It's a request, send response
        // ... handle other methods
      }
    });
  });

  server.listen(socketPath);
}
```

## Error Handling

### Plugin-Side Errors

If a plugin daemon crashes or fails to process an event:
- The error is logged by Ally
- Other plugins still receive the event
- Ally's main flow is **not** affected
- No retry is attempted

### Event Dispatching Errors

- Socket not found: Logged, skipped silently
- Connection refused: Logged, skipped silently
- Timeout: Logged after 5 seconds, continues
- Invalid socket path: Logged, skipped

**Design Philosophy**: Plugin failures should never block or crash Ally.

## Performance Considerations

### Non-Blocking Dispatch

Events are dispatched asynchronously using `setImmediate`:

```typescript
await eventManager.dispatch('TOOL_CALL_START', data);
// ^ Returns immediately, actual dispatch happens in background
```

This ensures the main execution flow is never blocked by event delivery.

### Parallel Delivery

Events are delivered to multiple plugins in parallel using `Promise.all`:

```typescript
// If 3 plugins subscribe to TOOL_CALL_START, they all receive
// the event concurrently, not sequentially
```

### Daemon Status Checks

Before dispatching, the manager checks if the daemon is running:

```typescript
if (!processManager.isRunning(pluginName)) {
  // Skip silently, no socket connection attempt
}
```

This avoids unnecessary socket connection attempts to dead daemons.

## Testing

### Unit Tests

```typescript
import { EventSubscriptionManager } from './EventSubscriptionManager';

// Mock dependencies
const mockSocketClient = {
  sendNotification: jest.fn().mockResolvedValue(undefined),
};

const mockProcessManager = {
  isRunning: jest.fn().mockReturnValue(true),
};

const eventManager = new EventSubscriptionManager(
  mockSocketClient,
  mockProcessManager
);

// Test subscription
eventManager.subscribe('test-plugin', '/tmp/test.sock', ['TOOL_CALL_START']);
expect(eventManager.isSubscribed('test-plugin')).toBe(true);

// Test dispatch
await eventManager.dispatch('TOOL_CALL_START', { toolName: 'bash' });
expect(mockSocketClient.sendNotification).toHaveBeenCalledWith(
  '/tmp/test.sock',
  'on_event',
  {
    event_type: 'TOOL_CALL_START',
    event_data: { toolName: 'bash' },
    timestamp: expect.any(Number),
  }
);
```

### Integration Tests

1. Start a real plugin daemon that logs events
2. Subscribe it to events via the manager
3. Dispatch test events
4. Verify the daemon received them

## Best Practices

### For Ally Integration

1. **Create once, reuse**: Create a single `EventSubscriptionManager` instance and reuse it
2. **Subscribe on daemon start**: When a plugin daemon starts, subscribe it immediately
3. **Unsubscribe on daemon stop**: Clean up subscriptions when daemon stops
4. **Dispatch from event sources**: Connect to ActivityStream or other event emitters

### For Plugin Developers

1. **Subscribe selectively**: Only subscribe to events you need (reduces overhead)
2. **Process quickly**: Event handlers should be fast (don't block the daemon)
3. **Handle errors gracefully**: Catch exceptions in event handlers
4. **Log sparingly**: Avoid logging every event (can be noisy)
5. **Consider batching**: If receiving many events, consider batching processing

## Troubleshooting

### Events Not Received

1. Check daemon is running: `processManager.isRunning(pluginName)`
2. Check subscription: `eventManager.isSubscribed(pluginName)`
3. Check event type: Ensure it's an approved event
4. Check daemon logs: Look for JSON-RPC parsing errors
5. Check Ally logs: Look for `[EventSubscriptionManager]` entries

### High CPU Usage

1. Reduce subscribed events (subscribe only to what you need)
2. Optimize event handler (make it faster)
3. Consider debouncing high-frequency events

### Memory Leaks

1. Ensure `unsubscribe()` is called when daemon stops
2. Check plugin daemon doesn't accumulate events in memory

## Future Enhancements

Potential Phase 2 features:

- Event filtering (subscribe to events matching criteria)
- Event replay (get historical events)
- Event batching (combine multiple events into one notification)
- Priority levels (high-priority events delivered first)
- Event acknowledgment (optional confirmation from plugin)
- More event types (file changes, configuration updates, etc.)

## Related Files

- `/Users/bhm128/code-ally/src/plugins/EventSubscriptionManager.ts` - Implementation
- `/Users/bhm128/code-ally/src/plugins/EventSubscriptionManager.example.ts` - Usage examples
- `/Users/bhm128/code-ally/src/plugins/SocketClient.ts` - JSON-RPC communication
- `/Users/bhm128/code-ally/src/plugins/BackgroundProcessManager.ts` - Daemon lifecycle
