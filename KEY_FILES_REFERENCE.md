# CodeAlly Key Files Reference

## System Prompts and Directives

### Primary System Message File
**File**: `/Users/bhm128/code-ally/src/prompts/systemMessages.ts`

Contains:
- `ALLY_IDENTITY` - Agent role definition
- `BEHAVIORAL_DIRECTIVES` - Core behavioral rules
- `AGENT_DELEGATION_GUIDELINES` - When to use each agent/tool
- `GENERAL_GUIDELINES` - Code conventions and patterns
- `CORE_DIRECTIVES` - Complete directive set
- `EXPLORATION_BASE_PROMPT` - Base prompt for explore agents
- `EXPLORATION_SYSTEM_PROMPT` - Full exploration agent prompt
- `PLANNING_BASE_PROMPT` - Base prompt for planning agents
- `PLANNING_SYSTEM_PROMPT` - Full planning agent prompt

Key Functions:
- `getMainSystemPrompt()` - Generate main agent system prompt
- `getAgentSystemPrompt()` - Generate specialized agent prompt
- `getContextInfo()` - Generate context section
- `getContextUsageInfo()` - Generate context budget info
- `getContextBudgetReminder()` - Generate context warnings

Lines 1-437: Complete implementation

## Agent System

### Agent Class
**File**: `/Users/bhm128/code-ally/src/agent/Agent.ts`

Purpose:
- Main orchestrator for LLM conversation
- Manages message history
- Sends messages to LLM
- Parses tool calls from LLM responses
- Handles follow-up responses after tool execution
- Emits events for UI updates

Key Methods:
- Constructor: Initialize agent
- `sendMessage()` - Send user message and get response
- `addAssistantMessage()` - Add assistant message to history
- `addToolResult()` - Add tool result to conversation
- `_continueAfterToolExecution()` - Process tool results
- `_prepareSystemPrompt()` - Generate dynamic system prompt

Lines 1-1500+: Extensive implementation

### Agent Manager
**File**: `/Users/bhm128/code-ally/src/services/AgentManager.ts`

Purpose:
- Load/save agent definitions from disk
- Agent storage/retrieval
- Default agent creation

Key Methods:
- `loadAgent(name)` - Load agent by name
- `saveAgent(agent)` - Save agent to disk
- `deleteAgent(name)` - Delete agent
- `listAgents()` - List all agents
- `ensureDefaultAgent()` - Create default general agent
- `getDefaultAgentPrompt()` - Get default system prompt

Storage:
- Location: `~/.code_ally/agents/`
- Format: Markdown files with YAML metadata
- Naming: `{agent_name}.md`

### Agent Pool Service
**File**: `/Users/bhm128/code-ally/src/services/AgentPoolService.ts`

Purpose:
- Manage pool of reusable agent instances
- LRU (Least Recently Used) eviction
- Idle timeout eviction
- Agent lifecycle management

Configuration:
- `maxPoolSize`: 10 agents
- `idleTimeoutMs`: 5 minutes
- `cleanupIntervalMs`: 1 minute

Key Methods:
- `getOrCreateAgent()` - Get agent from pool or create
- `submitTask()` - Submit task to agent queue
- `releaseAgent()` - Return agent to pool
- `evictIdleAgents()` - Remove inactive agents

## Tool System

### Base Tool Class
**File**: `/Users/bhm128/code-ally/src/tools/BaseTool.ts`

Purpose:
- Abstract base class for all tools
- Common functionality for execution, error handling, events

Key Properties:
- `name` - Unique tool identifier
- `description` - LLM-facing description
- `requiresConfirmation` - User permission required
- `suppressExecutionAnimation` - Suppress standard animation
- `usageGuidance` - Tool usage tips for system prompt
- `visibleInChat` - Show in UI
- `shouldCollapse` - Collapse output after completion

Key Methods:
- `execute()` - Execute tool with parameters
- `executeImpl()` - Implementation in subclass
- `previewChanges()` - Show changes before execution
- `formatSuccessResponse()` - Format successful result
- `formatErrorResponse()` - Format error result

