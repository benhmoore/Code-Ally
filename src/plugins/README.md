# Plugin System

Extensible plugin architecture for Code Ally with automatic dependency management and two execution models.

## Overview

The plugin system enables adding custom tools without modifying core code. Plugins are discovered automatically from the active profile's plugins directory (e.g., `~/.ally/profiles/default/plugins/`) and integrated into the tool execution pipeline.

## Architecture

```
PluginLoader
    ├─ Discovers plugins in profile-specific directory
    ├─ Validates manifests (plugin.json)
    ├─ Manages dependencies (PluginEnvironmentManager)
    ├─ Creates tool wrappers
    │   ├─ ExecutableToolWrapper (stdio JSON)
    │   └─ BackgroundToolWrapper (JSON-RPC)
    └─ Registers tools with ToolManager

PluginActivationManager
    ├─ Controls which plugins are active per session
    ├─ Parses +plugin-name tags from user input
    └─ Filters tools sent to LLM

BackgroundProcessManager
    ├─ Manages daemon lifecycle
    ├─ Health monitoring (ping/pong)
    └─ Automatic restart on failure

EventSubscriptionManager
    └─ Routes ActivityStream events to background plugins
```

## Plugin Types

### Executable Plugins

**Model:** Spawn process per call

**Communication:** JSON via stdin/stdout

**Implementation:** `ExecutableToolWrapper.ts`

**Flow:**
1. Spawn process with command and args
2. Write JSON request to stdin
3. Read JSON response from stdout
4. Process exits
5. Return result

**Use cases:**
- Simple, stateless operations
- Command-line tool wrappers
- Infrequent calls

### Background RPC Plugins

**Model:** Long-running daemon, multiple requests

**Communication:** JSON-RPC over Unix socket

**Implementation:** `BackgroundToolWrapper.ts`, `SocketClient.ts`

**Flow:**
1. Daemon starts once (via BackgroundProcessManager)
2. Creates Unix socket for communication
3. Multiple requests routed via SocketClient
4. Daemon serves requests until shutdown

**Use cases:**
- Heavy initialization (ML models, database connections)
- Stateful services (caching, session management)
- High-frequency calls
- Event-driven behavior

## Key Components

### PluginLoader

**File:** `PluginLoader.ts` (1,129 lines)

**Responsibilities:**
- Scans profile-specific plugins directory for subdirectories
- Validates `plugin.json` manifests
- Installs dependencies via PluginEnvironmentManager
- Creates ExecutableToolWrapper or BackgroundToolWrapper instances
- Returns array of BaseTool instances for ToolManager

**Public API:**
```typescript
class PluginLoader {
  async loadPlugins(pluginDir: string): Promise<{
    tools: BaseTool[];
    pluginCount: number;
  }>;
}
```

**Error handling:** Non-blocking - one broken plugin doesn't prevent others from loading

### PluginActivationManager

**File:** `PluginActivationManager.ts` (296 lines)

**Responsibilities:**
- Tracks which plugins are active per session
- Parses `+plugin-name` and `-plugin-name` tags from user input
- Filters tools sent to LLM based on activation state
- Persists active plugins to session file

**Activation modes:**
- `always`: Auto-activated every session
- `tagged`: Activated only when user types `+plugin-name`

**Public API:**
```typescript
class PluginActivationManager {
  initialize(plugins: PluginManifest[], session?: Session): void;
  parseAndActivateTags(message: string): string[];
  activate(pluginName: string): void;
  deactivate(pluginName: string): void;
  isPluginActive(pluginName: string): boolean;
  getActivePlugins(): string[];
  saveToSession(session: Session): void;
}
```

### PluginEnvironmentManager

**File:** `PluginEnvironmentManager.ts`

**Responsibilities:**
- Creates isolated virtual environments for plugins
- Currently supports Python (venv + pip)
- Installs dependencies from requirements.txt
- Caches installations for instant subsequent loads

