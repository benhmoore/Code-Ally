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
      "name": "my-tool",
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
tools: ["read", "write", "my-tool"]
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

The main agent will call `agent(agent="my-agent", task_prompt="...")` and delegate the task.

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
| `usage_guidelines` | string | No | Instructions for main agent on when/how to use this agent (injected into system prompt) |
| `requirements` | object | No | Tool usage requirements (see Agent Requirements below) |
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

Bind tools to specific agents using `visible_to`:

```json
{
  "tools": [{
    "name": "database-query",
    "description": "Execute database queries",
    "visible_to": ["database-agent"],
    "command": "python3",
    "args": ["query.py"]
  }]
}
```

**Behavior:**
- `visible_to: undefined` or `null` → Tool is visible to all agents
- `visible_to: []` (empty array) → Tool is visible to all agents
- `visible_to: ["agent1", "agent2"]` → Tool is only visible to specified agents

**Effect:**
- Tool is only visible and executable by agents in the `visible_to` array
- Tools with empty or missing array are visible to all agents (including main Ally)
- Tools with non-empty array are filtered out for agents not in the list
- Other agents get clear error: "Tool 'database-query' is only visible to agents: [database-agent]"
- Ensures tools run in correct context with appropriate safeguards

**Use Cases:**
- Database tools requiring specialized validation
- API tools needing specific authentication context
- Admin tools requiring elevated permissions

## Usage Guidelines

Plugin agents can provide instructions to the main Ally agent about when and how to use them via the `usage_guidelines` field:

```markdown
---
name: math-expert
usage_guidelines: |
  **When to use:** User asks for arithmetic calculations (add, subtract, multiply, divide)
  **When NOT to use:** Advanced math (square roots, exponents, trigonometry)
  **CRITICAL:** If this agent cannot complete the task, pass its response to the user verbatim
---
```

**Behavior:**
- Guidelines are injected into the main agent's system prompt
- Helps main agent select appropriate specialized agents
- Provides context on agent capabilities and limitations
- Can include critical behavioral instructions (e.g., how to handle failures)

**Best Practices:**
- Keep guidelines concise (2-4 bullet points)
- Clearly state when to use vs not use
- Document important limitations
- Include failure handling instructions if needed

## Agent Requirements

Ensure agents use their tools before completing tasks with the `requirements` field:

```markdown
---
name: math-expert
tools: ["add", "subtract", "multiply", "divide", "cannot-calculate"]
requirements:
  required_tools_one_of: ["add", "subtract", "multiply", "divide", "cannot-calculate"]
  require_tool_use: true
  max_retries: 2
  reminder_message: "You must use your arithmetic tools or call cannot-calculate if unable"
---
```

### Requirement Types

| Field | Type | Description |
|-------|------|-------------|
| `required_tools_one_of` | string[] | At least one tool from this list must be called successfully |
| `required_tools_all` | string[] | All tools in this list must be called successfully |
| `minimum_tool_calls` | number | Minimum number of successful tool calls (any tools) |
| `require_tool_use` | boolean | Requires at least one successful tool call |
| `max_retries` | number | Maximum reminder attempts before allowing exit (default: 2) |
| `reminder_message` | string | Custom message when requirements not met |

**Behavior:**
- Only **successful** tool calls count (where `success: true`)
- If requirements not met when agent tries to exit, a reminder is injected
- Agent gets up to `max_retries` reminders before being allowed to exit anyway
- Prevents agents from hallucinating answers instead of using tools

**Example - Require One Of:**
```yaml
requirements:
  required_tools_one_of: ["read", "grep"]
  max_retries: 1
  reminder_message: "You must read or search files to answer this question"
```

**Example - Require All:**
```yaml
requirements:
  required_tools_all: ["validate-schema", "execute-query"]
  reminder_message: "You must validate the schema before executing the query"
```

**Example - Minimum Count:**
```yaml
requirements:
  minimum_tool_calls: 3
  reminder_message: "You must gather more information before providing an answer"
```

## Agent Pooling and Isolation

### Pool Keys

Each agent configuration gets a unique pool key:

**User agents:**
```
agent-{agent}
```

**Plugin agents:**
```
plugin-{plugin_name}-{agent}
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
User creates: ~/.ally/agents/task.md
Plugin provides: agents[{name: "task", ...}]
Built-in: dist/agents/task.md

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
    "name": "run-query",
    "description": "Execute analytics query",
    "command": "python3",
    "args": ["query.py"],
    "visible_to": ["analytics-agent"]
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
tools: ["read", "grep", "my-analysis-tool"]
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
3. Execute tests using the http-request tool
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
    "name": "execute-query",
    "description": "Execute SQL query",
    "command": "python3",
    "args": ["query.py"],
    "visible_to": ["database-agent"]
  }]
}
```

**database-agent.md:**
```markdown
---
name: database-agent
description: SQL query optimization and execution specialist
temperature: 0.2
tools: ["read", "execute-query"]
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
tools: ["read", "http-request", "write"]
reasoning_effort: medium
---

You are an API testing expert.

Testing workflow:
1. Read API specification (OpenAPI/Swagger)
2. Generate comprehensive test cases
3. Execute requests with http-request tool
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

**Problem:** `Tool 'my-tool' requires agent 'other-agent'`

**Solutions:**
1. Use correct agent: `agent(agent="other-agent", ...)`
2. Remove `visible_to` constraint from tool (or leave array empty)
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
      "name": "query-db",
      "description": "Read-only query",
      "command": "python3",
      "args": ["query.py", "--readonly"]
      // Available to all agents
    },
    {
      "name": "modify-db",
      "description": "Write to database",
      "command": "python3",
      "args": ["query.py", "--write"],
      "visible_to": ["admin-agent"]
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

## Advanced: Tool Metadata and Features

### Automatic Description Parameter

Code Ally automatically injects a `description` parameter into all tool function definitions (unless the tool already defines it). This parameter is used for UI subtext display and is typically 5-10 words describing what the operation does.

### Tool Subtext Display

Tools can customize their UI appearance through:
- `formatSubtext()` - Customizes the subtext shown after the tool name
- `getSubtextParameters()` - Declares which parameters are shown in subtext

See [Plugin System Architecture](architecture/plugin-system.md) for complete technical documentation.

### Tool Usage Guidance

Tools can provide `usageGuidance` string that gets injected into agent system prompts. This helps agents understand when and how to use tools effectively.

**Note:** These features are primarily for built-in tools and require TypeScript implementation. Plugin tools use the default implementations.

## See Also

- [Plugin Development Guide](guides/plugin-development.md) - Creating plugins
- [Plugin System Architecture](architecture/plugin-system.md) - Technical details including tool features
- [Plugin Custom Agents Design](design/plugin-custom-agents.md) - Architecture and implementation details
- [Configuration Reference](reference/configuration.md) - Config options
