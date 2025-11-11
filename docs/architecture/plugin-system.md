# Plugin System Architecture

Code Ally's plugin system enables extending functionality through custom tools without modifying core code.

## Overview

**Purpose:** Allow developers to add domain-specific tools (API clients, data processors, custom integrations)

**Key features:**
- Two plugin types: executable and background RPC
- Automatic dependency management (Python venvs)
- Session-scoped activation (always or tagged)
- Event subscriptions for background plugins
- Isolated execution environments

## Plugin Types

### Executable Plugins

**Model:** One process per tool call

**Communication:** stdin (JSON) → stdout (JSON)

**Use cases:**
- Simple, stateless operations
- Command-line tool wrappers
- Quick scripts

**Lifecycle:**
1. PluginLoader discovers plugin
2. ExecutableToolWrapper created
3. Tool call invoked
4. Process spawned with args
5. JSON request sent to stdin
6. Process executes logic
7. JSON response written to stdout
8. Process exits
9. Response returned to Agent

**Pros:**
- Simple implementation
- Language-agnostic
- No state management needed
- Natural isolation

**Cons:**
- Process spawn overhead per call
- No request caching
- Can't subscribe to events

### Background RPC Plugins

**Model:** Long-running daemon, multiple requests

**Communication:** JSON-RPC over Unix socket

**Use cases:**
- Stateful services (database connections, caches)
- Heavy initialization (ML models)
- Event-driven behavior
- High-frequency calls

**Lifecycle:**
1. PluginLoader discovers plugin
2. BackgroundProcessManager starts daemon
3. Daemon creates Unix socket
4. BackgroundToolWrapper created
5. Tool calls routed via SocketClient
6. Daemon serves multiple requests
7. Optional: Daemon subscribes to ActivityStream events
8. On shutdown: SIGTERM → wait → SIGKILL

**Pros:**
- Single initialization cost
- Request caching
- Persistent connections
- Event subscriptions
- Better performance for frequent calls

**Cons:**
- More complex to implement
- Requires health monitoring
- Need to handle socket communication

## Component Architecture

```
PluginLoader
    ├─ Discovers plugins in ~/.ally/plugins/
    ├─ Validates plugin.json manifests
    ├─ Calls PluginEnvironmentManager
    │   └─ Creates venv, installs dependencies
    ├─ Creates tool wrappers
    │   ├─ ExecutableToolWrapper (stdio)
    │   └─ BackgroundToolWrapper (RPC)
    └─ Registers tools with ToolManager

PluginActivationManager
    ├─ Tracks active plugins per session
    ├─ Parses +plugin/-plugin tags
    ├─ Filters tools sent to LLM
    └─ Persists state to session.json

BackgroundProcessManager
    ├─ Starts/stops background daemons
    ├─ Health monitoring (ping/pong)
    ├─ Automatic restart on failure
    └─ Graceful shutdown (SIGTERM)

EventSubscriptionManager
    ├─ Manages plugin event subscriptions
    ├─ Routes ActivityStream events
    └─ Forwards via SocketClient (JSON-RPC)

SocketClient
    ├─ JSON-RPC communication
    ├─ Request/response correlation
    ├─ Timeout handling
    └─ Connection pooling
```

## Plugin Manifest

