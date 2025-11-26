# Plugin Development Guide

Create custom tools and agents for Code Ally.

## Quick Start

### Create a Tool

**1. Create plugin directory:**
```bash
mkdir -p ~/.ally/profiles/default/plugins/my-plugin
cd ~/.ally/profiles/default/plugins/my-plugin
```

**2. Create manifest (`plugin.json`):**
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom plugin",
  "runtime": "python3",
  "activationMode": "tagged",
  "tools": [{
    "name": "my-tool",
    "description": "Does something useful",
    "command": "python3",
    "args": ["tool.py"],
    "schema": {
      "type": "object",
      "properties": {
        "input": { "type": "string", "description": "Input value" }
      },
      "required": ["input"]
    }
  }]
}
```

**3. Create tool (`tool.py`):**
```python
#!/usr/bin/env python3
import json
import sys

def main():
    request = json.loads(sys.stdin.read())
    result = f"Processed: {request.get('input', '')}"
    print(json.dumps({'success': True, 'result': result}))

if __name__ == '__main__':
    main()
```

**4. Use it:**
```bash
ally
+my-plugin              # Activate plugin
"Use my-tool with input 'test'"
```

### Create an Agent

Add to your `plugin.json`:
```json
{
  "agents": [{
    "name": "my-agent",
    "description": "Specialized agent",
    "system_prompt_file": "agent.md"
  }]
}
```

Create `agent.md`:
```markdown
---
name: my-agent
description: Specialized agent for my domain
temperature: 0.3
tools: ["read", "my-tool"]
---

You are a specialized agent. Help users with [domain] tasks.
```

Use it:
```
"Delegate to my-agent: analyze this data"
```

---

## Tools

### Communication Protocol

Tools receive JSON via stdin and write JSON to stdout.

**Request (stdin):**
```json
{"param1": "value1", "param2": 42}
```

**Success response (stdout):**
```json
{"success": true, "result": "your result"}
```

**Error response (stdout):**
```json
{"success": false, "error": "Error description", "error_type": "validation_error"}
```

Error types: `validation_error`, `user_error`, `system_error`, `permission_error`

### Tool Schema

Define parameters with JSON Schema:
```json
{
  "schema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string", "description": "Path to file" },
      "limit": { "type": "number", "description": "Max results" },
      "recursive": { "type": "boolean", "description": "Search recursively" },
      "patterns": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Patterns to match"
      }
    },
    "required": ["file_path"]
  }
}
```

### Multiple Tools

One plugin can provide multiple tools:
```json
{
  "tools": [
    {"name": "search", "command": "python3", "args": ["tool.py", "search"]},
    {"name": "index", "command": "python3", "args": ["tool.py", "index"]}
  ]
}
```

```python
import sys
command = sys.argv[1] if len(sys.argv) > 1 else 'search'
if command == 'search':
    result = do_search(request)
elif command == 'index':
    result = do_index(request)
```

### Tool-Agent Binding

When you give an LLM access to a tool, it will try to use it—even when it shouldn't. A database query tool exposed to a general-purpose agent will get called for tasks better handled by file reads. The agent doesn't know better; it just sees a tool that might work.

Tool-agent binding solves this by making tools invisible to agents that shouldn't use them. The tool only appears in the toolbox of agents you specify. Other agents don't know it exists.

Restrict tools to specific agents:
```json
{
  "tools": [{
    "name": "database-query",
    "visible_to": ["database-agent"],
    "command": "python3",
    "args": ["query.py"]
  }]
}
```

- `visible_to: undefined` or `[]` → visible to all agents
- `visible_to: ["agent1"]` → only visible to specified agents

### Node.js Tools

```json
{
  "runtime": "node",
  "tools": [{
    "name": "my-tool",
    "command": "npx",
    "args": ["tsx", "tool.ts"]
  }]
}
```

```typescript
async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

  const result = { success: true, result: `Processed: ${request.input}` };
  console.log(JSON.stringify(result));
}
main();
```

---

## Agents

### Definition Format

Agents use markdown with YAML frontmatter:

```markdown
---
name: my-agent
description: Brief description for agent selection
model: claude-sonnet-4-5-20250514
temperature: 0.3
reasoning_effort: medium
tools: ["read", "write", "my-tool"]
usage_guidelines: |
  **When to use:** User asks for [specific task]
  **When NOT to use:** [other tasks]
