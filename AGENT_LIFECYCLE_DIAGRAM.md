# Agent Lifecycle Management - Visual Architecture

## Current System State (Redundant)

```
┌─────────────────────────────────────────────────────────────────┐
│                         User/LLM Interface                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  CLI Commands (/agent)    Tools (agent_pool)   Other Tools       │
│  ├─ /agent active    ┄┄┄┄ agent_pool(list)   ├─ explore()       │
│  ├─ /agent stats     ┄┄┄┄ agent_pool(stats)  ├─ plan()          │
│  ├─ /agent clear     ┄┄┄┄ agent_pool(clear)  ├─ agent()         │
│  └─ ...              ┄┄┄┄ ...                └─ ask_agent()     │
│                          ▲                                       │
│                   DUPLICATE  ┌──────────────────┐               │
│                          │   │                  │               │
│                          │   │  kill_agent()    │               │
│                          │   │  (redundant!)    │               │
│                          └───┴──────────────────┘               │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                                ▼
                        ┌────────────────────┐
                        │  AgentPoolService  │
                        │                    │
                        │ (Single Source     │
                        │  of Truth)         │
                        └────────────────────┘
                                ▼
                        ┌────────────────────┐
                        │  Agent Pool        │
                        │  (In Memory)       │
                        └────────────────────┘
```

## Problems in Current Architecture

1. **Multiple Paths to Same Operation**
   - Clear agent: `/agent clear ID` OR `kill_agent(ID)` OR `agent_pool(clear_agent, ID)`
   - List agents: `/agent active` OR `agent_pool(list_agents)`
   - Get stats: `/agent stats` OR `agent_pool(get_stats)`

2. **Inconsistent Parameter Styles**
   ```
   agent_pool(operation="clear_agent", agent_id="X")    # enum + named param
   kill_agent(agent_id="X")                             # direct param
   /agent clear X                                        # subcommand + arg
   ```

3. **Unclear Tool Hierarchy**
   - Is `kill_agent` a convenience wrapper or its own tool?
   - Should LLM use `kill_agent` or `agent_pool`?
   - No guidance on when to use each

---

## Recommended Future State

```
┌─────────────────────────────────────────────────────────────────┐
│                    Primary User Interface                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  User CLI Commands             Agent/LLM Tools                   │
│  (/agent subcommands)          (Programmatic API)                │
│                                                                   │
│  ┌────────────────────────┐   ┌──────────────────────────────┐  │
│  │ /agent active    ──────┼──▶│ agent_pool(list_agents)      │  │
│  │ /agent stats     ──────┼──▶│ agent_pool(get_stats)        │  │
│  │ /agent clear     ──────┼──▶│ agent_pool(clear_agent|pool) │  │
│  │ /agent create/  ┐      │   │                              │  │
│  │   ls/show/del   └─────▶│   │ (Only interface for pool ops)│  │
│  │                        │   └──────────────────────────────┘  │
│  └────────────────────────┘                                     │
│           ▼                                                      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │         Specialized Delegation Tools                        │ │
│  │  (Each serves distinct purpose, all can persist=true)      │ │
│  │                                                             │ │
│  │  • explore()    - Read-only codebase exploration           │ │
│  │  • plan()       - Implementation planning with research    │ │
│  │  • agent()      - General task delegation                  │ │
│  │  • ask_agent()  - Continue conversation with pooled agent │ │
│  │                                                             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                                ▼
                        ┌────────────────────┐
                        │  AgentPoolService  │
                        │                    │
                        │ (Single Source     │
                        │  of Truth)         │
                        └────────────────────┘
                                ▼
                        ┌────────────────────┐
                        │  Agent Pool        │
                        │  (In Memory)       │
                        │                    │
                        │ [Agent instances   │
                        │  with metadata]    │
                        └────────────────────┘
```

## Consolidation Changes

### Remove
- `kill_agent()` Tool - Redundant with `agent_pool(operation="clear_agent")`

### Keep & Enhance
- `agent_pool()` Tool - Single source of truth for pool operations
  - Add: `list_persistent_agents` - Show only reusable agents
  - Add: `get_agent_usage` - Usage statistics and idle times
  - Keep: `list_agents`, `get_stats`, `clear_pool`, `clear_agent`

- `/agent` Command - User-friendly wrapper
  - Delegates all pool operations to `agent_pool` tool
  - Keeps specialized agent management (`create/ls/show/delete`)

### Keep Unchanged
- `explore()` Tool - Specialized read-only delegation
- `plan()` Tool - Specialized planning delegation  
- `agent()` Tool - General purpose delegation
- `ask_agent()` Tool - Agent conversation

---

## Operation Matrix: Before and After

### BEFORE (Current - Redundant)
| Operation | Method 1 | Method 2 | Method 3 | Best? |
|-----------|----------|----------|----------|-------|
| List agents | `/agent active` | `agent_pool(list)` | - | ? |
| Get stats | `/agent stats` | `agent_pool(stats)` | - | ? |
| Remove agent | `/agent clear ID` | `kill_agent(ID)` | `agent_pool(clear, ID)` | ??? |
| Remove all | `/agent clear` | `agent_pool(clear_pool)` | - | ? |

### AFTER (Consolidated)
| Operation | Programmatic | User-Friendly |
|-----------|--------------|----------------|
| List agents | `agent_pool(list_agents)` | `/agent active` |
| Get stats | `agent_pool(get_stats)` | `/agent stats` |
| Remove agent | `agent_pool(clear_agent, ID)` | `/agent clear ID` |
| Remove all | `agent_pool(clear_pool)` | `/agent clear` |
| List persistent | `agent_pool(list_persistent)` | `/agent list-persistent` |
| Get usage | `agent_pool(get_usage)` | `/agent usage` |

---

## Implementation Roadmap

### Phase 1: Enhancement (Lowest risk)
- Add new operations to `agent_pool`: `list_persistent_agents`, `get_agent_usage`
- Add corresponding `/agent` subcommands
- Document clear guidance on tool usage

### Phase 2: Consolidation (Medium risk)
- Make `/agent` commands delegate to `agent_pool` tool
- Add deprecation warning to `kill_agent`
- Update documentation and examples

### Phase 3: Cleanup (Higher risk - breaking changes)
- Remove `KillAgentTool` entirely
- Update any code that references it
- Final documentation review

---

## Benefits of Consolidation

1. **Single Source of Truth**: One tool for all pool operations
2. **Clear Hierarchy**: Pool operations vs. delegation operations  
3. **Consistent API**: All pool operations through one interface
4. **Better Discoverability**: CLI and LLM both directed to same tool
5. **Easier Maintenance**: Changes to pool operations in one place
6. **Clearer Semantics**: No confusion about which tool to use when

