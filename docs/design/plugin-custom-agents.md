# Plugin Custom Agents - Design Document

## Overview

Plugin custom agents enable plugins to provide specialized AI assistants with custom system prompts, model configurations, and tool access restrictions. This design document explains the architecture, implementation, and integration of the plugin agent system.

**Status:** Implemented (Phase 17)

**Related:**
- Implementation: `/src/plugins/PluginLoader.ts`
- Agent Management: `/src/services/AgentManager.ts`
- Agent Tool: `/src/tools/AgentTool.ts`
- Tests: `/src/plugins/__tests__/plugin-agents.test.ts`

## Motivation

### Problem

Plugins needed a way to provide domain-specific AI agents that:
1. Have specialized system prompts for specific tasks
2. Run with appropriate tool access (not all tools)
3. Use custom model configurations (temperature, reasoning effort)
4. Maintain isolation from other plugin agents
5. Integrate seamlessly with existing agent pooling

### Use Cases

1. **Domain-Specific Agents**
   - Database query agent (SQL expert)
   - API testing agent (HTTP specialist)
   - Code review agent (security focus)

2. **Tool-Specific Agents**
   - Agents that only use specific plugin tools
   - Agents with required_agent binding for critical tools

3. **Workflow Agents**
   - Multi-step agents with predefined workflows
   - Orchestrator agents that delegate to other agents

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Plugin System                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  PluginLoader                                                │
│  ├─ loadPlugins()                                            │
│  ├─ loadPlugin()                                             │
│  └─ loadPluginAgents()  ← New                                │
│      ├─ Parse agent definitions from manifest                │
│      ├─ Read agent markdown files                            │
│      ├─ Add _pluginName metadata                             │
│      └─ Return AgentData[]                                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                            │
                            ↓ Register agents
