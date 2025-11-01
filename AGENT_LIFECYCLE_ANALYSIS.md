# Agent Lifecycle Management - Current State Analysis

## Overview
The system has **multiple overlapping and redundant ways** to manage agent lifecycle, creating confusion about which tool/command to use and when.

---

## Component Inventory

### 1. Tools (Programmatic API)
Tools are used by agents/LLMs to perform actions. They appear in chat as function calls.

#### `agent_pool` Tool (AgentPoolTool.ts)
- **Purpose**: Programmatic agent pool management
- **Operations**:
  - `list_agents`: Get all agents with metadata
  - `get_stats`: Get pool statistics  
  - `clear_pool`: Remove all agents (fails if any in use)
  - `clear_agent`: Remove specific agent by ID
- **Typical use**: Main agent monitoring/managing pool health
- **Requires confirmation**: No
- **Who calls it**: Main agent via LLM instruction

#### `kill_agent` Tool (KillAgentTool.ts)
- **Purpose**: Simple alias for removing agents
- **Operations**: Single operation - remove agent by ID
- **Typical use**: Cleanup specific agents
- **Requires confirmation**: No
- **Relationship**: Direct wrapper around `agent_pool(operation="clear_agent")`
- **Who calls it**: Main agent via LLM instruction

#### `agent` Tool (AgentTool.ts)
- **Purpose**: Delegate task to sub-agents with persistence
- **Operations**:
  - Create standard or specialized agents
  - Delegate tasks to agents
  - Optional persistence (returns agent_id for later use)
- **Typical use**: Task delegation with optional reuse
- **Requires confirmation**: No
- **Persistence**: Default `persist=true` (adds agents to pool)
- **Who calls it**: Main agent via LLM instruction

#### `explore` Tool (ExploreTool.ts)
- **Purpose**: Lightweight exploration agent (read-only)
- **Operations**: Single-purpose exploration with hardcoded tools
- **Typical use**: Codebase exploration/analysis
- **Requires confirmation**: No
- **Persistence**: Optional `persist=true` parameter (adds agent to pool)
- **Who calls it**: Main agent via LLM instruction
- **Special**: Hardcoded read-only tool access (read, glob, grep, ls, tree, batch)

#### `plan` Tool (PlanTool.ts)
- **Purpose**: Create implementation plans with research
- **Operations**: Single-purpose planning with hardcoded tools
- **Typical use**: Understanding how to implement features
- **Requires confirmation**: No
- **Persistence**: Optional `persist=true` parameter (adds agent to pool)
- **Who calls it**: Main agent via LLM instruction
- **Special**: Hardcoded tools (read-only tools + explore + todo_add)

#### `ask_agent` Tool (AskAgentTool.ts)
- **Purpose**: Continue conversation with persistent agents
- **Operations**: Send message to existing agent
- **Typical use**: Follow-up questions/iterative refinement
- **Requires confirmation**: No
- **Prerequisite**: Requires agent_id from explore/plan/agent with `persist=true`
- **Who calls it**: Main agent via LLM instruction

---

### 2. Commands (User Interface)
Commands are invoked by users at the CLI with `/` prefix.

#### `/agent` Command (AgentCommand.ts)
**Subcommands:**

**Specialized Agent Management:**
- `/agent create <description>` - Create new saved agent definition
- `/agent ls` - List saved agent definitions
- `/agent show <name>` - Show agent details
- `/agent delete <name>` - Delete agent definition
- `/agent use <name> <task>` - Invoke saved agent

**Agent Pool Management:**
- `/agent active` - List active pooled agents (same as `agent_pool(operation="list_agents")`)
- `/agent stats` - Show pool statistics (same as `agent_pool(operation="get_stats")`)
- `/agent clear [agent_id]` - Clear specific agent or all agents (same as `agent_pool(operation="clear_agent")` or `clear_pool`)

---

## Redundancy Analysis

### Clear Duplications

#### 1. List Agents
| Interface | Command | Operation |
|-----------|---------|-----------|
| **Tool** | `agent_pool(operation="list_agents")` | Programmatic list |
| **Command** | `/agent active` | User-friendly list |
| **Functionality** | Identical - both return same agent list with metadata |

#### 2. Get Pool Statistics
| Interface | Command | Operation |
|-----------|---------|-----------|
| **Tool** | `agent_pool(operation="get_stats")` | Programmatic stats |
| **Command** | `/agent stats` | User-friendly stats |
| **Functionality** | Identical - both return same statistics |

#### 3. Remove Agent
| Interface | Command | Operation |
|-----------|---------|-----------|
| **Tool** | `agent_pool(operation="clear_agent", agent_id="X")` | Remove by ID |
| **Tool** | `kill_agent(agent_id="X")` | Remove by ID (wrapper) |
| **Command** | `/agent clear <agent_id>` | Remove by ID |
| **Functionality** | All three do the same thing - remove agent from pool |

#### 4. Remove All Agents
| Interface | Command | Operation |
|-----------|---------|-----------|
| **Tool** | `agent_pool(operation="clear_pool")` | Remove all |
| **Command** | `/agent clear` (no arg) | Remove all |
| **Functionality** | Both remove all agents from pool |

### Overlapping Tool Functionality

#### Agent Creation Paths
1. **`agent()` tool** - Creates ephemeral OR pooled sub-agents
   - Returns agent_id for later use (when `persist=true`)
   - Full task delegation in one call
   
