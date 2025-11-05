# CodeAlly Prompting Patterns Exploration - Summary

## Completed Tasks

I have thoroughly explored the CodeAlly codebase and created comprehensive documentation on how tools, agents, and prompting patterns work. Three detailed reference documents have been created in the repository:

1. **PROMPTING_PATTERNS_ANALYSIS.md** (649 lines) - Complete detailed analysis
2. **TOOL_ROUTING_GUIDE.md** - Quick decision trees and anti-patterns
3. **KEY_FILES_REFERENCE.md** - File locations and navigation guide

## Key Findings

### 1. Agent Architecture (5 Types)

- **Main Agent (Ally)**: Full capability, all tools available
- **Explore Agent**: Read-only investigation with 6 tools
- **Plan Agent**: Planning/architecture with 8 tools
- **General-Purpose Agent**: Customizable, loaded from disk
- **Custom Named Agents**: User-defined agents in `~/.code_ally/agents/`

### 2. System Prompts (Layered Structure)

```
CORE_DIRECTIVES
├── ALLY_IDENTITY
├── BEHAVIORAL_DIRECTIVES (9 key principles)
├── AGENT_DELEGATION_GUIDELINES (4 agent types)
├── GENERAL_GUIDELINES (best practices)
└── Dynamic Context (injected per request)
    ├── Current info (date, OS, working dir)
    ├── Project context (type, languages, frameworks)
    ├── Context usage warnings (70%, 75%, 90% thresholds)
    ├── Active todos
    └── Tool usage guidance (from each tool)
```

### 3. Tool Categories (30+ Tools)

**Read-Only (Parallel Safe)**
- read, glob, grep, ls, tree, batch

**Write/Modify (Sequential)**
- write, edit, line_edit, bash, lint, format

**Agent Delegation**
- agent (generic), explore (read-only), plan (planning), agent_ask (follow-up)

**Task Management**
- todo_add, todo_update, todo_remove, todo_list, todo_clear, deny_proposal

**Sessions**
- list_sessions, session_lookup, session_read, ask_session

### 4. Prompting Principles (10 Core)

1. **Post-Tool Response Required**: Summarize after every tool call
2. **Direct Tool Usage**: Never ask user to run commands
3. **Conciseness**: 1-3 sentences unless detail requested
4. **Error Recovery**: Analyze failures, adjust approach
5. **Loop Avoidance**: Detect repeating patterns, reassess
6. **Task Structuring**: Use todos for multi-step work
7. **Agent Delegation**: Delegate exploration, planning, specialized tasks
8. **Tool Selection Specificity**: Use specialized tools over generic
9. **Trust Delegation**: Trust specialized agent results
10. **Behavioral Directives Over Prescriptive**: Principles-based guidance

### 5. Tool Routing Logic

**Decision Tree**:
```
Is it code exploration? → explore tool
Is it planning? → plan tool
Is it complex specialized? → agent tool
Is it follow-up to agent? → agent_ask tool
Is it specific file? → read tool
Is it file search? → glob/grep tools
Is it structure? → tree tool
Otherwise → Direct tools (write, edit, bash, etc.)
```

### 6. Dynamic System Prompt Injection

The system prompt is regenerated for EVERY request and includes:
- **Tool Usage Guidance**: Each tool's `usageGuidance` string
- **Context Budget Warnings**: At 75% and 90% usage
- **Todo Context**: Current active todos with progress
- **Project Information**: Detected languages, frameworks, tools
- **Agent List**: Available custom agents

### 7. Configuration Points

**Agent Configuration**
- File: `~/.code_ally/agents/{name}.md` (markdown with YAML metadata)
- Per-agent: system_prompt, model, temperature, tool access

**Tool Limits**
- Max search results: 100
- Max file size: 1MB
- Max directory entries: 1000
- Timeouts: 5-60 seconds (configurable)

**Pool Configuration**
- Max agents: 10
- Idle timeout: 5 minutes
- Cleanup interval: 1 minute

### 8. Execution Model

**Tool Execution Coordination**:
- **Concurrent**: Safe tools (read, glob, grep, etc.)
- **Sequential**: Destructive tools (write, edit, bash, etc.)
- **Agent Tools**: Managed by agent, runs in isolated context

**Permission Model**:
- **Read Operations**: No confirmation needed
- **Write Operations**: User confirmation required
- **Sensitive Commands**: Always prompt
- **Dangerous Commands**: Always prompt, no "Always Allow" option

