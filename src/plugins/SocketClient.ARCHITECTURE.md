# SocketClient Architecture

## Request Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            SocketClient                                  │
│                                                                          │
│  sendRequest(socketPath, method, params, timeout)                       │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. Generate Request ID                                                   │
│    • Increment counter: requestIdCounter++                               │
│    • Returns unique ID: 1, 2, 3, ...                                     │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. Build JSON-RPC Request                                                │
│    {                                                                     │
│      "jsonrpc": "2.0",                                                   │
│      "method": "search",                                                 │
│      "params": { "query": "hello" },                                     │
│      "id": 1                                                             │
│    }                                                                     │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. Create Socket Connection                                              │
│    • net.createConnection({ path: socketPath })                          │
│    • Register event handlers: connect, data, error, close               │
│    • Set timeout timer                                                   │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                ┌────────────┴──────────────┐
                │                           │
                ▼                           ▼
    ┌─────────────────────┐   ┌──────────────────────────┐
    │  Error Path         │   │  Success Path            │
    │  • ENOENT           │   │  • Connection established│
    │  • EACCES           │   │  • Send JSON request     │
    │  • ECONNREFUSED     │   │  • Wait for response     │
    │  • Timeout          │   └──────────┬───────────────┘
    │  ➜ cleanup()        │              │
    │  ➜ reject(Error)    │              ▼
    └─────────────────────┘   ┌──────────────────────────┐
                               │ 4. Receive Data Chunks   │
                               │    • Accumulate in buffer│
                               │    • Try parse JSON      │
                               │    • Repeat if partial   │
                               └──────────┬───────────────┘
                                          │
                                          ▼
                               ┌──────────────────────────┐
                               │ 5. Parse Complete        │
                               │    JSON.parse(buffer)    │
                               └──────────┬───────────────┘
                                          │
                                          ▼
                               ┌──────────────────────────┐
                               │ 6. Validate Response     │
                               │    • Check jsonrpc: "2.0"│
                               │    • Check ID matches    │
                               │    • Check result OR error│
                               └──────────┬───────────────┘
                                          │
                            ┌─────────────┴─────────────┐
                            │                           │
                            ▼                           ▼
                ┌───────────────────────┐   ┌──────────────────────┐
                │ Error Response        │   │ Success Response     │
                │ {                     │   │ {                    │
                │   "jsonrpc": "2.0",   │   │   "jsonrpc": "2.0",  │
                │   "error": {          │   │   "result": {...},   │
                │     "code": -32001,   │   │   "id": 1            │
                │     "message": "..."  │   │ }                    │
                │   },                  │   │                      │
                │   "id": 1             │   │ ➜ cleanup()          │
                │ }                     │   │ ➜ resolve(result)    │
                │                       │   └──────────────────────┘
                │ ➜ cleanup()           │
                │ ➜ reject(Error)       │
                └───────────────────────┘
```

## Component Interaction

```
┌──────────────┐
│   Plugin     │
│     Tool     │
│              │
│  (needs to   │
│   call RPC)  │
└──────┬───────┘
       │
       │ new SocketClient()
       │ client.sendRequest(...)
       │
       ▼
┌──────────────────────────────────────┐
│         SocketClient                 │
│                                      │
│  • Manages request/response cycle    │
│  • Handles errors and timeouts       │
│  • Validates JSON-RPC protocol       │
│  • Logs debug information            │
└──────┬───────────────────────────────┘
       │
       │ Unix Socket Communication
       │ (JSON-RPC 2.0 over TCP/Unix)
       │
       ▼