**Process:**
1. Check if profile-specific environment marker exists (e.g., `~/.ally/profiles/default/plugin-envs/plugin-name/.installed`)
2. If not:
   - Create venv: `python3 -m venv <profile>/plugin-envs/plugin-name/`
   - Install: `pip install -r requirements.txt`
   - Create `.installed` marker
3. Return venv Python path: `<profile>/plugin-envs/plugin-name/bin/python3`

**Public API:**
```typescript
class PluginEnvironmentManager {
  async ensureDependencies(
    pluginName: string,
    pluginDir: string,
    manifest: PluginManifest
  ): Promise<string | null>;
}
```

**Performance:**
- First load: ~10-15 seconds (creates venv, installs packages)
- Subsequent loads: Instant (uses cached venv)

### BackgroundProcessManager

**File:** `BackgroundProcessManager.ts`

**Responsibilities:**
- Starts background daemons for RPC plugins
- Health monitoring via periodic ping/pong
- Automatic restart on failure
- Graceful shutdown (SIGTERM → SIGKILL)

**Public API:**
```typescript
class BackgroundProcessManager {
  async start(
    pluginName: string,
    command: string,
    args: string[],
    options: ProcessOptions
  ): Promise<void>;

  async stop(pluginName: string): Promise<void>;
  async stopAll(): Promise<void>;
  async checkHealth(pluginName: string): Promise<boolean>;
  async restart(pluginName: string): Promise<void>;
}
```

**Health monitoring:**
- Periodic ping every 30 seconds (configurable)
- Sends JSON-RPC `ping` request, expects `pong` response
- Automatic restart if health check fails

**Shutdown:**
1. Send SIGTERM (graceful shutdown)
2. Wait up to 5 seconds
3. Send SIGKILL if still running
4. Clean up Unix socket file

### SocketClient

**File:** `SocketClient.ts`

**Responsibilities:**
- JSON-RPC communication over Unix sockets
- Request/response correlation
- Timeout handling
- Connection management

**Public API:**
```typescript
class SocketClient {
  async sendRequest(
    socketPath: string,
    request: JSONRPCRequest,
    timeout?: number
  ): Promise<JSONRPCResponse>;

  async sendNotification(
    socketPath: string,
    notification: JSONRPCNotification
  ): Promise<void>;
}
```

**JSON-RPC format:**

Request:
```json
{
  "jsonrpc": "2.0",
  "id": "call-123",
  "method": "tool_name",
  "params": { "arg": "value" }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": "call-123",
  "result": { "success": true, "data": "..." }
}
```

**Features:**
- Request timeout (default: 30s)
- Automatic reconnection
- Error handling and logging

### EventSubscriptionManager

**File:** `EventSubscriptionManager.ts`

**Responsibilities:**
- Manages plugin subscriptions to ActivityStream events
- Routes events from ActivityStream to background plugins
- Forwards events via SocketClient as JSON-RPC notifications

**Public API:**
```typescript
class EventSubscriptionManager {
  subscribe(
    pluginName: string,
    socketPath: string,
    eventTypes: ActivityEventType[]
  ): void;

  unsubscribe(pluginName: string): void;
  unsubscribeAll(): void;
}
```

**Flow:**
1. Plugin manifest declares event subscriptions
2. EventSubscriptionManager subscribes to ActivityStream
3. When event occurs, forwards to plugin daemon via SocketClient
4. Plugin daemon handles event (e.g., warm caches, log activity)

**Available events:**
- TOOL_CALL_START / TOOL_CALL_END
- AGENT_START / AGENT_END
- TOOL_OUTPUT_CHUNK
- USER_INTERRUPT_INITIATED
- INTERRUPT_ALL

## Tool Wrappers

### ExecutableToolWrapper

**File:** `ExecutableToolWrapper.ts`

**Purpose:** Wraps executable plugin tools (stdio communication)

