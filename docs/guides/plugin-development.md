# Plugin Development Guide

Create custom tools for Code Ally without modifying core code.

## Quick Start

### 1. Create Plugin Directory

```bash
mkdir -p ~/.ally/plugins/my-plugin
cd ~/.ally/plugins/my-plugin
```

### 2. Create Manifest

**File:** `plugin.json`

**Python example:**
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Brief description visible to LLM",
  "author": "Your Name",
  "runtime": "python3",
  "activationMode": "tagged",
  "tools": [
    {
      "name": "my_tool",
      "type": "executable",
      "command": "python3",
      "args": ["tool.py"],
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
  ]
}
```

**Node.js example:**
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Brief description visible to LLM",
  "author": "Your Name",
  "runtime": "node",
  "activationMode": "tagged",
  "tools": [
    {
      "name": "my_tool",
      "type": "executable",
      "command": "npx",
      "args": ["tsx", "tool.ts"],
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
  ]
}
```

### 3. Create Tool Implementation

**Python (tool.py):**

```python
#!/usr/bin/env python3
import json
import sys

def main():
    # Read request from stdin
    request = json.loads(sys.stdin.read())
    input_value = request.get('input', '')

    # Process
    result = process_input(input_value)

    # Write response to stdout
    response = {
        'success': True,
        'error': '',
        'result': result
    }
    print(json.dumps(response))

def process_input(input_value):
    # Your logic here
    return f"Processed: {input_value}"

if __name__ == '__main__':
    main()
```

**Node.js/TypeScript (tool.ts):**

```typescript
#!/usr/bin/env node

interface InputData {
  input: string;
}

async function main(): Promise<void> {
  try {
    // Read request from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }

    const request: InputData = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    const inputValue = request.input || '';

    // Process
    const result = processInput(inputValue);

    // Write response to stdout
    const response = {
      success: true,
      error: '',
      result: result
    };
    console.log(JSON.stringify(response));

  } catch (e) {
    console.log(JSON.stringify({
      success: false,
      error: `Error: ${(e as Error).message}`
    }));
    process.exit(1);
  }
}

function processInput(inputValue: string): string {
  // Your logic here
  return `Processed: ${inputValue}`;
}

main();
```

### 4. Test Plugin

```bash
# Start Code Ally
ally

# Activate plugin (if tagged mode)
+my-plugin

# Use tool
"Use my_tool with input 'test'"
```

## Custom Agents

Plugins can provide **custom AI agents** with specialized behaviors, system prompts, and tool access.

### Quick Example

**1. Add agent to plugin.json:**

```json
{
  "name": "my-plugin",
  "tools": [...],
  "agents": [
    {
      "name": "my-agent",
      "description": "Specialized agent for my domain",
      "system_prompt_file": "agent.md"
    }
  ]
}
```

**2. Create agent definition file:**

**File:** `agent.md`

```markdown
---
name: my-agent
description: Specialized agent for database operations
model: claude-3-5-sonnet-20241022
temperature: 0.3
tools: ["read", "write", "my_tool"]
---

You are a specialized database agent.
Help users with queries, schema design, and optimization.
```

**3. Use the agent:**

```bash
# Main agent delegates task
"Delegate to my-agent: analyze the schema"
```

### Agent Definition Format

Agents use **markdown with YAML frontmatter**:

```markdown
---
name: agent-name
description: Brief description
model: claude-3-5-sonnet-20241022
temperature: 0.7
tools: ["read", "write", "my_tool"]
---

System prompt defining agent behavior.
```

**Fields:**
- `name`: Agent identifier (required, must match manifest)
- `description`: Brief description for selection (required)
- `model`: Model to use (optional, defaults to config)
- `temperature`: 0.0-1.0 (optional, defaults to config)
- `reasoning_effort`: "low", "medium", "high" (optional)
- `tools`: Array of allowed tool names (optional, see below)
- `usage_guidelines`: Instructions for main agent on when/how to use this agent (optional)
- `requirements`: Tool usage requirements to prevent hallucination (optional)

### Tool Scoping

**Default behavior (no `tools` field):**