┌─────────────────────────────────────────────────────────────┐
│                   AgentManager                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Priority System: User > Plugin > Builtin                   │
│                                                              │
│  Storage:                                                    │
│  ├─ User agents: ~/.ally/agents/*.md                        │
│  ├─ Plugin agents: Map<name, AgentData>                     │
│  └─ Builtin agents: dist/agents/*.md                        │
│                                                              │
│  Methods:                                                    │
│  ├─ registerPluginAgent(agent)       ← New                  │
│  ├─ registerPluginAgents(agents[])   ← New                  │
│  ├─ unregisterPluginAgent(name)      ← New                  │
│  ├─ loadAgent(name) → AgentData                             │
│  └─ listAgents() → AgentInfo[]                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                            │
                            ↓ Load agent
┌─────────────────────────────────────────────────────────────┐
│                      AgentTool                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Pool Key Generation:                                        │
│  ├─ User agents:   agent-{name}                             │
│  └─ Plugin agents: plugin-{pluginName}-{name}               │
│                                                              │
│  Tool Scoping:                                               │
│  ├─ Plugin agent (no tools field):                          │
│  │   → Core tools + plugin's own tools                      │
│  ├─ Plugin agent (with tools field):                        │
│  │   → Explicit tools only                                  │
│  └─ User agent (no tools field):                            │
│      → All tools                                             │
│                                                              │
│  Execution:                                                  │
│  ├─ Load agent from AgentManager                            │
│  ├─ Generate pool key                                       │
│  ├─ Filter tools based on scoping rules                     │
│  ├─ Create/acquire pooled agent                             │
│  └─ Execute task                                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
1. Plugin Loading
   plugin.json → PluginLoader.loadPlugin()
   ├─ Read agents[] from manifest
   ├─ For each agent:
   │   ├─ Read system_prompt_file
   │   ├─ Parse frontmatter + content
   │   └─ Add _pluginName metadata
   └─ Return { tools: BaseTool[], agents: AgentData[] }

2. Agent Registration
   AgentData[] → AgentManager.registerPluginAgents()
   ├─ Validate _pluginName present
   ├─ Store in pluginAgents Map
   └─ Log registration

3. Agent Execution
   agent(agent_name="my-agent", ...) → AgentTool.execute()
   ├─ Load agent from AgentManager
   │   Priority: User > Plugin > Builtin
   ├─ Generate pool key
   │   ├─ If _pluginName: plugin-{pluginName}-{name}
   │   └─ Else: agent-{name}
   ├─ Filter tools
   │   ├─ If tools field: explicit list
   │   ├─ Else if _pluginName: core + plugin tools
   │   └─ Else: all tools
   ├─ Create agent config
   │   ├─ systemPrompt
   │   ├─ model (agent.model || config.model)
   │   ├─ temperature
   │   ├─ _poolKey
   │   └─ agentType = agent.name
   ├─ Acquire from pool
   │   AgentPoolService.acquire(config, filteredToolManager)
   └─ Execute task
       agent.sendMessage(taskPrompt)
```

## Implementation Details

### 1. Plugin Manifest Schema

**New field:** `agents`

```typescript
interface PluginManifest {
  name: string;
  version: string;
  description: string;
  tools: ToolDefinition[];

  // New: Agent definitions
  agents?: AgentDefinition[];
}

interface AgentDefinition {
  name: string;                    // Agent identifier
  description: string;              // Brief description for selection
  system_prompt_file: string;       // Path to .md file (relative to plugin dir)
  model?: string;                   // Override model
  temperature?: number;             // Override temperature
  reasoning_effort?: string;        // Override reasoning effort
  tools?: string[];                 // Allowed tool names
}
```

**Example:**

```json
{
  "name": "database-tools",
  "agents": [{
    "name": "database-agent",
    "description": "SQL expert and query optimizer",
    "system_prompt_file": "database-agent.md",
    "model": "claude-3-5-sonnet-20241022",
    "temperature": 0.2
  }]
}
```

### 2. Agent File Format

Agents use **markdown with YAML frontmatter**:

```markdown
---
name: database-agent
description: SQL query optimization specialist
model: claude-3-5-sonnet-20241022
temperature: 0.2
reasoning_effort: high
tools: ["read", "query_db", "explain_query"]
created_at: "2024-01-01T00:00:00Z"
updated_at: "2024-01-15T12:00:00Z"
---

You are a database specialist with expertise in SQL.

When working with databases:
1. Always validate SQL syntax before execution
2. Use EXPLAIN for query optimization
3. Check for SQL injection vulnerabilities
4. Limit result sets appropriately

Never execute destructive queries without explicit confirmation.
```

**Frontmatter Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Agent identifier |
| `description` | string | Yes | Brief description |
| `system_prompt` | string | Yes | System prompt (body content) |
| `model` | string | No | Model name |
| `temperature` | number | No | 0.0-1.0 |
| `reasoning_effort` | string | No | "low", "medium", "high", "inherit" |
| `tools` | string[] | No | Allowed tool names |
| `created_at` | string | No | ISO timestamp |
| `updated_at` | string | No | ISO timestamp |

**Priority:** `plugin.json` values override agent file frontmatter

### 3. Plugin Agent Metadata

All plugin agents get `_pluginName` field:

```typescript
interface AgentData {
  name: string;
  description: string;
  system_prompt: string;
  model?: string;
  temperature?: number;
  reasoning_effort?: string;
  tools?: string[];
  created_at?: string;
  updated_at?: string;

  // Plugin metadata
  _pluginName?: string;  // Set only for plugin-provided agents
}
```

**Purpose:**
- Identify plugin source
- Generate unique pool keys
- Enable tool scoping

### 4. Priority System

Agent loading follows priority hierarchy:

```
1. User agents (~/.ally/agents/)
   ├─ Highest priority
   ├─ Can override anything
   └─ No _pluginName

2. Plugin agents (plugin agents field)
   ├─ Medium priority
   ├─ Override builtin agents
   └─ Has _pluginName

3. Builtin agents (dist/agents/)
   ├─ Lowest priority
   └─ Fallback defaults
```

**Implementation:**

```typescript
class AgentManager {
  async loadAgent(name: string): Promise<AgentData | null> {
    // 1. Try user agents (highest priority)
    const userPath = join(this.userAgentsDir, `${name}.md`);
    const userAgent = await this.readAgentFile(userPath);
    if (userAgent) return userAgent;

    // 2. Try plugin agents (second priority)
    const pluginAgent = this.pluginAgents.get(name);
    if (pluginAgent) return pluginAgent;

    // 3. Try builtin agents (lowest priority)
    const builtinPath = join(this.builtinAgentsDir, `${name}.md`);
    return await this.readAgentFile(builtinPath);
  }
}
```

### 5. Pool Key Generation

Pool keys ensure agent isolation:

```typescript
// AgentTool.executeAgentTask()

const poolKey = agentData._pluginName
  ? `plugin-${agentData._pluginName}-${agentData.name}`
  : `agent-${agentData.name}`;
```

**Examples:**

```
User agent "helper":
  → pool key: "agent-helper"

Plugin A agent "helper":
  → pool key: "plugin-a-helper"

Plugin B agent "helper":
  → pool key: "plugin-b-helper"
```

**Why this matters:**

- Prevents pool collisions between plugins
- Allows multiple plugins to provide same agent name
- Each agent maintains separate conversation history
- Agent reuse works correctly across multiple calls

### 6. Tool Scoping Algorithm

```typescript
// AgentTool.executeAgentTask()

let filteredToolManager = toolManager;
const allTools = toolManager.getAllTools();

if (agentData.tools !== undefined && agentData.tools.length > 0) {
  // Explicit tool list: use only specified tools
  const allowedToolNames = new Set(agentData.tools);
  const filteredTools = allTools.filter(tool => allowedToolNames.has(tool.name));
  filteredToolManager = new ToolManager(filteredTools, activityStream);

} else if (agentData._pluginName) {
  // Plugin agent with no explicit tools:
  // Provide core tools + plugin's own tools
  const coreTools = allTools.filter(tool => !tool.pluginName);
  const pluginTools = allTools.filter(tool => tool.pluginName === agentData._pluginName);
  const filteredTools = [...coreTools, ...pluginTools];
  filteredToolManager = new ToolManager(filteredTools, activityStream);

} else {
  // User agent with no explicit tools:
  // Provide all tools (unrestricted)
  filteredToolManager = toolManager;
}
```

**Decision Matrix:**

| Agent Type | `tools` Field | Result |
|------------|---------------|--------|
| Plugin Agent | Undefined | Core tools + plugin's tools |
| Plugin Agent | Defined | Explicit tools only |
| User Agent | Undefined | All tools |
| User Agent | Defined | Explicit tools only |

### 7. Tool-Agent Binding

Tools can require specific agents:

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  command?: string;
  args?: string[];
  schema?: any;

  // New: Agent binding
  required_agent?: string;  // Tool only executes for this agent
}
```

**Validation (in ToolOrchestrator):**

```typescript
// Before tool execution
if (toolDef.required_agent && toolDef.required_agent !== currentAgentName) {
  throw new Error(
    `Tool '${toolDef.name}' requires agent '${toolDef.required_agent}' ` +
    `but current agent is '${currentAgentName}'`
  );
}
```

**Use Case:**

```json
{
  "tools": [{
    "name": "execute_sql",
    "description": "Execute SQL queries",
    "required_agent": "database-agent",
    "command": "python3",
    "args": ["sql.py"]
  }]
}
```

Ensures SQL execution only happens in context of database-specialized agent with appropriate safeguards.

## Integration Points

### 1. PluginLoader

**Changes:**

```typescript
class PluginLoader {
  private async loadPlugin(pluginPath: string):
    Promise<{ tools: BaseTool[], agents: AgentData[] }> {

    // Existing tool loading...
    const tools = await this.loadToolsFromManifest(manifest);

    // New: Load agents
    const agents = await this.loadPluginAgents(manifest, pluginPath);

    return { tools, agents };
  }

  private async loadPluginAgents(
    manifest: PluginManifest,
    pluginPath: string
  ): Promise<Array<AgentData & { _pluginName: string }>> {

    if (!manifest.agents || manifest.agents.length === 0) {
      return [];
    }

    const agents: Array<AgentData & { _pluginName: string }> = [];
    const seenAgentNames = new Set<string>();

    for (const agentDef of manifest.agents) {
      // Skip duplicates within plugin
      if (seenAgentNames.has(agentDef.name)) {
        logger.warn(`Duplicate agent name '${agentDef.name}' in plugin '${manifest.name}'`);
        continue;
      }
      seenAgentNames.add(agentDef.name);

      // Validate required fields
      if (!agentDef.name || !agentDef.system_prompt_file) {
        logger.warn(`Invalid agent in plugin '${manifest.name}': missing required fields`);
        continue;
      }

      // Read agent file
      const agentFilePath = join(pluginPath, agentDef.system_prompt_file);
      const fileContent = await fs.readFile(agentFilePath, 'utf-8');

      // Parse frontmatter + content
      const parsedAgent = this.parseAgentFile(fileContent, agentDef.name);
      if (!parsedAgent) {
        logger.warn(`Failed to parse agent file '${agentDef.system_prompt_file}'`);
        continue;
      }

      // Merge manifest values (take precedence over file frontmatter)
      const mergedAgent: AgentData & { _pluginName: string } = {
        ...parsedAgent,
        name: agentDef.name,
        description: agentDef.description || parsedAgent.description,
        model: agentDef.model || parsedAgent.model,
        temperature: agentDef.temperature ?? parsedAgent.temperature,
        reasoning_effort: agentDef.reasoning_effort || parsedAgent.reasoning_effort,
        tools: agentDef.tools || parsedAgent.tools,
        _pluginName: manifest.name,  // Critical: Add plugin metadata
      };

      agents.push(mergedAgent);
    }

    return agents;
  }
}
```

### 2. AgentManager

**Changes:**

```typescript
class AgentManager {
  private pluginAgents: Map<string, AgentData> = new Map();

  registerPluginAgent(agentData: AgentData): void {
    if (!agentData._pluginName) {
      throw new Error(`Cannot register plugin agent without _pluginName`);
    }
    this.pluginAgents.set(agentData.name, agentData);
  }

  registerPluginAgents(agents: AgentData[]): void {
    for (const agent of agents) {
      this.registerPluginAgent(agent);
    }
  }

  unregisterPluginAgent(agentName: string): boolean {
    return this.pluginAgents.delete(agentName);
  }

  async loadAgent(agentName: string): Promise<AgentData | null> {
    // Priority: User > Plugin > Builtin

    // 1. User agents
    const userAgent = await this.loadUserAgent(agentName);
    if (userAgent) return userAgent;

    // 2. Plugin agents
    const pluginAgent = this.pluginAgents.get(agentName);
    if (pluginAgent) return pluginAgent;

    // 3. Builtin agents
    return await this.loadBuiltinAgent(agentName);
  }

  async listAgents(): Promise<AgentInfo[]> {
    const agentMap = new Map<string, AgentInfo>();

    // Load builtin first (lowest priority)
    await this.loadBuiltinAgentsIntoMap(agentMap);

    // Load plugin agents (override builtin)
    for (const [name, agentData] of this.pluginAgents.entries()) {
      agentMap.set(name, {
        name: agentData.name,
        description: agentData.description,
        file_path: `<plugin:${agentData._pluginName}>`,
        source: 'plugin',
        pluginName: agentData._pluginName,
      });
    }

    // Load user agents (override all)
    await this.loadUserAgentsIntoMap(agentMap);

    return Array.from(agentMap.values());
  }
}
```

### 3. AgentTool

**Changes:**

```typescript
class AgentTool extends BaseTool {
  private async executeAgentTask(
    agentData: any,
    taskPrompt: string,
    thoroughness: string,
    callId: string,
    initialMessages?: Message[]
  ): Promise<{ result: string; agent_id?: string }> {

    // Generate pool key based on agent type
    const poolKey = agentData._pluginName
      ? `plugin-${agentData._pluginName}-${agentData.name}`
      : `agent-${agentData.name}`;

    // Filter tools based on agent configuration
    const allTools = toolManager.getAllTools();
    let filteredTools: BaseTool[];

    if (agentData.tools !== undefined && agentData.tools.length > 0) {
      // Explicit tool list
      const allowedToolNames = new Set(agentData.tools);
      filteredTools = allTools.filter(tool => allowedToolNames.has(tool.name));

    } else if (agentData._pluginName) {
      // Plugin agent: core + plugin tools
      const coreTools = allTools.filter(tool => !tool.pluginName);
      const pluginTools = allTools.filter(
        tool => tool.pluginName === agentData._pluginName
      );
      filteredTools = [...coreTools, ...pluginTools];

    } else {
      // User agent: all tools
      filteredTools = allTools;
    }

    const filteredToolManager = new ToolManager(filteredTools, activityStream);

    // Create agent config with pool key
    const agentConfig: AgentConfig = {
      isSpecializedAgent: true,
      systemPrompt: specializedPrompt,
      baseAgentPrompt: agentData.system_prompt,
      taskPrompt: taskPrompt,
      config: config,
      parentCallId: callId,
      _poolKey: poolKey,  // Critical for pool matching
      maxDuration,
      initialMessages,
      agentType: agentData.name,  // For tool-agent binding
    };

    // Acquire from pool
    const pooledAgent = await agentPoolService.acquire(
      agentConfig,
      filteredToolManager
    );

    // Execute task
    const response = await pooledAgent.agent.sendMessage(taskPrompt);

    return {
      result: response,
      agent_id: pooledAgent.agentId,
    };
  }
}
```

### 4. ToolOrchestrator

**Tool-agent binding validation:**

```typescript
class ToolOrchestrator {
  async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      const tool = this.toolManager.getTool(toolCall.function.name);

      // Validate tool-agent binding
      if (tool.required_agent && tool.required_agent !== this.currentAgentName) {
        results.push({
          success: false,
          error: `Tool '${tool.name}' requires agent '${tool.required_agent}' ` +
                 `but current agent is '${this.currentAgentName}'`,
          error_type: 'validation_error',
        });
        continue;
      }

      // Execute tool
      const result = await this.executeTool(toolCall);
      results.push(result);
    }

    return results;
  }
}
```

## Testing Strategy

### Unit Tests

**File:** `/src/plugins/__tests__/plugin-agents.test.ts`

**Test Coverage:**

1. **Plugin Agent Loading**
   - ✓ Load plugin with agent definitions
   - ✓ Parse agent file correctly
   - ✓ Set _pluginName on loaded agents
   - ✓ Handle missing required fields
   - ✓ Handle duplicate agent names within plugin

2. **AgentManager Integration**
   - ✓ Register plugin agents
   - ✓ Register multiple plugin agents in bulk
   - ✓ Load agents with priority (user > plugin > builtin)
   - ✓ List agents including plugin agents
   - ✓ Unregister plugin agents

3. **AgentTool Integration - Pool Keys**
   - ✓ Generate correct pool key for user agents
   - ✓ Generate correct pool key for plugin agents
   - ✓ Avoid pool key collisions between plugins

4. **AgentTool Integration - Tool Scoping**
   - ✓ Scope tools for plugin agents (core + plugin tools)
   - ✓ Scope tools with explicit tools list
   - ✓ Provide all tools to user agents

5. **Tool-Agent Binding**
   - ✓ Allow tool with required_agent constraint
   - ✓ Reject tool when agent does not match
   - ✓ Validate tool execution with correct agent
   - ✓ Provide clear error message for mismatched agent

6. **Integration - Complete Flow**
   - ✓ Load plugin, register agents, make them available

### Integration Tests

**Manual testing scenarios:**

1. Create plugin with custom agent
2. Load plugin and verify agent registration
3. Delegate task to plugin agent
4. Verify tool scoping (should not have other plugins' tools)
5. Test tool-agent binding
6. Verify agent pooling (multiple calls reuse same agent)

## Future Enhancements

### Considered for Future Phases

1. **Agent Templates**
   - Reusable agent configurations
   - Template inheritance
   - Variable substitution in prompts

2. **Agent Permissions**
   - Fine-grained permission control
   - Read-only vs read-write agents
   - Resource limits per agent

3. **Agent Metrics**
   - Track agent usage statistics
   - Performance monitoring
   - Cost tracking per agent

4. **Agent Marketplace**
   - Discover and install agent plugins
   - Rating and review system
   - Version management

5. **Multi-Agent Workflows**
   - Agent-to-agent communication
   - Workflow orchestration
   - Result aggregation

## Migration Guide

### For Plugin Authors

**Before (tools only):**

```json
{
  "name": "my-plugin",
  "tools": [{
    "name": "my_tool",
    "command": "python3",
    "args": ["tool.py"]
  }]
}
```

**After (tools + agents):**

```json
{
  "name": "my-plugin",
  "tools": [{
    "name": "my_tool",
    "command": "python3",
    "args": ["tool.py"],
    "required_agent": "my-agent"
  }],
  "agents": [{
    "name": "my-agent",
    "description": "Specialized agent for my domain",
    "system_prompt_file": "agent.md"
  }]
}
```

**Create agent.md:**

```markdown
---
name: my-agent
description: Specialized agent
tools: ["read", "write", "my_tool"]
---

You are a specialized agent for my domain.
```

### Backward Compatibility

**100% backward compatible:**

- `agents` field is optional in plugin.json
- Existing plugins work without modification
- Tool-agent binding is optional
- No breaking changes to existing APIs

## Performance Considerations

### Agent Pooling

**Impact:** Positive

- Agents are pooled and reused across calls
- No overhead from re-creating agents
- Conversation history preserved for efficiency

**Pool key strategy ensures:**
- No collisions between plugins
- Efficient agent reuse
- Isolated conversation histories

### Tool Scoping

**Impact:** Minimal

- Tool filtering is O(n) where n = total tools
- Typically < 100 tools, negligible overhead
- Caching could be added if needed

### File I/O

**Impact:** One-time at plugin load

- Agent files read once during plugin loading
- Parsed and stored in memory
- No repeated file I/O during agent execution

## Security Considerations

### Tool Access Control

**Risk:** Plugin agents accessing unauthorized tools

**Mitigation:**
- Automatic tool scoping (core + plugin tools only)
- Explicit tool lists override defaults
- No access to other plugins' tools by default

### Agent Isolation

**Risk:** Agent pool key collisions

**Mitigation:**
- Pool keys include plugin name
- Format: `plugin-{pluginName}-{agentName}`
- Impossible for plugins to collide

### Tool-Agent Binding

**Risk:** Critical tools used without appropriate context

**Mitigation:**
- `required_agent` field enforces agent matching
- Validation before tool execution
- Clear error messages guide correct usage

## Conclusion

The plugin custom agents system provides a powerful, flexible way for plugins to extend Code Ally with domain-specific AI assistants. The implementation:

- **Seamlessly integrates** with existing plugin and agent systems
- **Maintains backward compatibility** (100%)
- **Ensures security** through automatic tool scoping and agent isolation
- **Enables advanced workflows** through tool-agent binding
- **Supports extensibility** for future enhancements

The architecture is clean, well-tested, and production-ready.

## References

### Code Files

- `/src/plugins/PluginLoader.ts` - Plugin loading and agent parsing
- `/src/plugins/interfaces.ts` - Type definitions
- `/src/services/AgentManager.ts` - Agent storage and retrieval
- `/src/tools/AgentTool.ts` - Agent execution and tool scoping
- `/src/agent/Agent.ts` - Core agent implementation
- `/src/plugins/__tests__/plugin-agents.test.ts` - Comprehensive tests

### Documentation

- `/docs/plugin-agents.md` - User guide for plugin agents
- `/docs/guides/plugin-development.md` - Plugin development guide
- `/docs/architecture/plugin-system.md` - Plugin system architecture