**Key features:**
- Automatic venv Python injection for Python plugins
- Spawns process per call
- JSON request via stdin, JSON response via stdout
- Timeout enforcement
- Error handling

**Venv injection:**
```typescript
import { join } from 'path';
import { getPluginEnvsDir } from '../config/paths.js';

// If plugin has Python runtime and venv exists
if (manifest.runtime === 'python3') {
  const venvPython = join(getPluginEnvsDir(), pluginName, 'bin', 'python3');
  if (fs.existsSync(venvPython)) {
    this.command = venvPython; // Use venv Python
  }
}
```

### BackgroundToolWrapper

**File:** `BackgroundToolWrapper.ts`

**Purpose:** Wraps background RPC plugin tools (socket communication)

**Key features:**
- Health check before each request
- Automatic daemon restart if unhealthy
- JSON-RPC communication via SocketClient
- Request timeout handling
- Connection pooling

**Health check:**
```typescript
async execute(args: any, callId: string): Promise<ToolResult> {
  // Check daemon health before request
  const healthy = await this.processManager.checkHealth(this.pluginName);
  if (!healthy) {
    await this.processManager.restart(this.pluginName);
  }

  // Send RPC request
  const result = await this.socketClient.sendRequest(
    this.socketPath,
    { jsonrpc: '2.0', id: callId, method: this.name, params: args }
  );

  return result;
}
```

## Plugin Manifest

**File:** `plugin.json` in plugin directory

**Required fields:**
```json
{
  "name": "plugin-name",
  "version": "1.0.0",
  "description": "Description visible to LLM",
  "tools": [
    {
      "name": "tool_name",
      "type": "executable" | "background_rpc",
      "command": "python3",
      "args": ["script.py"],
      "schema": { /* JSON Schema */ }
    }
  ]
}
```

**Optional fields:**
```json
{
  "author": "Author Name",
  "runtime": "python3",
  "dependencies": {
    "file": "requirements.txt"
  },
  "activationMode": "always" | "tagged",
  "background": {
    "enabled": true,
    "command": "python3",
    "args": ["daemon.py"],
    "communication": {
      "type": "socket",
      "path": "/tmp/plugin-{session_id}.sock"
    },
    "health": {
      "interval": 30,
      "timeout": 5
    },
    "events": ["TOOL_CALL_START", "AGENT_START"]
  },
  "config": {
    "type": "object",
    "properties": {
      "api_key": {
        "type": "string",
        "encrypted": true
      }
    }
  }
}
```

## Integration with Core

### CLI Initialization

**File:** `src/cli.ts`

```typescript
// 1. Load plugins
const loader = new PluginLoader(
  activityStream,
  pluginConfigManager,
  socketClient,
  backgroundProcessManager
);
const { tools: pluginTools } = await loader.loadPlugins(PLUGINS_DIR);

// 2. Initialize activation manager
const activationManager = new PluginActivationManager();
activationManager.initialize(pluginManifests, session);

// 3. Create ToolManager with all tools
const allTools = [...builtInTools, ...pluginTools];
const toolManager = new ToolManager(allTools, activityStream, activationManager);
```

### Tool Filtering

**File:** `src/tools/ToolManager.ts`

```typescript
getFunctionDefinitions(): FunctionDefinition[] {
  const definitions = [];

  for (const tool of this.tools.values()) {
    // Always include core tools
    if (tool.isCore) {
      definitions.push(tool.getFunctionDefinition());
      continue;
    }

    // Filter plugins by activation state
    if (this.activationManager?.isPluginActive(tool.pluginName)) {
      definitions.push(tool.getFunctionDefinition());
    }
  }

  return definitions;
}
```

### Tag Parsing

**File:** `src/agent/Agent.ts`

