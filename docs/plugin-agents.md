# Plugin Custom Agents

Extend Code Ally with custom AI agents through plugins. Plugin agents are specialized assistants with custom system prompts, model configurations, and tool access.

## Overview

**What are Plugin Agents?**

Plugin agents are custom AI assistants defined in your plugin that can be delegated tasks through the `agent` tool. They run in isolated contexts with:

- Custom system prompts and behavior
- Configurable model and temperature
- Restricted tool access (core + plugin tools by default)
- Persistent conversation history via agent pooling

**Use Cases:**

- Domain-specific assistants (e.g., database query agent, API testing agent)
- Specialized workflows (e.g., code review agent, documentation agent)
- Tool-specific agents (e.g., agent that only uses your plugin's tools)

## Quick Start

### 1. Define Agent in plugin.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Plugin with custom agent",
  "tools": [
    {
      "name": "my_tool",
      "description": "My specialized tool",
      "command": "python3",
      "args": ["tool.py"]
    }
  ],
  "agents": [
    {
      "name": "my-agent",
      "description": "Specialized agent for my domain",
      "system_prompt_file": "agent.md"
    }
  ]
}
```

### 2. Create Agent Definition File

**File:** `agent.md`

```markdown
---
name: my-agent
description: Specialized agent for database operations
model: claude-3-5-sonnet-20241022
temperature: 0.3
tools: ["read", "write", "my_tool"]
---

You are a specialized database operations agent.

Your role is to help users with database queries, schema design, and data analysis.
Always validate queries before execution and explain your reasoning.
```

### 3. Use the Agent

```bash
# Start Code Ally
ally

# Activate plugin (if tagged mode)
+my-plugin

# Use the agent
"Delegate to my-agent: analyze the database schema in schema.sql"
```

The main agent will call `agent(agent_name="my-agent", task_prompt="...")` and delegate the task.

## Agent Definition File Format

Agent files use **markdown with YAML frontmatter**:

```markdown
---
name: agent-name
description: Brief description visible to main agent
model: claude-3-5-sonnet-20241022
temperature: 0.7
reasoning_effort: medium
tools: ["read", "write", "grep"]
---

System prompt goes here.
This is what shapes the agent's behavior.
```

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Agent identifier (must match manifest) |
| `description` | string | Yes | Brief description for agent selection |
| `model` | string | No | Model to use (defaults to config) |
| `temperature` | number | No | Temperature 0.0-1.0 (defaults to config) |
| `reasoning_effort` | string | No | "low", "medium", "high", or "inherit" (default) |
| `tools` | string[] | No | Allowed tool names (see Tool Scoping below) |
| `created_at` | string | No | Creation timestamp |
| `updated_at` | string | No | Last update timestamp |

### System Prompt

The content after frontmatter is the agent's system prompt. This defines:

- Agent's role and expertise
- Behavioral guidelines
- Response format preferences
- Domain-specific knowledge

**Example:**

```markdown
---
name: code-reviewer
description: Specialized code review agent
temperature: 0.2
tools: ["read", "grep", "write"]
---

You are a meticulous code reviewer with expertise in software engineering best practices.

When reviewing code:
1. Check for bugs, security issues, and performance problems
2. Verify adherence to language idioms and patterns
3. Suggest improvements with explanations
4. Provide specific line references

Always be constructive and educational in your feedback.
```

## Tool Scoping

Plugin agents have **automatic tool scoping** to prevent conflicts and maintain security.

### Default Scoping (No `tools` Field)

**Plugin agents** (agents with `_pluginName`) automatically get:
- **All core tools** (read, write, bash, grep, etc.)
- **Plugin's own tools only**

```json
{
  "agents": [{
    "name": "helper",
    "system_prompt_file": "helper.md"
    // No tools field → gets core + plugin tools
  }]
}
```

**User agents** (no `_pluginName`) get:
- **All available tools** (unrestricted)

### Explicit Scoping (`tools` Field)

Override default scoping with explicit tool list:

```markdown
---
name: restricted-agent
tools: ["read", "grep"]
---