Plugin agents automatically get:
- All core tools (read, write, bash, grep, etc.)
- Only the plugin's own tools

```markdown
---
name: my-agent
# No tools field → gets core + plugin tools
---
```

**Explicit tools:**

```markdown
---
name: restricted-agent
tools: ["read", "my_tool"]
# Only these tools available
---
```

### Tool-Agent Binding

Bind tools to specific agents with `visible_to`:

```json
{
  "tools": [{
    "name": "database_query",
    "description": "Execute database queries",
    "visible_to": ["database-agent"],
    "command": "python3",
    "args": ["query.py"]
  }]
}
```

**Effect:** Tool is only visible and executable by agents in the `visible_to` array. Empty or missing array means visible to all agents (including main Ally).

### Usage Guidelines

Provide instructions to the main agent about when and how to use your specialized agent:

```markdown
---
name: my-agent
usage_guidelines: |
  **When to use:** User asks for database operations
  **When NOT to use:** Simple file operations
  **CRITICAL:** If agent fails, pass response verbatim to user
---
```

**Injected into main agent's system prompt** to help with agent selection.

### Agent Requirements

Prevent hallucination by requiring tool use before agent completes:

```markdown
---
name: math-expert
tools: ["add", "subtract", "multiply", "divide", "cannot_calculate"]
requirements:
  required_tools_one_of: ["add", "subtract", "multiply", "divide", "cannot_calculate"]
  require_tool_use: true
  max_retries: 2
  reminder_message: "Use your tools to calculate, or call cannot_calculate if unable"
---
```

**Requirement types:**
- `required_tools_one_of`: At least one tool from list must be called successfully
- `required_tools_all`: All tools must be called successfully
- `minimum_tool_calls`: Minimum number of successful tool calls
- `require_tool_use`: At least one successful tool call required
- `max_retries`: Retry limit before allowing exit (default: 2)
- `reminder_message`: Custom reminder when requirements not met

**Only successful calls count** (where `success: true` in tool response).

### Complete Example

**plugin.json:**

```json
{
  "name": "database-tools",
  "version": "1.0.0",
  "description": "Database tools with specialized agent",

  "tools": [
    {
      "name": "query_db",
      "description": "Execute SQL query",
      "command": "python3",
      "args": ["query.py"],
      "visible_to": ["database-agent"]
    },
    {
      "name": "explain_query",
      "description": "Explain query plan",
      "command": "python3",
      "args": ["explain.py"]
    }
  ],

  "agents": [{
    "name": "database-agent",
    "description": "SQL expert and query optimizer",
    "system_prompt_file": "database-agent.md",
    "model": "claude-3-5-sonnet-20241022",
    "temperature": 0.2
  }]
}
```

**database-agent.md:**

```markdown
---
name: database-agent
description: SQL query optimization specialist
temperature: 0.2
tools: ["read", "query_db", "explain_query"]
---

You are a database specialist with SQL expertise.

Workflow:
1. Read and understand schema
2. Validate SQL syntax
3. Use EXPLAIN for optimization
4. Check for injection vulnerabilities

Never execute destructive queries without confirmation.
```

**For full documentation on plugin agents, see:**
- [Plugin Agents Guide](../plugin-agents.md) - Complete reference
- Architecture details below

## Executable Plugins

### Overview

**Model:** Spawn process per call

**Communication:** JSON via stdin/stdout

**Best for:** Simple, stateless operations

### Tool Implementation

```python
#!/usr/bin/env python3
import json
import sys

def main():
    try:
        # 1. Read and parse request
        request = json.loads(sys.stdin.read())

        # 2. Validate parameters
        if 'required_param' not in request:
            print(json.dumps({
                'success': False,
                'error': 'required_param is missing',
                'error_type': 'validation_error'
            }))
            return

        # 3. Execute logic
        result = do_work(request['required_param'])

        # 4. Return success response
        print(json.dumps({
            'success': True,
            'error': '',
            'result': result,
            'metadata': {
                'processed_at': time.time()
            }
        }))

    except Exception as e:
        # 5. Return error response
        print(json.dumps({
            'success': False,
            'error': str(e),
            'error_type': 'system_error'
        }))

def do_work(param):
    # Your implementation
    return f"Result for {param}"

if __name__ == '__main__':
    main()
```