### Tool Manager
**File**: `/Users/bhm128/code-ally/src/tools/ToolManager.ts`

Purpose:
- Tool registration and management
- Function definition generation
- Tool execution with permission checks
- Usage guidance extraction

Key Methods:
- `getFunctionDefinitions()` - Get all tool function defs
- `getTool()` - Get tool by name
- `registerTools()` - Register new tools
- `executeTool()` - Execute tool with args
- `getToolUsageGuidance()` - Extract guidance strings

Tool Count: ~30 tools (read, write, edit, grep, glob, bash, agent, explore, plan, agent_ask, todos, sessions, etc.)

### Specialized Agent Tools

#### Explore Tool
**File**: `/Users/bhm128/code-ally/src/tools/ExploreTool.ts`

- Creates read-only exploration agent
- Tools: read, glob, grep, ls, tree, batch (READ-ONLY)
- Function parameter: `task_description`
- Returns: Comprehensive findings with multiple files

#### Plan Tool
**File**: `/Users/bhm128/code-ally/src/tools/PlanTool.ts`

- Creates planning agent
- Tools: read, glob, grep, ls, tree, batch, explore, todo_add
- Function parameter: `requirements`
- Returns: Implementation plan with proposed todos

#### Agent Tool
**File**: `/Users/bhm128/code-ally/src/tools/AgentTool.ts`

- Generic agent delegation
- Tools: Configurable per agent (default: all)
- Function parameters: `task_prompt`, `agent_name`, `thoroughness`, `persist`
- Returns: Agent task result

#### Agent Ask Tool
**File**: `/Users/bhm128/code-ally/src/tools/AgentAskTool.ts`

- Continue conversation with persistent agent
- Function parameters: `agent_id`, `message`, `thoroughness`
- Returns: Agent response to follow-up message

### Read-Only Tools

#### Read Tool
**File**: `/Users/bhm128/code-ally/src/tools/ReadTool.ts`

- Read file contents
- Multiple files in single call
- Supports line limits and offsets
- Usage guidance: Keep in context, avoid ephemeral reads

#### Grep Tool
**File**: `/Users/bhm128/code-ally/src/tools/GrepTool.ts`

- Search with regex patterns
- Output modes: files_with_matches, content, count
- Context lines: -A, -B, -C
- Multiline pattern support

#### Glob Tool
**File**: `/Users/bhm128/code-ally/src/tools/GlobTool.ts`

- Find files by pattern
- Fast-glob implementation
- Supports exclusion patterns

#### Tree Tool
**File**: `/Users/bhm128/code-ally/src/tools/TreeTool.ts`

- Display directory structure
- Depth control
- Automatic filtering of build artifacts
- Usage guidance: Better than multiple ls calls

### Write/Modify Tools

#### Write Tool
**File**: `/Users/bhm128/code-ally/src/tools/WriteTool.ts`

- Write new files
- Requires confirmation
- Creates parent directories if needed

#### Edit Tool
**File**: `/Users/bhm128/code-ally/src/tools/EditTool.ts`

- Edit file content
- Line range specification
- Requires confirmation

#### Line Edit Tool
**File**: `/Users/bhm128/code-ally/src/tools/LineEditTool.ts`

- Edit specific line ranges
- Targeted modifications
- Requires confirmation

#### Bash Tool
**File**: `/Users/bhm128/code-ally/src/tools/BashTool.ts`

- Execute shell commands
- Requires confirmation
- Timeout management
- Output streaming

## Tool Execution

### Tool Orchestrator
**File**: `/Users/bhm128/code-ally/src/agent/ToolOrchestrator.ts`

Purpose:
- Coordinate tool execution (concurrent vs sequential)
- Manage tool call processing
- Handle permissions
- Format tool results

Key Methods:
- `executeToolCalls()` - Execute tool calls
- `canRunConcurrently()` - Determine execution mode
- `executeConcurrent()` - Run read-only tools in parallel
- `executeSequential()` - Run destructive tools sequentially

Safe Concurrent Tools:
- read, glob, grep, ls, tree, batch, web_fetch, agent
- git_status, git_log, git_diff