This agent can only use read and grep tools.
```

### Tool Access Matrix

| Agent Type | No `tools` Field | With `tools` Field |
|------------|------------------|-------------------|
| Plugin Agent | Core + plugin tools | Specified tools only |
| User Agent | All tools | Specified tools only |

## Tool-Agent Binding

Bind tools to specific agents using `required_agent`:

```json
{
  "tools": [{
    "name": "database_query",
    "description": "Execute database queries",
    "required_agent": "database-agent",
    "command": "python3",
    "args": ["query.py"]
  }]
}
```

**Behavior:**
- Tool only executes when current agent matches `required_agent`
- Other agents get clear error: "Tool 'database_query' requires agent 'database-agent'"
- Ensures tools run in correct context with appropriate safeguards

**Use Cases:**
- Database tools requiring specialized validation
- API tools needing specific authentication context
- Admin tools requiring elevated permissions

## Agent Pooling and Isolation

### Pool Keys

Each agent configuration gets a unique pool key:

**User agents:**
```
agent-{agent_name}
```

**Plugin agents:**
```
plugin-{plugin_name}-{agent_name}
```

**Why pool keys matter:**

- Prevents mixing agents from different plugins
- Allows multiple agents with same name across plugins
- Enables conversation persistence and reuse

### Example

```
Plugin A: helper → pool key: plugin-a-helper
Plugin B: helper → pool key: plugin-b-helper
User: helper → pool key: agent-helper
```

All three coexist independently with separate conversation histories.

## Priority System

When loading agents, Code Ally uses this priority:

**1. User agents** (`~/.ally/agents/`)
Highest priority, can override anything

**2. Plugin agents** (plugin `agents` field)
Medium priority, override built-ins

**3. Built-in agents** (`dist/agents/`)
Lowest priority, default agents

**Example:**

```
User creates: ~/.ally/agents/general.md
Plugin provides: agents[{name: "general", ...}]
Built-in: dist/agents/general.md

Result: User version loads
```

## Configuration

### Manifest Integration

```json
{
  "name": "analytics-plugin",
  "version": "1.0.0",
  "description": "Analytics tools with specialized agent",

  "tools": [{
    "name": "run_query",
    "description": "Execute analytics query",
    "command": "python3",
    "args": ["query.py"],
    "required_agent": "analytics-agent"
  }],

  "agents": [{
    "name": "analytics-agent",
    "description": "Analytics and reporting specialist",
    "system_prompt_file": "analytics-agent.md",
    "model": "claude-3-5-sonnet-20241022",
    "temperature": 0.2
  }]
}
```

### Manifest Overrides

Values in `plugin.json` override agent file frontmatter:

```json
{
  "agents": [{
    "name": "my-agent",
    "description": "Override description",  // Overrides agent.md
    "model": "claude-3-5-sonnet-20241022",  // Overrides agent.md
    "temperature": 0.5,                      // Overrides agent.md
    "system_prompt_file": "agent.md"
  }]
}
```

Priority: `plugin.json` > `agent.md` frontmatter

## Best Practices

### Agent Design

**Do:**
- Write clear, specific system prompts
- Set appropriate temperature (0.2-0.4 for analytical, 0.7-0.9 for creative)
- Limit tools to what agent needs
- Use descriptive agent names
- Document agent capabilities in description

**Don't:**
- Create overly general agents (defeats purpose of specialization)
- Give agents unnecessary tool access
- Use ambiguous agent names
- Forget to test agent behavior

### Tool Scoping

```markdown
# Good: Explicit, minimal tools
---
tools: ["read", "grep", "my_analysis_tool"]
---

# Bad: Too permissive
---
tools: ["read", "write", "bash", "glob", "grep", ...]
---

# Good: Let automatic scoping work
---
# No tools field → gets core + plugin tools automatically
---
```

### System Prompts

```markdown
# Good: Specific, actionable
---
name: api-tester
---

You are an API testing specialist.

When testing APIs:
1. Read the API specification
2. Generate test cases covering edge cases
3. Execute tests using the http_request tool
4. Report results with specific failure details

Always validate responses against schema.

# Bad: Vague, generic
---
name: api-tester
---

You help with APIs and testing.
```

### Model Selection

Choose models based on task requirements:

```yaml
# Analytical tasks (low temperature, precise)
model: claude-3-5-sonnet-20241022
temperature: 0.2
reasoning_effort: high

# Creative tasks (higher temperature, exploratory)
model: claude-3-5-sonnet-20241022
temperature: 0.8
reasoning_effort: medium