### Request Format

Code Ally sends JSON to stdin:

```json
{
  "param1": "value1",
  "param2": 42,
  "param3": ["array", "values"]
}
```

### Response Format

Tool must write JSON to stdout:

**Success:**
```json
{
  "success": true,
  "error": "",
  "result": "your result",
  "any_other_field": "allowed"
}
```

**Error:**
```json
{
  "success": false,
  "error": "Error description",
  "error_type": "validation_error",
  "suggestion": "How to fix it"
}
```

**Error types:**
- `validation_error`: Invalid parameters
- `user_error`: User-facing error (file not found, etc.)
- `system_error`: Internal error
- `permission_error`: Access denied

### Tool Schema

Define parameters using JSON Schema:

```json
{
  "tools": [{
    "schema": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Path to file"
        },
        "limit": {
          "type": "number",
          "description": "Max results"
        },
        "recursive": {
          "type": "boolean",
          "description": "Search recursively"
        },
        "patterns": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Patterns to match"
        }
      },
      "required": ["file_path"]
    }
  }]
}
```

**Supported types:**
- `string`
- `number`
- `boolean`
- `array` (with `items` schema)
- `object` (with `properties` schema)

### Dependencies

#### Python Dependencies

**With requirements.txt:**

```json
{
  "runtime": "python3",
  "dependencies": {
    "file": "requirements.txt"
  }
}
```

**File:** `requirements.txt`
```
requests==2.31.0
beautifulsoup4==4.12.0
pandas==2.0.0
```

Code Ally automatically:
- Creates virtual environment in `~/.ally/plugin-envs/my-plugin/`
- Installs dependencies with pip
- Uses venv Python when executing tool

**First load:** ~10-15 seconds (one-time setup)
**Subsequent loads:** Instant (cached)

#### Node.js Dependencies

**With package.json:**

```json
{
  "runtime": "node",
  "dependencies": {
    "file": "package.json"
  }
}
```

**File:** `package.json`
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

Code Ally automatically:
- Creates node_modules in `~/.ally/plugin-envs/my-plugin/`
- Runs `npm install`
- Sets NODE_PATH environment variable

**First load:** ~10-20 seconds (one-time setup)
**Subsequent loads:** Instant (cached)

### Multiple Tools

One plugin can provide multiple tools:

```json
{
  "tools": [
    {
      "name": "search",
      "command": "python3",
      "args": ["tool.py", "search"]
    },
    {
      "name": "index",
      "command": "python3",
      "args": ["tool.py", "index"]
    }
  ]
}
```

**Implementation:**

```python
import sys
import json

def main():
    command = sys.argv[1] if len(sys.argv) > 1 else 'search'
    request = json.loads(sys.stdin.read())

    if command == 'search':
        result = do_search(request)
    elif command == 'index':
        result = do_index(request)
    else:
        result = {'success': False, 'error': 'Unknown command'}

    print(json.dumps(result))
```

## Background RPC Plugins

### Overview

**Model:** Long-running daemon, multiple requests

**Communication:** JSON-RPC over Unix socket

**Best for:** Stateful services, heavy initialization, high frequency

### Daemon Implementation

**File:** `daemon.py`

