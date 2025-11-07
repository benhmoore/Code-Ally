# SocketClient - Quick Reference

A TypeScript client for JSON-RPC 2.0 communication over Unix domain sockets.

## Quick Start

```typescript
import { SocketClient } from './plugins/SocketClient.js';

const client = new SocketClient();
const result = await client.sendRequest(
  '/path/to/daemon.sock',
  'methodName',
  { param1: 'value1' },
  30000  // timeout in ms (optional)
);
```

## API Reference

### `sendRequest(socketPath, method, params?, timeout?)`

Send a JSON-RPC request and wait for response.

**Parameters:**
- `socketPath: string` - Path to Unix domain socket
- `method: string` - RPC method name
- `params?: any` - Method parameters (optional)
- `timeout?: number` - Timeout in milliseconds (default: 30000)

**Returns:** `Promise<any>` - The result from the RPC response

**Throws:** `Error` with descriptive message on failure

**Example:**
```typescript
const result = await client.sendRequest(
  '/tmp/daemon.sock',
  'search',
  { query: 'hello', limit: 10 }
);
console.log(result); // { results: [...] }
```

### `checkConnection(socketPath, timeout?)`

Verify socket is accessible (health check).

**Parameters:**
- `socketPath: string` - Path to Unix domain socket
- `timeout?: number` - Connection timeout in ms (default: 5000)

**Returns:** `Promise<void>` - Resolves if connection succeeds

**Throws:** `Error` if socket is unreachable

**Example:**
```typescript
try {
  await client.checkConnection('/tmp/daemon.sock', 5000);
  console.log('Daemon is healthy');
} catch (error) {
  console.error('Daemon is down');
}
```

## Error Handling

### Connection Errors

| Error Code | Error Message | Cause |
|------------|---------------|-------|
| ENOENT | "Socket file not found: {path} (daemon may not be running)" | Socket file doesn't exist |
| EACCES | "Permission denied accessing socket: {path}" | Insufficient permissions |
| ECONNREFUSED | "Connection refused: {path} (daemon not accepting connections)" | Socket exists but daemon not listening |

### Timeout Errors

```
"RPC request timeout after {ms}ms: socket={path}, method={method}, id={id}"
```

Cause: Daemon didn't respond within timeout period

### Protocol Errors

| Error Message | Cause |
|---------------|-------|
| "Invalid JSON-RPC response format: {response}" | Response doesn't match JSON-RPC 2.0 spec |
| "Response ID mismatch: expected {id1}, got {id2}" | Response ID doesn't match request ID |
| "Socket closed with incomplete response: {data}" | Connection closed before complete JSON received |

### RPC Errors

```
"RPC error (code {code}): {message}"
```

Cause: Application-level error from daemon (server-side error)

## Common Patterns

### Basic Request

```typescript
const client = new SocketClient();
const result = await client.sendRequest(
  socketPath,
  'getData',
  { id: 123 }
);
```

### Request Without Parameters

```typescript
const status = await client.sendRequest(socketPath, 'getStatus');
```

### Custom Timeout

```typescript
// 5 minute timeout for long operation
const result = await client.sendRequest(
  socketPath,
  'analyze',
  { dataset: 'large' },
  300000  // 5 minutes
);
```

### Error Handling

```typescript
try {
  const result = await client.sendRequest(socketPath, 'operation');
  console.log('Success:', result);
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);

  if (msg.includes('Socket file not found')) {
    // Daemon not running - start it
    await startDaemon();
  } else if (msg.includes('timeout')) {
    // Retry with longer timeout
    return client.sendRequest(socketPath, 'operation', {}, 60000);
  } else if (msg.includes('RPC error')) {
    // Application error - log and handle
    console.error('Business logic error:', msg);
  } else {
    // Unexpected error
    throw error;
  }
}
```

### Health Check Loop

```typescript
async function monitorDaemon(socketPath: string) {
  const client = new SocketClient();

  while (true) {
    try {
      await client.checkConnection(socketPath, 5000);
      console.log('Daemon healthy');
    } catch (error) {
      console.error('Daemon unhealthy, restarting...');
      await restartDaemon();
    }

    await sleep(30000); // Check every 30 seconds
  }
}
```

### Retry Logic

```typescript
async function requestWithRetry(
  socketPath: string,
  method: string,
  params: any,
  maxRetries = 3
) {
  const client = new SocketClient();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.sendRequest(socketPath, method, params);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // Only retry on transient errors
      const shouldRetry =
        msg.includes('timeout') ||
        msg.includes('Connection refused');

      if (!shouldRetry || attempt === maxRetries) {
        throw error;
      }

      console.log(`Attempt ${attempt} failed, retrying...`);
      await sleep(1000 * attempt); // Exponential backoff
    }
  }
}
```

### Concurrent Requests

```typescript
const client = new SocketClient();

// To same daemon
const [r1, r2, r3] = await Promise.all([
  client.sendRequest(socketPath, 'operation1'),
  client.sendRequest(socketPath, 'operation2'),
  client.sendRequest(socketPath, 'operation3'),
]);

// To different daemons
const [data1, data2, data3] = await Promise.all([
  client.sendRequest('/tmp/daemon1.sock', 'getData'),
  client.sendRequest('/tmp/daemon2.sock', 'getData'),
  client.sendRequest('/tmp/daemon3.sock', 'getData'),
]);
```

### Sequential Operations

```typescript
const client = new SocketClient();

// Initialize
await client.sendRequest(socketPath, 'initialize', { config: {...} });

// Process
const result = await client.sendRequest(socketPath, 'process', { data: 'test' });

// Cleanup
await client.sendRequest(socketPath, 'cleanup');
```