**File:** `~/.ally/plugins/my-plugin/plugin.json`

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Tool description visible to LLM",
  "author": "Your Name",

  "runtime": "python3",
  "dependencies": {
    "file": "requirements.txt"
  },

  "activationMode": "tagged",

  "tools": [
    {
      "name": "my_tool",
      "type": "executable",
      "command": "python3",
      "args": ["tool.py"],
      "requiresConfirmation": false,
      "schema": {
        "type": "object",
        "properties": {
          "input": {
            "type": "string",
            "description": "Input parameter"
          }
        },
        "required": ["input"]
      }
    }
  ],

  "background": {
    "enabled": true,
    "command": "python3",
    "args": ["daemon.py"],
    "communication": {
      "type": "socket",
      "path": "/tmp/my-plugin-{session_id}.sock"
    },
    "health": {
      "interval": 30,
      "timeout": 5
    },
    "events": [
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "AGENT_START"
    ]
  },

  "config": {
    "type": "object",
    "properties": {
      "api_key": {
        "type": "string",
        "description": "API key",
        "encrypted": true
      }
    }
  }
}
```

## Dependency Management

**Problem:** Plugins need external dependencies (packages, libraries)

**Solution:** Automatic isolated environments per plugin

### Python Plugins

**Implementation:** PluginEnvironmentManager

**Process:**
1. Check if `~/.ally/plugin-envs/plugin-name/` exists
2. If not:
   - Create venv: `python3 -m venv ~/.ally/plugin-envs/plugin-name/`
   - Install: `pip install -r requirements.txt`
   - Mark as installed: `.installed` file
3. Use venv Python: `~/.ally/plugin-envs/plugin-name/bin/python3`
4. Subsequent loads use cached venv (instant)

**Plugin manifest:**
```json
{
  "runtime": "python3",
  "dependencies": {
    "file": "requirements.txt"
  }
}
```

Code Ally automatically:
- Creates isolated venv
- Installs dependencies
- Injects correct Python interpreter

**Example requirements.txt:**
```
requests==2.31.0
beautifulsoup4==4.12.0
```

### Future: Node.js Support

Planned for future:
```json
{
  "runtime": "node",
  "dependencies": {
    "file": "package.json"
  }
}
```

Would create `~/.ally/plugin-envs/plugin-name/node_modules/`

## Plugin Activation

### Activation Modes

**always:**
- Plugin tools always available to LLM
- Auto-activated on every session
- Good for: Core utilities, frequently-used tools

**tagged:**
- Plugin tools only available when activated
- Activate with `+plugin-name` in message
- Good for: Domain-specific tools, rarely-used plugins

### Activation Flow

```
User: "+weather get forecast for Seattle"
    ↓
Agent.sendMessage()
    ↓
PluginActivationManager.parseAndActivateTags()
    ├─ Extracts "weather" from "+weather"
    ├─ Validates plugin exists
    ├─ Adds to session.active_plugins
    └─ SessionManager.autoSave()
    ↓
System message: "Activated plugins: weather"
    ↓
Agent.getLLMResponse()
    ↓
ToolManager.getFunctionDefinitions()
    ├─ Calls PluginActivationManager.isPluginActive('weather')
    └─ Filters tools by activation state
    ↓
LLM receives only active plugin tools
```

### Deactivation

```
User: "-weather"
    ↓
PluginActivationManager.deactivate('weather')
    ├─ Removes from active_plugins
    └─ SessionManager.autoSave()
    ↓