requirements:
  require_tool_use: true
---

You are a specialized agent for [domain].

Your workflow:
1. First step
2. Second step
3. Third step
```

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Agent identifier |
| `description` | string | Yes | Brief description for selection |
| `model` | string | No | Model to use (defaults to config) |
| `temperature` | number | No | 0.0-1.0 (defaults to config) |
| `reasoning_effort` | string | No | "low", "medium", "high" |
| `tools` | string[] | No | Allowed tools (see Tool Scoping) |
| `usage_guidelines` | string | No | Instructions for main agent |
| `requirements` | object | No | Tool usage requirements |
| `visible_from_agents` | string[] | No | Agents that can delegate to this agent |
| `can_delegate_to_agents` | boolean | No | Whether agent can delegate (default: true) |
| `can_see_agents` | boolean | No | Whether agent sees other agents (default: true) |

### Agent Visibility & Delegation

Agents can call other agents. This is powerful—a planning agent can delegate to a coding agent, which delegates to a testing agent. But it can also cause loops, confusion, or security issues if unrestricted.

Three fields control this:

**`visible_from_agents`** - Who can call this agent?
```yaml
visible_from_agents: ["main", "planning-agent"]
```
Only listed agents see this agent in their toolbox. Omit for universal visibility.

**`can_delegate_to_agents`** - Can this agent call other agents?
```yaml
can_delegate_to_agents: false
```
Set `false` to create leaf agents that do work but can't spawn sub-agents. Prevents delegation chains.

**`can_see_agents`** - Does this agent know other agents exist?
```yaml
can_see_agents: false
```
Set `false` to completely isolate an agent. It won't see agent-related tools at all—useful for focused workers that should never delegate.

**Example: Isolated worker agent**
```yaml
---
name: code-reviewer
description: Reviews code for issues
can_delegate_to_agents: false
can_see_agents: false
tools: ["read", "grep", "glob"]
---

You review code. Analyze what you're given and report findings.
Never delegate work—complete the review yourself.
```

This agent can read code but can't call other agents or even know they exist. It's a focused worker.

### Tool Scoping

**Default (no `tools` field):** Plugin agents get core tools + plugin's own tools.

**Explicit:** Only specified tools available.
```yaml
tools: ["read", "grep", "my-tool"]
```

### Usage Guidelines

Help the main agent know when to delegate:
```yaml
usage_guidelines: |
  **When to use:** Database queries, schema analysis
  **When NOT to use:** File operations, general coding
  **CRITICAL:** Pass failures verbatim to user
```

### Requirements

LLMs hallucinate. Ask a math agent "what's 847 × 293?" and it might confidently reply "248,171" without ever calling the calculator tool. It's not lying—it's pattern-matching from training data, and sometimes that produces wrong answers that look right.

Requirements force agents to use their tools. If an agent must call at least one calculation tool before responding, it can't skip straight to a hallucinated answer. The reminder keeps nudging until the agent complies.

Prevent hallucination by requiring tool use:

```yaml
requirements:
  required_tools_one_of: ["add", "subtract", "cannot-calculate"]
  require_tool_use: true
  reminder_message: "Use your tools or call cannot-calculate"