┌──────────────────────────────────────┐
│   Background Plugin Process          │
│   (Daemon listening on Unix socket)  │
│                                      │
│  • Receives JSON-RPC requests        │
│  • Executes requested methods        │
│  • Returns JSON-RPC responses        │
└──────────────────────────────────────┘
```

## State Machine

```
                         sendRequest() called
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │   CONNECTING           │
                    │   • Create socket      │
                    │   • Set timeout timer  │
                    └────────┬───────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
     timeout/error        connect              │
          │                  │                  │
          ▼                  ▼                  │
    ┌─────────┐     ┌────────────────┐         │
    │ ERROR   │     │   SENDING      │         │
    │ cleanup │     │   • Write JSON │         │
    │ reject  │     └────────┬───────┘         │
    └─────────┘              │                 │
                             ▼                 │
                    ┌────────────────┐         │
                    │  RECEIVING     │         │
                    │  • Buffer data │         │
                    │  • Parse JSON  │         │
                    └────────┬───────┘         │
                             │                 │
          ┌──────────────────┼──────────────────┤
          │                  │                  │
     timeout/error      parse success      socket close
          │                  │              (incomplete)
          ▼                  ▼                  │
    ┌─────────┐     ┌────────────────┐         │
    │ ERROR   │     │  VALIDATING    │         │
    │ cleanup │     │  • Check format│         ▼
    │ reject  │     │  • Check ID    │    ┌─────────┐
    └─────────┘     └────────┬───────┘    │ ERROR   │
                             │            │ cleanup │
          ┌──────────────────┼────────────│ reject  │
          │                  │            └─────────┘
    validation fail    validation pass
          │                  │
          ▼                  ▼
    ┌─────────┐     ┌────────────────┐
    │ ERROR   │     │   SUCCESS      │
    │ cleanup │     │   • cleanup    │
    │ reject  │     │   • resolve    │
    └─────────┘     └────────────────┘
```

## Error Handling Strategy

```
                    Error Detected
                         │
                         ▼
              ┌──────────────────────┐
              │  What type of error? │
              └──────────┬───────────┘
                         │
    ┌────────────────────┼────────────────────┐
    │                    │                    │
    ▼                    ▼                    ▼
┌─────────┐      ┌──────────────┐     ┌──────────────┐
│Connection│      │   Protocol   │     │   RPC        │
│  Error   │      │    Error     │     │   Error      │
└────┬─────┘      └──────┬───────┘     └──────┬───────┘
     │                   │                    │
     ▼                   ▼                    ▼
┌─────────────────┐ ┌──────────────────┐ ┌────────────────┐
│ • ENOENT        │ │ • Invalid JSON   │ │ • error.code   │
│   "not running" │ │   "incomplete"   │ │   from daemon  │
│                 │ │                  │ │                │
│ • EACCES        │ │ • Invalid format │ │ • error.message│
│   "permission"  │ │   "not JSON-RPC" │ │   from daemon  │
│                 │ │                  │ │                │
│ • ECONNREFUSED  │ │ • ID mismatch    │ │ Create error:  │
│   "refused"     │ │   "wrong ID"     │ │ "RPC error     │
│                 │ │                  │ │  (code N): M"  │
│ • Timeout       │ │ Create error:    │ └────────┬───────┘
│   "timeout"     │ │ "Invalid resp"   │          │
└────────┬────────┘ └──────────┬───────┘          │
         │                     │                  │
         └─────────────────────┴──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Common Handler  │
                    │  • cleanup()     │
                    │  • Log error     │
                    │  • reject(Error) │
                    └──────────────────┘
```

## Cleanup Guarantee

All code paths lead to cleanup:

```
    sendRequest()
         │
    ┌────┴────┐
    │ Promise │
    └────┬────┘
         │
    ┌────┴─────────────┬─────────────┬──────────────┬──────────────┐
    │                  │             │              │              │
    ▼                  ▼             ▼              ▼              ▼
SUCCESS          RPC ERROR    TIMEOUT     CONNECTION ERR    PROTOCOL ERR
    │                  │             │              │              │
    │             cleanup()      cleanup()      cleanup()      cleanup()
    │                  │             │              │              │
    └──────────────────┴─────────────┴──────────────┴──────────────┘
                              │
                              ▼
                    ┌──────────────────────┐
                    │   cleanup() always   │
                    │   • clearTimeout()   │
                    │   • socket.destroy() │
                    └──────────────────────┘
```

## Concurrent Requests

Multiple requests can run in parallel without interference:

```
Time  ────────────────────────────────────────────────▶

      ┌─ Request 1 (ID=1) ─────────────────┐
      │  Socket A                            │
      │  connect ─▶ send ─▶ receive ─▶ done │
      └──────────────────────────────────────┘

          ┌─ Request 2 (ID=2) ─────────────────┐
          │  Socket B                            │
          │  connect ─▶ send ─▶ receive ─▶ done │
          └──────────────────────────────────────┘

              ┌─ Request 3 (ID=3) ─────────────────┐
              │  Socket C                            │
              │  connect ─▶ send ─▶ receive ─▶ done │
              └──────────────────────────────────────┘

