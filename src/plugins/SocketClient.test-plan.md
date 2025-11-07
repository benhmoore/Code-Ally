# SocketClient Test Plan

This document outlines a comprehensive test plan for the SocketClient class.

## Unit Tests

### 1. Request ID Generation

**Test: Sequential IDs**
```typescript
const client = new SocketClient();
// Access private method via reflection or expose for testing
// Verify that IDs increment: 1, 2, 3, 4...
```

**Expected**: Each call to `generateRequestId()` returns incrementing integers.

### 2. Response Validation

**Test: Valid success response**
```typescript
const response = {
  jsonrpc: '2.0',
  result: { data: 'test' },
  id: 1
};
// validateResponse(response) should return true
```

**Test: Valid error response**
```typescript
const response = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Test error' },
  id: 1
};
// validateResponse(response) should return true
```

**Test: Invalid responses**
- Missing jsonrpc field
- Wrong jsonrpc version (e.g., "1.0")
- Missing id field
- Missing both result and error fields
- Has both result and error fields
- Error object missing code
- Error object missing message
- Not an object (string, number, null, array)

**Expected**: All invalid responses return false.

### 3. JSON-RPC Request Construction

**Test: Request with params**
```typescript
const client = new SocketClient();
// Capture the request sent to socket
// Verify structure: { jsonrpc: "2.0", method: "test", params: {...}, id: N }
```

**Test: Request without params**
```typescript
// Verify params field is included but undefined/null
```

**Expected**: Requests follow JSON-RPC 2.0 spec exactly.

## Integration Tests

### 4. Basic RPC Communication

**Setup**: Create a simple test daemon that echoes requests.

**Test: Send and receive**
```typescript
const client = new SocketClient();
const result = await client.sendRequest(socketPath, 'echo', { text: 'hello' });
// result should be { text: 'hello' }
```

**Expected**: Request sent, response received and parsed correctly.

### 5. Error Response Handling

**Setup**: Daemon returns JSON-RPC error response.

**Test: RPC error**
```typescript
const daemon = createTestDaemon({
  echo: () => ({ error: { code: -32001, message: 'Test error' } })
});
// Should throw error with message "RPC error (code -32001): Test error"
```

**Expected**: Error thrown with descriptive message.

### 6. Connection Error Handling

**Test: Socket doesn't exist (ENOENT)**
```typescript
const client = new SocketClient();
try {
  await client.sendRequest('/nonexistent/socket.sock', 'test');
} catch (error) {
  // error.message should contain "Socket file not found"
  // error.message should contain "daemon may not be running"
}
```

**Test: Permission denied (EACCES)**
```typescript
// Create socket with 000 permissions
// Attempt connection
// Should throw with "Permission denied"
```

**Test: Connection refused (ECONNREFUSED)**
```typescript
// Create socket file but no daemon listening
// Should throw with "Connection refused"
```

**Expected**: Descriptive error messages for each error type.

### 7. Timeout Handling

**Setup**: Daemon that never responds.

**Test: Request timeout**
```typescript
const client = new SocketClient();
try {
  await client.sendRequest(socketPath, 'slow', {}, 1000); // 1s timeout
} catch (error) {
  // Should timeout after 1 second
  // error.message should contain "timeout"
  // error.message should contain socket path, method, timeout value
}
```

**Test: Default timeout**
```typescript
// Verify default timeout is 30 seconds (from constants)
```

**Expected**: Timeout errors include context for debugging.

### 8. Partial Response Handling

**Setup**: Daemon sends response in multiple chunks.

**Test: Chunked response**
```typescript
// Daemon sends: chunk1 = '{"jsonrpc":"2.0",'
//               chunk2 = '"result":{"data":"test"},'
//               chunk3 = '"id":1}'
// Should accumulate chunks and parse complete JSON
```

**Expected**: Response correctly reassembled from chunks.

### 9. Response ID Validation

**Setup**: Daemon returns response with wrong ID.

**Test: ID mismatch**
```typescript
// Send request with id=1
// Daemon returns response with id=2
// Should reject with "Response ID mismatch" error
```

**Expected**: Error thrown when IDs don't match.

### 10. Socket Cleanup

**Test: Cleanup on success**
```typescript
// Verify socket is destroyed after successful request
// Check that no sockets remain open
```

**Test: Cleanup on error**
```typescript
// Trigger various errors (timeout, connection error, invalid response)
// Verify socket is destroyed in all cases
// No resource leaks
```

**Expected**: Socket resources always cleaned up.

### 11. Health Check

**Test: Healthy daemon**
```typescript
const client = new SocketClient();
await client.checkConnection(socketPath, 5000);
// Should resolve without error
```

**Test: Unhealthy daemon**
```typescript
// Socket doesn't exist
// Should reject with descriptive error
```

**Test: Connection timeout**
```typescript
// Daemon doesn't accept connections
// Should timeout with error
```

**Expected**: Health check accurately reports daemon status.

### 12. Concurrent Requests