System message: "Deactivated plugins: weather"
```

### Persistence

Active plugins saved in session file:
```json
{
  "id": "session-123",
  "active_plugins": ["weather", "github"],
  "messages": [...]
}
```

Resume session → plugins auto-activated

## Tool Wrappers

### ExecutableToolWrapper

**Purpose:** Wrap executable plugin tools

**Execution flow:**
```typescript
async execute(args: any, callId: string): Promise<ToolResult> {
  // 1. Emit TOOL_CALL_START event
  this.emitEvent({
    type: ActivityEventType.TOOL_CALL_START,
    data: { toolName: this.name, arguments: args }
  });

  // 2. Spawn process
  const process = spawn(command, args, {
    cwd: pluginDir,
    env: { ...process.env }
  });

  // 3. Write JSON request to stdin
  process.stdin.write(JSON.stringify(args));
  process.stdin.end();

  // 4. Collect stdout
  let output = '';
  process.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });

  // 5. Wait for exit
  await processExit;

  // 6. Parse JSON response
  const result = JSON.parse(output);

  // 7. Emit TOOL_CALL_END event
  this.emitEvent({
    type: ActivityEventType.TOOL_CALL_END,
    data: { toolName: this.name, result }
  });

  return result;
}
```

**Venv injection:**
```typescript
// If plugin has Python runtime
if (manifest.runtime === 'python3') {
  const venvPython = `${PLUGIN_ENVS_DIR}/${pluginName}/bin/python3`;
  if (fs.existsSync(venvPython)) {
    command = venvPython; // Use venv Python instead
  }
}
```

### BackgroundToolWrapper

**Purpose:** Wrap background RPC plugin tools

**Execution flow:**
```typescript
async execute(args: any, callId: string): Promise<ToolResult> {
  // 1. Check daemon health
  const healthy = await this.processManager.checkHealth(pluginName);
  if (!healthy) {
    await this.processManager.restart(pluginName);
  }

  // 2. Send JSON-RPC request
  const result = await this.socketClient.sendRequest({
    jsonrpc: '2.0',
    id: callId,
    method: toolName,
    params: args
  });

  // 3. Return result
  return result;
}
```

## Background Process Management

### Lifecycle

**Start:**
```typescript
async start(pluginName: string): Promise<void> {
  // 1. Spawn daemon process
  const process = spawn(command, args, {
    cwd: pluginDir,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // 2. Wait for socket to be created
  await waitForSocket(socketPath, timeout);

  // 3. Verify initial health
  await this.checkHealth(pluginName);

  // 4. Start periodic health checks
  this.startHealthMonitoring(pluginName);
}
```

**Health monitoring:**
```typescript
async checkHealth(pluginName: string): Promise<boolean> {
  try {
    const response = await socketClient.sendRequest({
      jsonrpc: '2.0',
      method: 'ping',
      id: 'health-check'
    }, { timeout: 5000 });

    return response.result === 'pong';
  } catch (error) {
    return false;
  }
}
```

**Restart:**
```typescript
async restart(pluginName: string): Promise<void> {
  logger.warn(`Restarting unhealthy daemon: ${pluginName}`);
  await this.stop(pluginName);
  await this.start(pluginName);
}
```

**Stop:**
```typescript
async stop(pluginName: string): Promise<void> {
  const process = this.processes.get(pluginName);

  // 1. Send SIGTERM (graceful)
  process.kill('SIGTERM');

  // 2. Wait up to 5 seconds
  await waitForExit(process, 5000);

  // 3. Force kill if still running
  if (!process.killed) {
    process.kill('SIGKILL');
  }

  // 4. Clean up socket file
  fs.unlinkSync(socketPath);
}
```

## Event Subscriptions

Background plugins can subscribe to ActivityStream events.

### Plugin manifest:
```json
{
  "background": {
    "events": [
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "AGENT_START"
    ]
  }
}
```

### EventSubscriptionManager:

```typescript
// Subscribe plugin to events
for (const eventType of manifest.background.events) {
  activityStream.subscribe(eventType, async (event) => {
    // Forward to plugin via JSON-RPC
    await socketClient.notify({
      jsonrpc: '2.0',
      method: 'on_event',
      params: {
        type: event.type,
        data: event.data,
        timestamp: event.timestamp
      }
    });
  });
}
```

### Plugin daemon receives:
```python
# Plugin daemon.py
def on_event(params):
    event_type = params['type']
    event_data = params['data']

    if event_type == 'TOOL_CALL_START':
        log(f"Tool {event_data['toolName']} started")
    elif event_type == 'AGENT_START':
        log("Agent started processing")
```

**Use cases:**
- Logging/telemetry
- Caching (pre-fetch on AGENT_START)
- Coordination between plugins
- State management

## Socket Communication

### JSON-RPC Protocol

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "call-123",
  "method": "my_tool",
  "params": {
    "input": "value"
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "call-123",
  "result": {
    "success": true,
    "data": "result"
  }
}
```

**Error:**
```json
{
  "jsonrpc": "2.0",
  "id": "call-123",
  "error": {
    "code": -32000,
    "message": "Error message"
  }
}
```

**Notification (no response expected):**
```json
{
  "jsonrpc": "2.0",
  "method": "on_event",
  "params": {
    "type": "TOOL_CALL_START",
    "data": {}
  }
}
```

### SocketClient Implementation

```typescript
async sendRequest(
  request: JSONRPCRequest,
  options?: { timeout?: number }
): Promise<JSONRPCResponse> {
  // 1. Connect to Unix socket
  const socket = net.createConnection(socketPath);

  // 2. Send request
  socket.write(JSON.stringify(request) + '\n');

  // 3. Wait for response
  const response = await this.waitForResponse(socket, request.id, options.timeout);

  // 4. Close socket
  socket.end();

  return response;
}
```

## Security Considerations

### Isolation

**Process isolation:**
- Plugins run in separate processes
- Can't directly access Code Ally internals
- Limited to stdio/socket communication

**Environment isolation:**
- Python plugins get dedicated venvs
- Dependencies don't conflict
- Can use different versions

### Validation

**Manifest validation:**
- Required fields checked
- Schema validated
- Tool names must be unique

**Argument validation:**
- Tool schemas enforced
- Type checking
- Required parameters validated

### Permission system

**Confirmation prompts:**
```json
{
  "tools": [{
    "requiresConfirmation": true
  }]
}
```

User must approve before execution.

### Sandboxing limitations

**Current:**
- Process-level isolation
- No filesystem restrictions
- Network access allowed

**Recommendations:**
- Review plugin source before installing
- Use requiresConfirmation for destructive ops
- Consider containerization for untrusted plugins

## Performance

### Executable plugins

**Pros:**
- No persistent memory usage
- Natural resource cleanup

**Cons:**
- Process spawn overhead (~10-50ms)
- Cold starts every call

**Best for:** Infrequent calls, simple operations

### Background RPC plugins

**Pros:**
- Single initialization cost
- Fast subsequent calls (<1ms overhead)
- Request caching possible

**Cons:**
- Persistent memory usage
- Need health monitoring

**Best for:** Frequent calls, heavy initialization

### Optimization tips

1. **Batch operations:** Combine multiple calls
2. **Cache results:** In background plugins
3. **Lazy loading:** Don't load unused plugins
4. **Tagged mode:** Reduce tool context for LLM

## Troubleshooting

### Plugin not loading

```bash
# Check plugin directory
ls ~/.ally/plugins/my-plugin/

# Verify manifest
cat ~/.ally/plugins/my-plugin/plugin.json | jq

# Check logs
ally --debug
```

### Dependencies not installing

```bash
# Force reinstall
rm -rf ~/.ally/plugin-envs/my-plugin/
# Restart Code Ally

# Check Python version
python3 --version  # Requires 3.8+

# Manual install to test
cd ~/.ally/plugins/my-plugin/
python3 -m venv test-venv
test-venv/bin/pip install -r requirements.txt
```

### Background daemon not starting

```bash
# Check if socket exists
ls /tmp/my-plugin-*.sock

# Test daemon manually
cd ~/.ally/plugins/my-plugin/
python3 daemon.py

# Check daemon logs
# (stderr is captured by BackgroundProcessManager)
```

### Tool not activating

```bash
# Check activation mode
cat ~/.ally/plugins/my-plugin/plugin.json | jq .activationMode

# Try manual activation
/plugin activate my-plugin

# Check active plugins
/plugin active
```

## Plugin Examples

See `examples/plugins/` for:
- Executable plugin template
- Background RPC plugin template
- Event subscription example
- Configuration example

## Further Reading

- [Plugin Development Guide](../guides/plugin-development.md)
- [Configuration Reference](../reference/configuration.md)
- Source: `src/plugins/`