```python
#!/usr/bin/env python3
import json
import socket
import os

class PluginDaemon:
    def __init__(self, socket_path):
        self.socket_path = socket_path
        self.state = {}  # Persistent state

        # Heavy initialization here
        self.initialize_resources()

    def initialize_resources(self):
        # Load models, connect to databases, etc.
        pass

    def run(self):
        # Remove old socket if exists
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)

        # Create Unix socket
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.socket_path)
        server.listen(1)

        print(f"Daemon listening on {self.socket_path}", flush=True)

        while True:
            conn, _ = server.accept()
            self.handle_connection(conn)

    def handle_connection(self, conn):
        # Read request
        data = b''
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
            if b'\n' in data:
                break

        # Parse JSON-RPC request
        request = json.loads(data.decode())

        # Handle request
        response = self.handle_request(request)

        # Send response
        conn.sendall((json.dumps(response) + '\n').encode())
        conn.close()

    def handle_request(self, request):
        method = request.get('method')
        params = request.get('params', {})
        request_id = request.get('id')

        # Health check
        if method == 'ping':
            return {
                'jsonrpc': '2.0',
                'id': request_id,
                'result': 'pong'
            }

        # Event notification
        if method == 'on_event':
            self.handle_event(params)
            return None  # No response for notifications

        # Tool methods
        if method == 'my_tool':
            result = self.my_tool(params)
            return {
                'jsonrpc': '2.0',
                'id': request_id,
                'result': result
            }

        # Unknown method
        return {
            'jsonrpc': '2.0',
            'id': request_id,
            'error': {
                'code': -32601,
                'message': f'Method not found: {method}'
            }
        }

    def my_tool(self, params):
        # Tool implementation
        # Can use self.state for caching
        input_value = params.get('input', '')
        result = process(input_value)

        return {
            'success': True,
            'error': '',
            'result': result
        }

    def handle_event(self, event):
        # Handle ActivityStream events
        event_type = event['type']
        event_data = event['data']

        if event_type == 'TOOL_CALL_START':
            # Pre-fetch data, warm caches, etc.
            pass

if __name__ == '__main__':
    socket_path = os.environ.get('SOCKET_PATH', '/tmp/my-plugin.sock')
    daemon = PluginDaemon(socket_path)
    daemon.run()
```

### Manifest for Background Plugin

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Background RPC plugin",

  "runtime": "python3",
  "dependencies": {
    "file": "requirements.txt"
  },

  "tools": [
    {
      "name": "my_tool",
      "type": "background_rpc",
      "description": "Tool description",
      "schema": {
        "type": "object",
        "properties": {
          "input": { "type": "string" }
        }
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
      "AGENT_START"
    ]
  }
}
```

### Event Subscriptions

Background plugins can subscribe to events:

**Available events:**
- `TOOL_CALL_START`: Tool execution begins
- `TOOL_CALL_END`: Tool execution completes
- `TOOL_OUTPUT_CHUNK`: Streaming output
- `AGENT_START`: Agent begins processing
- `AGENT_END`: Agent finishes
- `USER_INTERRUPT_INITIATED`: User pressed Escape
- `INTERRUPT_ALL`: Interrupt propagation

**Handler:**
```python
def handle_event(self, event):
    event_type = event['type']
    event_data = event['data']
    timestamp = event['timestamp']

    if event_type == 'AGENT_START':
        # Warm caches before agent runs
        self.prepare_for_requests()

    elif event_type == 'TOOL_CALL_START':
        tool_name = event_data['toolName']
        # Log tool usage
        self.log_tool_call(tool_name)
```

## Plugin Configuration

### Interactive Configuration

**Manifest:**
```json
{
  "config": {
    "type": "object",
    "properties": {
      "api_key": {
        "type": "string",
        "description": "API key for service",
        "encrypted": true
      },
      "endpoint": {
        "type": "string",
        "description": "API endpoint URL",
        "default": "https://api.example.com"
      },
      "timeout": {
        "type": "number",
        "description": "Request timeout in seconds",
        "default": 30
      }
    },
    "required": ["api_key"]
  }
}
```

**First load:** Code Ally prompts for configuration

**Access in tool:**
```python
# Config passed as environment variable
api_key = os.environ.get('PLUGIN_CONFIG_API_KEY')
endpoint = os.environ.get('PLUGIN_CONFIG_ENDPOINT')
```

**Reconfigure:**
```bash
/plugin configure my-plugin
```

### Encrypted Fields

Fields marked `"encrypted": true` are encrypted at rest:
- Stored in `~/.ally/config.json` encrypted
- Decrypted when passed to plugin
- Good for API keys, passwords, tokens

## Activation Modes

### Always Mode

```json
{
  "activationMode": "always"
}
```

**Behavior:**
- Plugin tools always available to LLM
- Auto-activated every session
- Good for frequently-used tools

### Tagged Mode

```json
{
  "activationMode": "tagged"
}
```

**Behavior:**
- Plugin tools only available when activated
- User activates with `+plugin-name`
- Good for domain-specific tools

**Usage:**
```
User: "+github list my repositories"
→ Activates github plugin for this session