Sequential (Destructive) Tools:
- write, edit, line_edit, bash, lint, format, etc.

## Configuration

### Constants
**File**: `/Users/bhm128/code-ally/src/config/constants.ts`

- API timeouts (LLM, Ollama, TSC, etc.)
- Polling intervals
- Cache timeouts
- Time unit conversions
- Agent pool settings
- Permission messages
- Formatting constants

### Tool Defaults
**File**: `/Users/bhm128/code-ally/src/config/toolDefaults.ts`

- Tool operation limits (max results, file sizes, depth)
- File exclusion patterns
- Timeout limits
- Token count estimates
- Context usage thresholds
- Tool operation names

### Configuration Index
**File**: `/Users/bhm128/code-ally/src/config/index.ts`

Central index for all configuration exports

## CLI Entry Point

### Main CLI
**File**: `/Users/bhm128/code-ally/src/cli.ts`

Lines 469-496: Tool initialization
```typescript
new BashTool(activityStream, config),
new ReadTool(activityStream, config),
new WriteTool(activityStream),
// ... all other tools ...
new FormatTool(activityStream),
```

Also handles:
- Argument parsing
- Configuration commands
- Session management
- Mode selection (interactive, once, setup)
- Service registry initialization
- Agent pool setup

## Key Data Flows

### System Prompt Generation Flow
```
getMainSystemPrompt()
  ├─ CORE_DIRECTIVES
  ├─ Once-Mode Instructions (if applicable)
  ├─ Tool Usage Guidance (from all tools)
  ├─ Context Budget Reminder (if 75%+ usage)
  ├─ Context Information
  │   ├─ Current Date/Time
  │   ├─ Working Directory
  │   ├─ OS/Node Version
  │   ├─ Project Context
  │   └─ Git Branch
  └─ Todo Context (from TodoManager)
```

### Tool Execution Flow
```
Agent.sendMessage()
  ├─ Calls LLM with function definitions
  ├─ Parses tool calls from response
  ├─ ToolOrchestrator.executeToolCalls()
  │   ├─ Determines concurrent vs sequential
  │   ├─ Executes tools
  │   └─ Formats results
  ├─ Adds tool results to conversation
  ├─ Agent.sendMessage() (follow-up)
  └─ Parses next response
```

### Agent Delegation Flow
```
Main Agent receives exploration request
  ├─ Decides to use explore tool
  ├─ ExploreTool creates specialized agent
  │   ├─ Loads EXPLORATION_SYSTEM_PROMPT
  │   ├─ Executes task with read-only tools
  │   └─ Returns comprehensive findings
  └─ Main agent receives and uses results
```

## Quick Navigation

**Need to understand...** | **Look at...**
---|---
System prompts and directives | `/src/prompts/systemMessages.ts`
Agent behavior | `/src/agent/Agent.ts`
How agents are loaded/saved | `/src/services/AgentManager.ts`
Tool registration | `/src/tools/ToolManager.ts`
Specific tool implementation | `/src/tools/{ToolName}Tool.ts`
Tool execution coordination | `/src/agent/ToolOrchestrator.ts`
Configuration defaults | `/src/config/constants.ts`, `/src/config/toolDefaults.ts`
CLI entry point | `/src/cli.ts`
Tool pool management | `/src/services/AgentPoolService.ts`

## Agent Metadata Format

**File location**: `~/.code_ally/agents/{name}.md`

**Example**:
```markdown
---
name: security-reviewer
description: Code security and vulnerability analysis specialist
system_prompt: |
  You are a security expert specializing in...
model: claude-opus
temperature: 0.2
tools:
  - read
  - glob
  - grep
  - bash
  - lint
---

# Security Review Agent

This agent specializes in...
```

**Fields**:
- `name` (required): Agent identifier
- `description` (required): Human-readable description
- `system_prompt` (required): LLM system prompt
- `model` (optional): Override default model
- `temperature` (optional): Override default temperature
- `tools` (optional): Restrict tool access (empty = all tools)
- `created_at` (optional): Creation timestamp
- `updated_at` (optional): Last update timestamp