# Quick tasks (inherit from config)
# No model field → uses config.model
```

## Examples

### Database Agent

**plugin.json:**
```json
{
  "name": "database-tools",
  "agents": [{
    "name": "database-agent",
    "description": "SQL query and schema expert",
    "system_prompt_file": "database-agent.md"
  }],
  "tools": [{
    "name": "execute_query",
    "description": "Execute SQL query",
    "command": "python3",
    "args": ["query.py"],
    "required_agent": "database-agent"
  }]
}
```

**database-agent.md:**
```markdown
---
name: database-agent
description: SQL query optimization and execution specialist
temperature: 0.2
tools: ["read", "execute_query"]
---

You are a database specialist with expertise in SQL.

When working with databases:
1. Always validate SQL syntax before execution
2. Use EXPLAIN for query optimization
3. Check for SQL injection vulnerabilities
4. Limit result sets appropriately

Never execute destructive queries without explicit confirmation.
```

### API Testing Agent

**api-agent.md:**
```markdown
---
name: api-tester
description: REST API testing and validation specialist
temperature: 0.3
tools: ["read", "http_request", "write"]
reasoning_effort: medium
---

You are an API testing expert.

Testing workflow:
1. Read API specification (OpenAPI/Swagger)
2. Generate comprehensive test cases
3. Execute requests with http_request tool
4. Validate responses against schema
5. Document failures with reproduction steps

Focus on edge cases, error handling, and security.
```

### Code Review Agent

**review-agent.md:**
```markdown
---
name: code-reviewer
description: Code quality and security review specialist
temperature: 0.2
tools: ["read", "grep", "write"]
---

You are an experienced code reviewer.

Review checklist:
- Bugs and logic errors
- Security vulnerabilities (injection, XSS, etc.)
- Performance issues (N+1, inefficient algorithms)
- Code style and maintainability
- Test coverage

Provide specific line references and actionable suggestions.
```

## Troubleshooting

### Agent Not Found

**Problem:** `Agent 'my-agent' not found`

**Solutions:**
1. Check `plugin.json` includes agent in `agents` array
2. Verify `system_prompt_file` path is correct (relative to plugin directory)
3. Ensure agent file has valid frontmatter
4. Restart Code Ally to reload plugins

### Wrong Tools Available

**Problem:** Agent has access to unexpected tools

**Solutions:**
1. Add explicit `tools` field to agent frontmatter
2. Check tool scoping rules (core + plugin by default for plugin agents)
3. Verify `_pluginName` is set correctly

### Tool Binding Error

**Problem:** `Tool 'my_tool' requires agent 'other-agent'`

**Solutions:**
1. Use correct agent: `agent(agent_name="other-agent", ...)`
2. Remove `required_agent` constraint from tool
3. Verify agent name matches exactly

### Agent Uses Wrong Model

**Problem:** Agent uses default model instead of specified model

**Solutions:**
1. Check `model` field in both `plugin.json` and agent frontmatter
2. Verify model is available: `ally /model list`
3. Check logs: `ally --debug`

## Advanced Topics

### Multiple Agents per Plugin

```json
{
  "agents": [
    {
      "name": "analyzer",
      "description": "Data analysis specialist",
      "system_prompt_file": "analyzer.md"
    },
    {
      "name": "reporter",
      "description": "Report generation specialist",
      "system_prompt_file": "reporter.md"
    }
  ]
}
```

### Shared Tool Configuration

Tools can be shared across agents with different constraints:

```json
{
  "tools": [
    {
      "name": "query_db",
      "description": "Read-only query",
      "command": "python3",
      "args": ["query.py", "--readonly"]
      // Available to all agents
    },
    {
      "name": "modify_db",
      "description": "Write to database",
      "command": "python3",
      "args": ["query.py", "--write"],
      "required_agent": "admin-agent"
      // Only admin-agent can use
    }
  ]
}
```

### Agent Composition

Agents can delegate to other agents:

```markdown
---
name: orchestrator
tools: ["read", "agent"]
---

You are an orchestration agent.

Workflow:
1. Analyze task requirements
2. Delegate specialized subtasks to appropriate agents:
   - Data analysis → "analyzer" agent
   - Report generation → "reporter" agent
3. Combine results into final deliverable
```

## See Also

- [Plugin Development Guide](guides/plugin-development.md) - Creating plugins
- [Plugin System Architecture](architecture/plugin-system.md) - Technical details
- [Configuration Reference](reference/configuration.md) - Config options