2. **`explore()` tool** - Creates exploration agent
   - Returns agent_id (when `persist=true`)
   - Limited to read-only tools
   
3. **`plan()` tool** - Creates planning agent
   - Returns agent_id (when `persist=true`)
   - Limited to planning tools
   
4. **`/agent use` command** - Uses pre-defined saved agents
   - No agent_id returned
   - Cannot be reused via ask_agent

All create sub-agents and add to pool when `persist=true`, but have different parameter names and access levels.

---

## Current Problems

### 1. **Confusion: Too Many Ways to Do Same Thing**
- Users can use `/agent clear X` OR `kill_agent(agent_id="X")` OR `agent_pool(operation="clear_agent", agent_id="X")`
- All do the exact same thing but have different names and APIs
- No clear guidance on which to prefer

### 2. **Inconsistent API Patterns**
- `agent_pool()` uses `operation` parameter with enums (ergonomic!)
- `kill_agent()` uses `agent_id` parameter (simpler but less discoverable)
- `/agent` uses subcommands (CLI-friendly but not programmatic)

### 3. **Parameter Name Inconsistency**
- `agent()` uses `agent_name` for specialized agents
- `explore()` and `plan()` have no agent_name equivalent
- No consistent way to name agents across tools

### 4. **Unclear Purpose Boundaries**
- Not clear if `explore` and `plan` are meant to be lightweight alternatives to `agent()` or complementary tools
- `agent()` with `persist=true` can do everything `explore()` and `plan()` do
- Why have separate specialized tools if they just add to the same pool?

### 5. **Missing Inventory Management**
- No way to list which agents are persistent (created with `persist=true`)
- `agent_pool(operation="list_agents")` shows ALL pooled agents but no indication of which are reusable
- Status is only "IN_USE" or "AVAILABLE" - no info about when they were last used or idle time

### 6. **Unclear Kill_agent Purpose**
- `KillAgentTool` is just a wrapper around one operation of `AgentPoolTool`
- Adds another way to do the same thing
- Simpler API, but creates duplication

### 7. **Agent Persistence Semantics**
- `persist` parameter on `agent()`, `explore()`, and `plan()` defaults to `true`
- But default is creating agents in pool without explicit user intent
- Can lead to pool bloat if not carefully managed

---

## Recommended Consolidation Strategy

### Phase 1: Establish Single Source of Truth
**Keep**: `agent_pool` Tool (comprehensive, programmatic)
**Remove/Deprecate**: 
- `kill_agent` Tool (redundant with `agent_pool`)

**Rationale**: 
- `agent_pool` is the comprehensive API
- `kill_agent` is just a convenience wrapper
- Can keep `kill_agent` as deprecated alias if needed, but shouldn't be primary

### Phase 2: Rationalize Commands
**Keep**: `/agent` command with all subcommands
**Change**: Internal implementation
- `/agent active` → calls `agent_pool(operation="list_agents")`
- `/agent stats` → calls `agent_pool(operation="get_stats")`
- `/agent clear` → calls `agent_pool(operation="clear_pool")` or `clear_agent`

**Rationale**:
- User-friendly interface
- Single tool for all agent lifecycle operations

### Phase 3: Clarify Tool Roles
**Consolidate Semantics**:
- `agent()` = generic task delegation (accepts `persist` parameter)
- `explore()` = task delegation with read-only focus (accepts `persist` parameter)
- `plan()` = task delegation with planning focus (accepts `persist` parameter)
- `ask_agent()` = continue conversation with persisted agent (unchanged)

**Keep All Three** because they serve different purposes and provide appropriate tool constraints.

### Phase 4: Improve Pool Discoverability
**Add to `agent_pool` Tool**:
- Add operation `list_persistent_agents` to show only reusable agents (created with `persist=true`)
- Add operation `get_agent_usage` to show idle time, last access, use count

---

## Summary Table

### Current State
```
Total unique ways to:
- List agents: 2 (tool + command)
- Get stats: 2 (tool + command)
- Remove agent: 3 (tool + tool wrapper + command)
- Remove all: 2 (tool + command)
```

### Recommended State
```
Single way to perform each operation:
- Agent Pool Tool (programmatic)
- /agent Command (user-friendly wrapper)
- keep explore, plan, ask_agent as specialized delegation tools
```

### What to Simplify
1. Remove `KillAgentTool` - duplicate functionality
2. Consolidate `/agent` command to delegate to `agent_pool` tool
3. Clarify persistence semantics and add pool usage insights
4. Add missing operations (persistent agent listing, usage stats)

---

## Files Involved

### Tools
- `/Users/benmoore/CodeAlly-TS/src/tools/AgentPoolTool.ts` - Agent pool management
- `/Users/benmoore/CodeAlly-TS/src/tools/KillAgentTool.ts` - Remove agent (wrapper)
- `/Users/benmoore/CodeAlly-TS/src/tools/AgentTool.ts` - Task delegation
- `/Users/benmoore/CodeAlly-TS/src/tools/ExploreTool.ts` - Exploration delegation
- `/Users/benmoore/CodeAlly-TS/src/tools/PlanTool.ts` - Planning delegation
- `/Users/benmoore/CodeAlly-TS/src/tools/AskAgentTool.ts` - Agent conversation

### Commands
- `/Users/benmoore/CodeAlly-TS/src/agent/commands/AgentCommand.ts` - CLI commands

