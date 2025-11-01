# Agent Lifecycle Management - Executive Summary

## Quick Facts

- **Tools available**: 6 (agent_pool, kill_agent, agent, explore, plan, ask_agent)
- **Commands available**: 8 subcommands under `/agent`
- **Redundancy level**: HIGH - 3 ways to remove agents, 2 ways to list, 2 ways to get stats
- **Complexity**: Medium - System is functional but confusing to users

---

## The Core Problem: Too Many Ways to Do the Same Thing

### Example 1: Remove an Agent
```typescript
// All three do the EXACT same thing:
/agent clear pool-agent-123        // User command
kill_agent(agent_id="pool-agent-123")    // LLM tool call
agent_pool(operation="clear_agent", agent_id="pool-agent-123")  // LLM tool call
```

### Example 2: List Active Agents
```typescript
// Both do the same thing:
/agent active                       // User command
agent_pool(operation="list_agents") // LLM tool call
```

### Example 3: Get Pool Stats
```typescript
// Both do the same thing:
/agent stats                        // User command
agent_pool(operation="get_stats")   // LLM tool call
```

---

## What We Have vs. What We Need

### Current Tool Zoo

```
Agent Lifecycle Tools:
├── agent_pool        (pool management - list, stats, clear)
│   └── kill_agent    (wrapper for clear_agent - REDUNDANT!)
├── agent            (task delegation)
├── explore          (exploration delegation)
├── plan             (planning delegation)
└── ask_agent        (conversation with persistent agent)

CLI Commands (/agent):
├── specialized agent management (create, ls, show, delete, use)
└── pool management (active, stats, clear)
    ↓ currently duplicates agent_pool tool
```

### Clean Architecture Would Be

```
Agent Lifecycle Operations:
├── Pool Management (agent_pool tool)
│   ├── List agents
│   ├── Get stats
│   ├── Clear agent
│   ├── Clear pool
│   ├── [NEW] List persistent agents
│   └── [NEW] Get usage stats
│
├── User Interface (/agent command)
│   ├── Delegates pool ops → agent_pool
│   └── Manages saved agents (create, ls, show, delete, use)
│
└── Delegation Tools (specialized agents)
    ├── explore       (read-only)
    ├── plan         (planning)
    ├── agent        (general)
    └── ask_agent    (conversation)
```

---

## Current State Inventory

### Tools by Category

#### Pool Management (1 real tool + 1 redundant)
| Tool | Purpose | Status |
|------|---------|--------|
| `agent_pool` | List/manage agents in pool | KEEP - Core |
| `kill_agent` | Remove agent from pool | REMOVE - Redundant wrapper |

#### Delegation (4 tools)
| Tool | Purpose | Persist? | Tools Available |
|------|---------|----------|-----------------|
| `agent` | Generic task delegation | Yes | All (filtered) |
| `explore` | Code exploration | Yes | Read-only: read,glob,grep,ls,tree,batch |
| `plan` | Implementation planning | Yes | Planning: read,glob,grep,ls,tree,batch,explore,todo_add |
| `ask_agent` | Continue conversation | N/A | N/A (uses existing agent) |

#### Commands (8 total)
| Command | Type | Equivalent Tool |
|---------|------|-----------------|
| `/agent create <desc>` | Agent management | N/A |
| `/agent ls` | Agent management | N/A |
| `/agent show <name>` | Agent management | N/A |
| `/agent delete <name>` | Agent management | N/A |
| `/agent use <name> <task>` | Agent management | agent tool (no persist return) |
| `/agent active` | Pool management | agent_pool(list_agents) |
| `/agent stats` | Pool management | agent_pool(get_stats) |
| `/agent clear [id]` | Pool management | agent_pool(clear_agent\|pool) |

---

## Problem Categories

### 1. Duplication (3 redundancies)
- `kill_agent()` duplicates `agent_pool(operation="clear_agent")`
- `/agent active` duplicates `agent_pool(operation="list_agents")`
- `/agent stats` duplicates `agent_pool(operation="get_stats")`

### 2. API Inconsistency
- `agent_pool()` uses `operation` enum
- `kill_agent()` uses direct parameters
- `/agent` uses subcommands
- No unified pattern

### 3. Unclear Semantics
- Is `explore()` simpler than `agent()`? Why not just use `agent()`?
- Is `plan()` different from `explore()`? They're both delegation tools
- Why does `persist` default to `true`? Users don't expect agents to stay in memory

### 4. Missing Features
- No way to list only "persistent" agents (created with persist=true)
- No usage statistics (idle time, last access, use count)
- No guidance on when pool cleanup is needed

---

## Recommendation: 3-Phase Consolidation

### Phase 1: Quick Wins (Low Risk)
1. Add new operations to `agent_pool`:
   - `list_persistent_agents` - Show reusable agents
   - `get_agent_usage` - Show usage stats and idle times
2. Add `/agent` commands for new operations:
   - `/agent persistent` - List persistent agents
   - `/agent usage` - Show usage statistics
3. Document clear guidance on tool usage

### Phase 2: Rationalization (Medium Risk)
1. Make `/agent` commands delegate to `agent_pool` tool internally
2. Mark `kill_agent` as deprecated (keep for backward compatibility)
3. Update examples and documentation

### Phase 3: Cleanup (Higher Risk)
1. Remove `KillAgentTool` entirely
2. Update any code referencing it
3. Final documentation review

---

## What to Keep vs. Remove

### KEEP
- ✅ `agent_pool` tool - Core pool management
- ✅ `agent` tool - General delegation
- ✅ `explore` tool - Specialized exploration (read-only)
- ✅ `plan` tool - Specialized planning
- ✅ `ask_agent` tool - Agent conversation
- ✅ `/agent` command - User-friendly CLI interface

### REMOVE
- ❌ `kill_agent` tool - Redundant with `agent_pool(clear_agent)`

### ENHANCE
- `agent_pool` tool - Add `list_persistent_agents`, `get_agent_usage`
- `/agent` command - Add subcommands for new operations, delegate existing ones to `agent_pool`

---

## Expected Benefits

1. **Clarity**: Single source of truth for pool operations
2. **Consistency**: All pool operations go through `agent_pool` or `/agent`
3. **Discoverability**: Users/LLMs know exactly which tool to use
4. **Maintainability**: Pool operation changes in one place
5. **Extensibility**: Easier to add new pool operations
6. **Reduced Confusion**: No more "which tool should I use?" questions

---

## Files to Modify

| File | Action | Priority |
|------|--------|----------|
| `src/tools/AgentPoolTool.ts` | Enhance with new operations | P2 |
| `src/tools/KillAgentTool.ts` | Remove (after deprecation) | P3 |
| `src/agent/commands/AgentCommand.ts` | Refactor to delegate to agent_pool | P2 |
| Documentation | Update tool guidance | P1 |

---

## Before and After

### BEFORE
```
User: How do I clear an agent?
Me: Use /agent clear, or kill_agent(), or agent_pool(clear_agent)... it's complicated
```

### AFTER
```
User: How do I clear an agent?
Me: Use agent_pool(clear_agent) if you're an LLM, or /agent clear if you're a user
```

---

## Implementation Priority

1. **Phase 1 is IMMEDIATE** - Low risk, high value, takes ~2 hours
2. **Phase 2 is SOON** - Medium risk, good cleanup, takes ~3 hours
3. **Phase 3 is OPTIONAL** - Breaking change, can wait until next major version