User: "-github"
→ Deactivates github plugin
```

## Best Practices

### Tool Design

**Do:**
- Use clear, descriptive tool names
- Write concise descriptions (LLM sees them)
- Validate parameters thoroughly
- Return structured results
- Handle errors gracefully

**Don't:**
- Create tools that require manual interaction
- Return huge outputs (>10KB)
- Make assumptions about environment
- Use tool names that conflict with built-ins

### Error Handling

**Good:**
```python
try:
    result = risky_operation()
    return {
        'success': True,
        'error': '',
        'result': result
    }
except FileNotFoundError as e:
    return {
        'success': False,
        'error': f'File not found: {e.filename}',
        'error_type': 'user_error',
        'suggestion': 'Check the file path and try again'
    }
except Exception as e:
    return {
        'success': False,
        'error': str(e),
        'error_type': 'system_error'
    }
```

### Performance

**Executable plugins:**
- Keep initialization fast (<100ms)
- Avoid unnecessary imports
- Use tagged mode if rarely used

**Background plugins:**
- Cache aggressively
- Use event subscriptions to pre-fetch
- Monitor memory usage
- Implement proper cleanup

### Security

**Validation:**
- Validate all parameters
- Sanitize file paths
- Escape shell commands
- Verify URLs

**Permissions:**
```json
{
  "tools": [{
    "requiresConfirmation": true
  }]
}
```

Use for destructive operations.

**Principle of least privilege:**
- Don't request unnecessary permissions
- Don't access files outside CWD
- Don't make network requests unless needed

## Testing

### Manual Testing

**Python executable:**
```bash
echo '{"input": "test"}' | python3 tool.py
```

**Node.js executable:**
```bash
echo '{"input": "test"}' | npx tsx tool.ts
```

**Python daemon:**
```bash
python3 daemon.py &
DAEMON_PID=$!
echo '{"jsonrpc":"2.0","id":"1","method":"ping"}' | nc -U /tmp/my-plugin.sock
kill $DAEMON_PID
```

### Integration Testing

```bash
# Start Code Ally
ally

# Activate plugin
+my-plugin

# Test tool
"use my_tool with input 'test'"

# Check logs
ally --debug
```

### Unit Testing

```python
# test_tool.py
import json
import subprocess

def test_tool():
    request = json.dumps({'input': 'test'})
    result = subprocess.run(
        ['python3', 'tool.py'],
        input=request.encode(),
        capture_output=True
    )

    response = json.loads(result.stdout)
    assert response['success'] is True
    assert 'result' in response
```

## Debugging

### Enable Debug Logging

```bash
ally --debug
```

### Check Plugin Loading

```bash
# List loaded plugins
/plugin list

# Check plugin status
/plugin info my-plugin
```

### Test Dependencies

**Python:**
```bash
# Check venv
ls ~/.ally/plugin-envs/my-plugin/

# List installed packages
~/.ally/plugin-envs/my-plugin/bin/pip list

# Force reinstall
rm -rf ~/.ally/plugin-envs/my-plugin/
# Restart ally
```

**Node.js:**
```bash
# Check node_modules
ls ~/.ally/plugin-envs/my-plugin/node_modules/

# List installed packages
cd ~/.ally/plugin-envs/my-plugin && npm list

# Force reinstall
rm -rf ~/.ally/plugin-envs/my-plugin/
# Restart ally
```

### Common Issues

**Plugin not loading:**
- Check `plugin.json` syntax: `cat plugin.json | jq`
- Verify required fields present
- Check logs: `ally --debug`

**Tool not executing:**
- Test manually (Python): `echo '{}' | python3 tool.py`
- Test manually (Node.js): `echo '{}' | npx tsx tool.ts`
- Check runtime: `which python3` or `which node`
- Verify script has execute permissions

**Dependencies not installing:**
- Python: Check version `python3 --version` (need 3.8+)
- Python: Test manual install `python3 -m venv test && test/bin/pip install -r requirements.txt`
- Node.js: Check version `node --version` (need 16+)
- Node.js: Test manual install `npm install` in plugin directory
- Check network connection

**Daemon not starting:**
- Test manually: `python3 daemon.py`
- Check socket path permissions
- Verify socket cleanup on restart

## Examples

### Weather Plugin (Python Executable)

```python
#!/usr/bin/env python3
import json
import sys
import requests