```

| Field | Description |
|-------|-------------|
| `required_tools_one_of` | At least one must be called |
| `required_tools_all` | All must be called |
| `minimum_tool_calls` | Minimum successful calls |
| `require_tool_use` | At least one call required |
| `reminder_message` | Custom reminder text |

Only successful calls (`success: true`) count.

---

## Configuration

### Dependencies

**Python (`requirements.txt`):**
```json
{
  "runtime": "python3",
  "dependencies": {"file": "requirements.txt"}
}
```

**Node.js (`package.json`):**
```json
{
  "runtime": "node",
  "dependencies": {"file": "package.json"}
}
```

Dependencies install to `~/.ally/plugin-envs/[plugin-name]/` on first load.

### Plugin Configuration

Prompt users for config values:
```json
{
  "config": {
    "type": "object",
    "properties": {
      "api_key": {
        "type": "string",
        "description": "API key",
        "secret": true
      },
      "endpoint": {
        "type": "string",
        "default": "https://api.example.com"
      }
    },
    "required": ["api_key"]
  }
}
```

Access in tool via environment:
```python
api_key = os.environ.get('PLUGIN_CONFIG_API_KEY')
```

Reconfigure: `/plugin configure my-plugin`

### Activation Modes

**Always:** Tools always available
```json
{"activationMode": "always"}
```

**Tagged:** User activates with `+plugin-name`
```json
{"activationMode": "tagged"}
```

---

## Testing & Debugging

### Manual Testing

```bash
# Python
echo '{"input": "test"}' | python3 tool.py

# Node.js
echo '{"input": "test"}' | npx tsx tool.ts
```

### Debug Mode

```bash
ally --debug
```

### Plugin Commands

```bash
/plugin list          # List loaded plugins
/plugin info my-plugin  # Check plugin status
```

### Common Issues

**Plugin not loading:**
- Validate JSON: `cat plugin.json | jq`
- Check required fields

**Tool not executing:**
- Test manually: `echo '{}' | python3 tool.py`
- Check runtime: `which python3`

**Dependencies failing:**
- Force reinstall: `rm -rf ~/.ally/plugin-envs/my-plugin/`
- Restart ally

---

## Best Practices

### Tools

- Use clear, descriptive names (kebab-case: `my-tool`, `data-processor`)
- Write concise descriptions (LLM sees them)
- Validate parameters thoroughly
- Return structured results
- Keep outputs under 10KB

### Agents

- Write specific system prompts with clear workflows
- Set appropriate temperature (0.2-0.4 analytical, 0.7+ creative)
- Limit tools to what agent needs
- Use requirements to prevent hallucination

### Security

- Validate all parameters
- Sanitize file paths
- Use `"requiresConfirmation": true` for destructive operations
- Mark sensitive config fields as `"secret": true`

### Naming Convention

All tool and agent names must be kebab-case:
- Valid: `my-tool`, `data-processor`, `api-client`
- Invalid: `my_tool`, `myTool`, `My-Tool`

---

## Examples

See `examples/plugins/` for complete working examples:

- **example-py/** - Python string reverser
- **example-node/** - Node.js string reverser
- **math-expert-plugin/** - Agent with specialized tools

### Complete Plugin Example

**plugin.json:**
```json
{
  "name": "database-tools",
  "version": "1.0.0",
  "description": "Database tools with specialized agent",
  "runtime": "python3",
  "activationMode": "tagged",
  "dependencies": {"file": "requirements.txt"},

  "tools": [{
    "name": "query-db",
    "description": "Execute SQL query",
    "command": "python3",
    "args": ["query.py"],
    "visible_to": ["database-agent"],
    "schema": {
      "type": "object",
      "properties": {
        "query": {"type": "string", "description": "SQL query"}
      },
      "required": ["query"]
    }
  }],

  "agents": [{
    "name": "database-agent",
    "description": "SQL query and schema expert",
    "system_prompt_file": "database-agent.md",
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
tools: ["read", "query-db"]
usage_guidelines: |
  **When to use:** Database queries, schema analysis, SQL optimization
  **When NOT to use:** File operations, general coding tasks
---

You are a database specialist.

Workflow:
1. Read and understand schema
2. Validate SQL syntax
3. Check for injection vulnerabilities
4. Execute query

Never execute destructive queries without confirmation.
```