## Types

### JsonRpcRequest

```typescript
interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id: number | string;
}
```

### JsonRpcSuccessResponse

```typescript
interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  result: any;
  id: number | string;
}
```

### JsonRpcErrorResponse

```typescript
interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  error: {
    code: number;
    message: string;
    data?: any;
  };
  id: number | string;
}
```

### JsonRpcResponse

```typescript
type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
```

## Configuration

### Default Timeout

Default timeout is 30 seconds, configurable via constants:

```typescript
// src/plugins/constants.ts
export const PLUGIN_TIMEOUTS = {
  RPC_REQUEST_TIMEOUT: 30000,  // 30 seconds
  // ...
};
```

### Logging

All operations log to debug channel with `[SocketClient]` prefix.

Enable debug logging:
```bash
$ ally --debug
```

View SocketClient logs:
```
[SocketClient] Sending RPC request: socket=/tmp/daemon.sock, method=search, id=1
[SocketClient] Connected to socket: /tmp/daemon.sock
[SocketClient] Sent request: {"jsonrpc":"2.0",...}
[SocketClient] Received data chunk (245 bytes)
[SocketClient] RPC success: method=search, id=1
```

## JSON-RPC 2.0 Protocol

### Request Format

```json
{
  "jsonrpc": "2.0",
  "method": "search",
  "params": { "query": "hello" },
  "id": 1
}
```

### Success Response Format

```json
{
  "jsonrpc": "2.0",
  "result": { "data": "..." },
  "id": 1
}
```

### Error Response Format

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "Error message",
    "data": { "details": "..." }
  },
  "id": 1
}
```

## Best Practices

### 1. Reuse Client Instance

```typescript
// Good - reuse instance
const client = new SocketClient();
await client.sendRequest(...);
await client.sendRequest(...);

// Also fine - create per request (minimal overhead)
await new SocketClient().sendRequest(...);
```

### 2. Set Appropriate Timeouts

```typescript
// Quick operations - shorter timeout
await client.sendRequest(socket, 'ping', {}, 5000);

// Long operations - longer timeout
await client.sendRequest(socket, 'analyze', data, 300000);
```

### 3. Handle All Error Types

```typescript
try {
  const result = await client.sendRequest(socketPath, method, params);
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);

  // Check error type and handle appropriately
  if (msg.includes('Socket file not found')) { /* ... */ }
  else if (msg.includes('Permission denied')) { /* ... */ }
  else if (msg.includes('timeout')) { /* ... */ }
  else if (msg.includes('RPC error')) { /* ... */ }
  else { throw error; }
}
```

### 4. Validate Socket Path

```typescript
import { access } from 'fs/promises';

async function sendRequest(socketPath: string, ...) {
  try {
    await access(socketPath);  // Check file exists first
  } catch {
    throw new Error(`Socket file not found: ${socketPath}`);
  }

  return client.sendRequest(socketPath, ...);
}
```

### 5. Use Type Guards for Results

```typescript
interface SearchResult {
  results: Array<{ id: number; title: string }>;
  total: number;
}

function isSearchResult(data: any): data is SearchResult {
  return data &&
    Array.isArray(data.results) &&
    typeof data.total === 'number';
}

const result = await client.sendRequest(socket, 'search', { query: 'test' });
if (isSearchResult(result)) {
  console.log(`Found ${result.total} results`);
}
```

## Troubleshooting

### "Socket file not found"

**Cause:** Daemon not running or socket path incorrect

**Solutions:**
1. Check daemon is running: `ps aux | grep daemon`
2. Verify socket path: `ls -la /path/to/daemon.sock`
3. Start daemon if needed

### "Permission denied"

**Cause:** Insufficient permissions on socket file

**Solutions:**
1. Check socket permissions: `ls -la /path/to/daemon.sock`
2. Run as correct user: `sudo -u daemon-user ally ...`
3. Fix permissions: `chmod 666 /path/to/daemon.sock`

### "Connection refused"

**Cause:** Socket exists but daemon not accepting connections

**Solutions:**
1. Daemon may be starting up - wait and retry
2. Check daemon logs for errors
3. Restart daemon

### "Request timeout"

**Cause:** Daemon not responding within timeout period

**Solutions:**
1. Increase timeout for long operations
2. Check daemon is not hung (send health check)
3. Check daemon logs for errors
4. Verify operation is actually long-running (not stuck)

### "Invalid JSON-RPC response"

**Cause:** Daemon returned malformed response

**Solutions:**
1. Check daemon implementation follows JSON-RPC 2.0 spec
2. Enable debug logging to see raw response
3. Test daemon with direct socket connection
4. Check for line ending issues (`\n` vs `\r\n`)

## Performance

### Typical Latency

- **Local socket (simple echo)**: 1-5ms
- **Connection overhead**: ~1ms per request
- **JSON parsing**: ~0.1ms per KB

### Optimization Tips

1. **Reuse client instance** (minor savings, ~100 bytes)
2. **Use smaller payloads** (faster serialization/parsing)
3. **Batch operations** (send one request with multiple operations)
4. **Consider connection pooling** (if profiling shows overhead is significant)

## Related Documentation

- **Implementation Details**: `SocketClient.IMPLEMENTATION.md`
- **Architecture Diagrams**: `SocketClient.ARCHITECTURE.md`
- **Test Plan**: `SocketClient.test-plan.md`
- **Usage Examples**: `SocketClient.example.ts`

## Support

For issues or questions:
1. Check debug logs: `ally --debug`
2. Review test plan for examples
3. Check daemon logs for server-side errors
4. Verify JSON-RPC protocol compliance