def main():
    request = json.loads(sys.stdin.read())
    location = request.get('location')

    if not location:
        print(json.dumps({
            'success': False,
            'error': 'location is required'
        }))
        return

    # Fetch weather
    api_key = os.environ.get('PLUGIN_CONFIG_API_KEY')
    response = requests.get(
        f'https://api.weather.com/forecast?location={location}&key={api_key}'
    )

    if response.status_code != 200:
        print(json.dumps({
            'success': False,
            'error': f'API error: {response.status_code}'
        }))
        return

    weather = response.json()

    print(json.dumps({
        'success': True,
        'error': '',
        'temperature': weather['temp'],
        'conditions': weather['conditions'],
        'forecast': weather['forecast']
    }))

if __name__ == '__main__':
    main()
```

### String Reverser (Node.js Executable)

```typescript
#!/usr/bin/env node
import { stdin, stdout } from 'process';

interface InputData {
  text: string;
  preserve_case?: boolean;
}

interface Result {
  success: boolean;
  error?: string;
  reversed?: string;
  original?: string;
}

async function main(): Promise<void> {
  try {
    // Read JSON from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(chunk as Buffer);
    }

    const input: InputData = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    const text = input.text || '';
    const preserveCase = input.preserve_case !== false;

    if (!text) {
      const error: Result = {
        success: false,
        error: 'Missing required parameter: text'
      };
      console.log(JSON.stringify(error));
      return;
    }

    // Reverse the string
    let reversed = text.split('').reverse().join('');
    if (!preserveCase) {
      reversed = reversed.toLowerCase();
    }

    const result: Result = {
      success: true,
      original: text,
      reversed: reversed
    };
    console.log(JSON.stringify(result));

  } catch (e) {
    const error: Result = {
      success: false,
      error: `Unexpected error: ${(e as Error).message}`
    };
    console.log(JSON.stringify(error));
    process.exit(1);
  }
}

main();
```

**plugin.json for Node.js example:**
```json
{
  "name": "string-reverser",
  "version": "1.0.0",
  "runtime": "node",
  "dependencies": {
    "file": "package.json"
  },
  "tools": [{
    "name": "reverse_string",
    "command": "npx",
    "args": ["tsx", "reverse.ts"],
    "schema": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "description": "Text to reverse"
        },
        "preserve_case": {
          "type": "boolean",
          "description": "Preserve case (default: true)"
        }
      },
      "required": ["text"]
    }
  }]
}
```

### Database Plugin (Background RPC)

```python
#!/usr/bin/env python3
import json
import socket
import sqlite3

class DatabaseDaemon:
    def __init__(self, socket_path):
        self.socket_path = socket_path
        # Keep connection alive
        self.db = sqlite3.connect('data.db')
        self.cursor = self.db.cursor()

    def query(self, params):
        sql = params.get('sql')

        try:
            self.cursor.execute(sql)
            rows = self.cursor.fetchall()

            return {
                'success': True,
                'error': '',
                'rows': rows,
                'count': len(rows)
            }
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }

    # ... (rest of daemon implementation)
```

## Publishing Plugins

### Share Privately

Distribute plugin directory:
```bash
tar -czf my-plugin.tar.gz ~/.ally/plugins/my-plugin/
```

Install:
```bash
cd ~/.ally/plugins/
tar -xzf my-plugin.tar.gz
```

### Share Publicly

Create GitHub repository:
```
my-plugin/
├── README.md
├── plugin.json
├── tool.py
├── requirements.txt
└── examples/
```

Users install:
```bash
cd ~/.ally/plugins/
git clone https://github.com/user/my-plugin.git
```

## Further Reading

- [Plugin System Architecture](../architecture/plugin-system.md)
- [Architecture Overview](../architecture/overview.md)
- [Configuration Reference](../reference/configuration.md)
- Examples: `examples/plugins/`