```typescript
async sendMessage(message: string): Promise<string> {
  // Parse activation tags
  const activatedPlugins = this.pluginActivationManager?.parseAndActivateTags(message) || [];

  if (activatedPlugins.length > 0) {
    // Add system message about activation
    this.addMessage({
      role: 'system',
      content: `Activated plugins: ${activatedPlugins.join(', ')}`
    });

    // Save to session
    this.session.active_plugins = this.pluginActivationManager.getActivePlugins();
    this.sessionManager.autoSave();
  }

  // Continue with LLM request...
}
```

## Dependency Management

**Problem:** Plugins need external packages (Python, Node.js, etc.)

**Solution:** Automatic isolated environments per plugin

### Python Support

**Implementation:** PluginEnvironmentManager creates venvs

**Plugin manifest:**
```json
{
  "runtime": "python3",
  "dependencies": {
    "file": "requirements.txt"
  }
}
```

**What happens:**
1. First load: Create venv, install from requirements.txt (~10-15s)
2. Subsequent loads: Use cached venv (instant)
3. ExecutableToolWrapper automatically uses venv Python

No wrapper scripts required.

### Node.js Support

**Implementation:** PluginEnvironmentManager creates node_modules

**Plugin manifest:**
```json
{
  "runtime": "node",
  "dependencies": {
    "file": "package.json"
  }
}
```

**What happens:**
1. First load: Create node_modules, run npm install (~10-20s)
2. Subsequent loads: Use cached modules (instant)
3. NODE_PATH environment variable set to plugin's node_modules
4. Use `npx tsx` for TypeScript execution

**Example package.json:**
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

## Performance Considerations

### Executable Plugins

**Pros:**
- No persistent memory
- Natural cleanup
- Simple implementation

**Cons:**
- Process spawn overhead (~10-50ms per call)
- No state caching
- Can't subscribe to events

**Best for:** Infrequent calls, simple operations

### Background RPC Plugins

**Pros:**
- Single initialization cost
- Fast subsequent calls (<1ms overhead)
- Persistent state/caching
- Event subscriptions

**Cons:**
- Persistent memory usage
- Health monitoring overhead
- More complex implementation

**Best for:** Frequent calls, heavy initialization, stateful services

## Security

### Process Isolation

- Plugins run in separate processes
- Can't directly access Code Ally internals
- Communication limited to stdio/socket

### Environment Isolation

- Python plugins get dedicated venvs
- Dependencies don't conflict
- Different versions possible

### Validation

- Manifest schema validation
- Tool name uniqueness enforced
- Argument validation via schemas

### Permission System

Tools can require confirmation:
```json
{
  "requiresConfirmation": true
}
```

User must approve before execution.

## Error Handling

### Plugin Loading

- Individual plugin failures don't block others
- Comprehensive logging of all errors
- Graceful degradation

### Tool Execution

- Timeout enforcement
- Error responses formatted consistently
- Daemon automatic restart on failure

### Health Monitoring

- Periodic health checks
- Automatic restart on failure
- Logs unhealthy state

## Debugging

Enable debug logging:
```bash
ally --debug
```

**Logs include:**
- Plugin discovery and loading
- Dependency installation
- Tool registration
- Activation/deactivation
- Background process lifecycle
- Health check results
- RPC communication

## Testing

### Manual Testing

```bash
# Test executable plugin
echo '{"input": "test"}' | python3 tool.py

# Test daemon
python3 daemon.py &
echo '{"jsonrpc":"2.0","id":"1","method":"ping"}' | nc -U /tmp/plugin.sock
```

### Integration Testing

```bash
# Load plugin and test
ally
+my-plugin
"use my_tool with input 'test'"
```

## Examples

See `examples/plugins/` for:
- Python executable plugin template
- Node.js executable plugin template (example-node)
- Background RPC plugin template
- Event subscription example

## Further Reading

- [Plugin System Architecture](../../docs/architecture/plugin-system.md)
- [Plugin Development Guide](../../docs/guides/plugin-development.md)
- [Configuration Reference](../../docs/reference/configuration.md)