### 9. Key Files

**Core System**:
- `/src/prompts/systemMessages.ts` - All prompts and directives (437 lines)
- `/src/agent/Agent.ts` - Main orchestrator (1500+ lines)
- `/src/agent/ToolOrchestrator.ts` - Tool execution coordination

**Agent Management**:
- `/src/services/AgentManager.ts` - Agent loading/saving
- `/src/services/AgentPoolService.ts` - Pool management

**Tool System**:
- `/src/tools/BaseTool.ts` - Base class
- `/src/tools/ToolManager.ts` - Tool registration
- `/src/tools/{Explore,Plan,Agent,AgentAsk}Tool.ts` - Specialized agents

**Configuration**:
- `/src/config/constants.ts` - Application constants
- `/src/config/toolDefaults.ts` - Tool limits and thresholds

### 10. Anti-Patterns Identified

**Avoid**:
1. Using explore for specific file finds (use glob instead)
2. Manual exploration sequences (use explore once)
3. Planning without plan tool (unstructured)
4. Sequential reads when batch available (use read with multiple files)
5. Asking user to run commands (use bash directly)

## Most Important Insights

### Insight #1: Tool Usage Guidance is Systemic
Every tool's `usageGuidance` string is automatically injected into the system prompt every turn. This creates contextual guidance without explicit instruction - the LLM learns when to use each tool through prompt injection rather than hard-coded logic.

**Location**: `/src/tools/ToolManager.ts:194-226`

### Insight #2: Behavioral Directives Over Prescriptive Instructions
Rather than detailed step-by-step prompts for specific scenarios, the system emphasizes principles like "avoid loops", "use multiple tools per response", "trust specialized agents". This allows the LLM more flexibility while still providing guidance.

**Location**: `/src/prompts/systemMessages.ts:26-44`

### Insight #3: Context-Aware Dynamic Prompting
The system prompt is completely regenerated for each request, including dynamic context usage warnings, current todos, and tool-specific guidance. This makes the LLM responsive to current state without requiring state-specific response templates.

**Location**: `/src/prompts/systemMessages.ts:312-379`

### Insight #4: Specialization Through System Prompts
Different agents have dramatically different system prompts and tool access. Explore agent gets read-only tools + "You have READ-ONLY access" directive. Plan agent gets planning tools + "Ground recommendations in existing patterns". This specialization is purely through prompt variation.

**Location**: `/src/tools/{Explore,Plan}Tool.ts`

### Insight #5: Post-Tool Response Requirement
The system requires "After executing tools, you MUST provide a text response. NEVER end with only tool calls." This single directive prevents tool-only responses and forces the LLM to summarize findings, which increases transparency and reduces silent failures.

**Location**: `/src/prompts/systemMessages.ts:28-29`

## Recommendations for Improvement

1. **Document the usageGuidance pattern** as a reusable prompting technique for other projects
2. **Extract behavioral directives** into a library for other LLM applications
3. **Create specialized agent templates** for common roles (security, performance, testing)
4. **Add dynamic prompt generation tests** to verify context injection
5. **Create a prompt audit trail** to debug which version of system prompt was used for each response
6. **Implement A/B testing framework** for prompting variations
7. **Add telemetry** to track which tools/agents are used most effectively
8. **Create agent orchestration patterns** for complex multi-agent workflows

## Files Created in Repository

All documents saved to `/Users/bhm128/code-ally/`:

1. `PROMPTING_PATTERNS_ANALYSIS.md` - Complete analysis (649 lines)
2. `TOOL_ROUTING_GUIDE.md` - Quick reference and decision trees
3. `KEY_FILES_REFERENCE.md` - File locations and navigation
4. `EXPLORATION_SUMMARY.md` - This summary

## How to Use These Documents

- **New Team Member**: Read `KEY_FILES_REFERENCE.md` first, then `TOOL_ROUTING_GUIDE.md`
- **Prompt Engineer**: Read `PROMPTING_PATTERNS_ANALYSIS.md` sections 2-7
- **Tool Developer**: Read `KEY_FILES_REFERENCE.md` section "Tool System"
- **Agent Specialist**: Read `KEY_FILES_REFERENCE.md` section "Agent System"
- **Quick Lookup**: Use `TOOL_ROUTING_GUIDE.md` decision tree

---

**Exploration completed**: Successfully mapped agents, tools, prompting patterns, system prompts, and configuration across the entire CodeAlly codebase.