**Test: Multiple parallel requests**
```typescript
const client = new SocketClient();
const promises = [
  client.sendRequest(socketPath, 'op1'),
  client.sendRequest(socketPath, 'op2'),
  client.sendRequest(socketPath, 'op3'),
];
const results = await Promise.all(promises);
// All requests should succeed with correct responses
// No ID collisions or response mixing
```

**Expected**: Concurrent requests work independently, no interference.

### 13. Invalid JSON Handling

**Setup**: Daemon sends invalid JSON.

**Test: Malformed JSON**
```typescript
// Daemon sends: "{invalid json"
// Should wait briefly for more data, then timeout
// Error should indicate JSON parse failure
```

**Expected**: Handles invalid JSON gracefully with timeout.

### 14. Premature Socket Close

**Setup**: Daemon closes connection before sending complete response.

**Test: Early close**
```typescript
// Daemon sends partial response then closes
// Should reject with "Socket closed with incomplete response"
```

**Expected**: Error indicates incomplete response.

### 15. Large Responses

**Test: Large JSON response**
```typescript
// Daemon sends response >100KB
// Should handle multiple data chunks
// Should parse successfully
```

**Expected**: No issues with large responses.

### 16. Special Characters in Response

**Test: Unicode and special characters**
```typescript
const result = await client.sendRequest(socketPath, 'echo', {
  text: '你好世界 🎉 \n\t\r special\\chars'
});
// Should preserve all characters correctly
```

**Expected**: All characters handled correctly.

## Performance Tests

### 17. Request Throughput

**Test: Sequential requests**
```typescript
// Send 1000 requests sequentially
// Measure time taken
// Verify no resource leaks
```

**Expected**: Reasonable performance, no memory leaks.

### 18. Connection Overhead

**Test: Connection creation time**
```typescript
// Measure time to create connection
// Compare with reusing existing connection
// Document overhead for stateless design
```

**Expected**: Document connection overhead for future optimization decisions.

## Security Tests

### 19. Injection Prevention

**Test: Malicious method names**
```typescript
// Try methods with special characters: "../escape", "method\n\r", etc.
// Should be sent as-is in JSON, no interpretation
```

**Test: Malicious params**
```typescript
// Try params with JSON injection attempts
// JSON.stringify should handle safely
```

**Expected**: No injection vulnerabilities.

### 20. Socket Path Validation

**Test: Path traversal attempts**
```typescript
// Try paths like: "../../etc/passwd"
// Should attempt connection (and fail appropriately)
// No path validation needed - OS handles this
```

**Expected**: No security issues, OS rejects invalid paths.

## Edge Cases

### 21. Empty Responses

**Test: Empty result**
```typescript
// Daemon returns: { jsonrpc: "2.0", result: null, id: 1 }
// Should return null as result
```

**Expected**: Handles null and undefined results correctly.

### 22. Very Long Timeouts

**Test: Extremely long timeout**
```typescript
// Set timeout to 24 hours
// Verify no integer overflow or unexpected behavior
```

**Expected**: Long timeouts work correctly.

### 23. Request ID Overflow

**Test: ID counter overflow**
```typescript
// Set counter to Number.MAX_SAFE_INTEGER - 1
// Send multiple requests
// Verify IDs still unique (overflow to negative numbers is OK)
```

**Expected**: ID generation handles overflow gracefully.

## Test Daemon Implementation

For integration tests, implement a simple test daemon:

```python
#!/usr/bin/env python3
import socket
import json
import os

SOCKET_PATH = '/tmp/test-daemon.sock'

def handle_request(data):
    request = json.loads(data)
    method = request['method']
    params = request.get('params', {})
    req_id = request['id']

    # Echo method
    if method == 'echo':
        return {
            'jsonrpc': '2.0',
            'result': params,
            'id': req_id
        }

    # Error method
    elif method == 'error':
        return {
            'jsonrpc': '2.0',
            'error': {
                'code': -32001,
                'message': 'Test error'
            },
            'id': req_id
        }

    # Slow method (for timeout tests)
    elif method == 'slow':
        import time
        time.sleep(60)  # Never responds in time
        return {'jsonrpc': '2.0', 'result': None, 'id': req_id}

    # Default
    else:
        return {
            'jsonrpc': '2.0',
            'error': {
                'code': -32601,
                'message': f'Method not found: {method}'
            },
            'id': req_id
        }

def main():
    # Remove existing socket
    try:
        os.unlink(SOCKET_PATH)
    except OSError:
        pass

    # Create socket
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(SOCKET_PATH)
    sock.listen(1)

    print(f'Test daemon listening on {SOCKET_PATH}')

    while True:
        conn, _ = sock.accept()
        data = conn.recv(4096)
        if data:
            response = handle_request(data.decode())
            conn.sendall(json.dumps(response).encode() + b'\n')
        conn.close()

if __name__ == '__main__':
    main()
```

## Success Criteria

- All unit tests pass
- All integration tests pass
- No resource leaks detected
- Error messages are clear and actionable
- Performance is acceptable (<100ms per request for simple echoes)
- Code coverage >90%
- Documentation is clear and complete