Each request:
• Has unique socket connection (no sharing)
• Has unique request ID (no collision)
• Has independent timeout timer
• Cleans up its own resources
• No shared state = No race conditions
```

## Data Flow

### Request Construction

```
Input                  Process                      Output
─────                  ───────                      ──────

socketPath ──┐
             │
method    ───┼──▶  Build JSON-RPC  ──▶  JSON String
             │      Request Object       + newline
params    ───┤
             │      {
timeout   ───┘        "jsonrpc": "2.0",
                      "method": "search",
                      "params": {...},
                      "id": 1
                    }
                    + '\n'
```

### Response Processing

```
Input                  Process                      Output
─────                  ───────                      ──────

Socket     ───▶  data event  ──▶  Buffer    ──▶   Parse    ──▶  result
chunks           (multiple)       += chunk         JSON

                                  "{"jsonr"  (incomplete, wait)
                                  "pc":"2.0  (incomplete, wait)
                                  ",\"resu"  (incomplete, wait)
                                  "lt\":{}"  (complete! parse)

                                  Accumulated:
                                  '{"jsonrpc":"2.0","result":{},"id":1}'
                                                    │
                                                    ▼
                                            ┌───────────────┐
                                            │  Validate     │
                                            │  JSON-RPC     │
                                            └───────┬───────┘
                                                    │
                                                    ▼
                                            ┌───────────────┐
                                            │  Check ID     │
                                            │  matches      │
                                            └───────┬───────┘
                                                    │
                                    ┌───────────────┴───────────────┐
                                    │                               │
                                    ▼                               ▼
                            ┌───────────────┐             ┌─────────────────┐
                            │  Has error?   │             │  Has result?    │
                            │  ➜ reject()   │             │  ➜ resolve()    │
                            └───────────────┘             └─────────────────┘
```

## Memory Management

```
┌─────────────────────────────────────────────────────────────┐
│                    Per Request Memory                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Request Object (stack/heap)                                │
│  • method: string             ~20-100 bytes                 │
│  • params: object             ~100-10K bytes                │
│  • id: number                 8 bytes                       │
│                                                              │
│  Socket Object (heap)                                       │
│  • Node.js net.Socket         ~1KB overhead                 │
│                                                              │
│  Data Buffer (heap)                                         │
│  • dataBuffer: string         0 to response size            │
│  • Grows as chunks arrive     (could be 1MB+)               │
│                                                              │
│  Timer (heap)                                               │
│  • timeoutId: NodeJS.Timeout  ~100 bytes                    │
│                                                              │
│  Promise closure (heap)                                     │
│  • resolve, reject functions  ~200 bytes                    │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  Total per request: ~1-2KB + response size                   │
│                                                              │
│  All memory freed on:                                        │
│  • cleanup() called                                          │
│  • Promise settled                                           │
│  • No references remain                                      │
└─────────────────────────────────────────────────────────────┘

Persistent Memory (shared across requests):
├─────────────────────────────────────────────────────────────┤
│  SocketClient instance                                       │
│  • requestIdCounter: number   8 bytes                       │
│  • defaultTimeout: number     8 bytes                       │
│                                                              │
│  Total persistent: ~16 bytes                                 │
└─────────────────────────────────────────────────────────────┘
```

## Performance Characteristics

### Time Complexity

- **sendRequest()**: O(n) where n = response size (JSON parsing)
- **checkConnection()**: O(1) (just connection attempt)
- **generateRequestId()**: O(1) (increment)
- **validateResponse()**: O(1) (constant field checks)

### Space Complexity

- **Data buffer**: O(n) where n = response size
- **Request object**: O(m) where m = params size
- **Other**: O(1) constant overhead

### Network Round-Trip

```
Time
 │
 │  Connection    Send       Wait        Receive      Process
 │     │           │           │            │            │
 ├─────┼───────────┼───────────┼────────────┼────────────┼────▶
 │     │           │           │            │            │
 │     ▼           ▼           ▼            ▼            ▼
 │  ~1ms        <1ms    1ms-30s (depends)  <1ms      <1ms
 │  (local)                   on operation
 │
 └─ Total: ~1-3ms for simple local operations
           1ms-30s+ for complex operations
```
