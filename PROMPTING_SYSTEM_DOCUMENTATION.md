# Ally Model Prompting System - Comprehensive Documentation

This document details every location where instructions and guidance are provided to the language model in the Ally codebase.

## Table of Contents

1. [Main System Prompt](#1-main-system-prompt)
2. [Dynamic System Prompt Components](#2-dynamic-system-prompt-components)
3. [Temporary System Reminders](#3-temporary-system-reminders)
4. [Tool Descriptions and Function Definitions](#4-tool-descriptions-and-function-definitions)
5. [Tool Usage Guidance](#5-tool-usage-guidance)
6. [Specialized Agent Prompts](#6-specialized-agent-prompts)
7. [Project-Specific Instructions (ALLY.md)](#7-project-specific-instructions-allymd)
8. [Context Information](#8-context-information)
9. [Token Budget Warnings](#9-token-budget-warnings)
10. [Todo System Integration](#10-todo-system-integration)
11. [Complete File Reference](#11-complete-file-reference)

---

## 1. Main System Prompt

**Location:** [src/prompts/systemMessages.ts](src/prompts/systemMessages.ts)

The main system prompt is composed of multiple sections that define the agent's identity and behavior.

### Core Components

#### 1.1 ALLY_IDENTITY (Line 23)
```typescript
const ALLY_IDENTITY = `You are Ally, an AI pair programming assistant. Use tools directly to complete tasks efficiently. Apply creative problem solving and leverage tool combinations to find elegant solutions.`;
```

**Purpose:** Establishes the agent's core identity as a pair programming assistant.

---

#### 1.2 BEHAVIORAL_DIRECTIVES (Lines 26-43)
```
## Behavior

**CRITICAL: After executing tools, you MUST provide a text response. NEVER end with only tool calls.**
- Summarize what you learned/accomplished
- If tools failed, explain what went wrong and your next step
- If continuing work, briefly state progress

- **Direct execution**: Use tools yourself, never ask users to run commands
- **Concise responses**: Answer in 1-3 sentences unless detail requested. No emoji in responses.
- **Task management (optional)**: For complex multi-step tasks, consider using todos...
- **Stay focused on your current task**: Don't get distracted by tangential findings...
- **Error handling**: If a tool fails, analyze the error and try again with adjustments
- **Avoid loops**: If you find yourself repeating the same steps, reassess your approach
- **Batch operations**: Use multiple tools per response for efficiency...
- **Always verify**: Test/lint code after changes, if applicable
- **Professional objectivity**: Prioritize technical accuracy and truthfulness...
- **Use only available tools**: Only use tools that are explicitly listed...
- **Trust agent outputs**: When delegating to specialized agents, trust their results...
```

**Purpose:** Defines critical behavioral rules that apply to all agents, including:
- Mandatory text responses after tool use
- Direct execution philosophy
- Response conciseness
- Task management with todos
- Focus and error handling
- Professional objectivity

---

#### 1.3 AGENT_DELEGATION_GUIDELINES (Lines 46-83)
```
## Planning
- **Use plan tool for**: New features, complex fixes, significant changes...
- **Skip planning for**: Quick fixes, simple adjustments...

## Breaking Up Large Todo Lists
- **For large todo lists (5+ items)**: Consider delegating subsets...

## Exploration and Analysis
- **Codebase exploration**: "Find X", "How does Y work?" → Use `explore` tool

## When to Use Each Approach
- `plan`: Multi-step features, fixes, or changes needing structured approach
- `explore`: Quick read-only codebase investigation
- `agent`: Complex tasks requiring multiple steps
- Manual tools: Simple, single-file operations

## Parallel Execution with batch()
When multiple independent tasks can run concurrently (max 5 per batch)...

## Agent Tagging (@agent syntax)
When user uses @agent_name syntax, parse the agent name and delegate...
```

**Purpose:** Provides detailed guidance on:
- When to use planning vs. exploration vs. direct execution
- How to break down large tasks
- Parallel execution strategies
- Agent delegation patterns

**Note:** This section only appears in the main agent prompt, not specialized agents.

---

#### 1.4 GENERAL_GUIDELINES (Lines 86-106)
```
## Code Conventions
- Check existing patterns/libraries before creating new code
- Follow surrounding context for framework choices

## File Operations
- For structural corruption or when line-based edits fail: Read entire file, then Write
- Use incremental editing (edit, line_edit) for normal changes

## File References
When referencing specific code locations, use markdown link format:
- [src/utils/helper.ts:42](src/utils/helper.ts:42) - with line number
- [src/example.txt](src/example.txt) - without line number

## Prohibited
- Committing without explicit request
- Adding explanations unless asked
- Making framework assumptions
```

**Purpose:** Establishes conventions for:
- Code pattern discovery
- File editing strategies
- Code reference formatting
- Prohibited behaviors

---

#### 1.5 CORE_DIRECTIVES (Lines 109-115)
Combines all the above sections into a single string used as the base for main agent prompts.

---

### 1.6 Main Prompt Generation

**Function:** `getMainSystemPrompt()` (Lines 265-329)

**Generation Process:**
1. Get context information (date, directory, OS, project info, git branch, ALLY.md)
2. Get todo status and active context
3. Get tool usage guidance from all tools
4. Add single-response mode instructions (if applicable)
5. Combine: `CORE_DIRECTIVES + once-mode instructions + tool guidance + context + todo context`

**Regeneration:** The system prompt is regenerated **before every LLM call** with current context (see [src/agent/Agent.ts:569-592](src/agent/Agent.ts:569-592)).

---

## 2. Dynamic System Prompt Components

These components are dynamically generated and injected into the system prompt at runtime.

### 2.1 Once-Mode Instructions (Lines 317-322)

When running in single-response mode (`--once` flag):

```
**IMPORTANT - Single Response Mode:**
This is a non-interactive, single-turn conversation. Your response will be final
and the conversation will end immediately after you respond. There is no opportunity
for follow-up questions or clarification. Make your response complete, clear, and
self-contained.
```

**Purpose:** Ensures the model provides complete, self-contained responses in non-interactive mode.

---

### 2.2 System Prompt Regeneration

**Location:** [src/agent/Agent.ts:569-592](src/agent/Agent.ts:569-592)

**Trigger:** Before **every** LLM request

**Process:**
```typescript
// Regenerate system prompt with current context
let updatedSystemPrompt: string;
if (this.config.isSpecializedAgent) {
  updatedSystemPrompt = await getAgentSystemPrompt(
    this.config.baseAgentPrompt!,
    this.config.taskPrompt!,
    this.tokenManager,
    this.toolResultManager
  );
} else {
  updatedSystemPrompt = await getMainSystemPrompt(
    this.tokenManager,
    this.toolResultManager,
    false
  );
}
this.messages[0].content = updatedSystemPrompt;
```

**Purpose:** Ensures the model always has:
- Current token usage information
- Latest todo status
- Updated context information
- Fresh tool guidance

---

## 3. Temporary System Reminders

System reminders are **temporary** messages injected before LLM calls and **removed** after receiving the response. They do not persist in conversation history.

**Removal Location:** [src/agent/Agent.ts:644-657](src/agent/Agent.ts:644-657)

```typescript
// Remove system-reminder messages after receiving response
this.messages = this.messages.filter(msg =>
  !(msg.role === 'system' && msg.content.includes('<system-reminder>'))
);
```

---

### 3.1 User Interruption Reminder

**Location:** [src/agent/Agent.ts:320-327](src/agent/Agent.ts:320-327)

**Trigger:** When user interrupts the agent

**Content:**
```xml
<system-reminder>
User interrupted. Prioritize answering their new prompt over continuing your todo list.
After responding, reassess if the todo list is still relevant. Do not blindly continue
with pending todos.
</system-reminder>
```

**Purpose:** Ensures the agent prioritizes new user input over existing todos after interruption.

---

### 3.2 Todo List Reminder

**Location:** [src/agent/Agent.ts:336-378](src/agent/Agent.ts:336-378)

**Trigger:** After every user message (main agent only, not specialized agents)

**Content (Empty Todo List):**
```xml
<system-reminder>
Note: The todo list is currently empty. For complex multi-step tasks, consider using
todo_add to track progress and stay focused. Todos provide reminders after each tool
use and help prevent drift. For simple single-step operations, todos are optional.
</system-reminder>
```

**Content (With Todos):**
```xml
<system-reminder>
Current todos:
1. [○] Pending task
2. [→] In-progress task
3. [✓] Completed task

You are currently working on: "In-progress task". Stay focused on completing this
task - don't get distracted by tangential findings in tool results unless they
directly block your progress.

Housekeeping: Keep the todo list clean and focused.
• Remove completed tasks that are no longer relevant to the conversation
• Remove pending tasks that are no longer needed
• Update task descriptions if they've changed
• Remember: when working on todos, keep exactly ONE task in_progress

Update the list now if needed based on the user's request.
</system-reminder>
```

**Purpose:**
- Nudges the model to use todos for complex tasks
- Shows current task list and status
- Reminds model to stay focused on current task
- Encourages todo list hygiene

---

### 3.3 Tool Context Reminder

**Location:** [src/agent/Agent.ts:594-609](src/agent/Agent.ts:594-609)

**Trigger:** When `currentToolContext` is set by a tool (e.g., plan or explore tools)

**Content:** Variable based on tool context

**Example (from PlanTool):**
```xml
<system-reminder>
You have just created a planning context with proposed todos. The user can either:
- Accept the plan (todos automatically activated)
- Reject the plan with deny_proposal()
- Ask for modifications

If the user accepts or starts working, the proposed todos become active automatically.
</system-reminder>
```

**Purpose:** Provides context-aware guidance after certain tools execute, potentially filtering available tools.

---

### 3.4 Required Tool Reminder

**Location:** [src/agent/Agent.ts:1083-1092](src/agent/Agent.ts:1083-1092)

**Trigger:** When agent tries to exit without calling required tools

**Content:**
```xml
<system-reminder>
You must call the following required tool(s) before completing your task: tool_name_1, tool_name_2
Please call these tools now.
</system-reminder>
```

**Maximum Warnings:** 3 (configurable via `BUFFER_SIZES.AGENT_REQUIRED_TOOL_MAX_WARNINGS`)

**Purpose:** Enforces completion of required tool calls before finishing task.

---

### 3.5 Partial Response Continuation Reminder

**Location:** [src/agent/Agent.ts:716-719](src/agent/Agent.ts:716-719) (partial HTTP errors)

**Trigger:** When LLM response is interrupted by HTTP error but has partial content/tool calls

**Content:**
```xml
<system-reminder>
Your previous response was interrupted. Continue from where you left off.
</system-reminder>
```

**Purpose:** Allows graceful continuation after network errors.

---

## 4. Tool Descriptions and Function Definitions

**Location:** [src/tools/ToolManager.ts:110-159](src/tools/ToolManager.ts:110-159)

### 4.1 Function Definition Generation

Each tool provides a function definition that describes:
- **name**: Tool identifier
- **description**: What the tool does
- **parameters**: JSON Schema for tool arguments

**Generation Methods:**

1. **Custom Definition** (tool implements `getFunctionDefinition()`)
   - Tool provides complete custom definition
   - Example: [BatchTool.ts:29-61](src/tools/BatchTool.ts:29-61)

2. **Default Definition** (introspection-based)
   - Generated from tool name and description
   - Used when tool doesn't provide custom definition

**Example Custom Definition (BatchTool):**
```typescript
getFunctionDefinition(): FunctionDefinition {
  return {
    type: 'function',
    function: {
      name: 'batch',
      description: 'Execute multiple tools concurrently in a single call...',
      parameters: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            description: 'Array of tool specifications to execute concurrently...',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Name of the tool to execute' },
                arguments: { type: 'object', description: 'Arguments to pass to the tool' }
              },
              required: ['name', 'arguments']
            }
          }
        },
        required: ['tools']
      }
    }
  };
}
```

---

### 4.2 Function Definitions Delivery

**Method:** Separate from system prompt via OpenAI function calling format

**Location in code:** [src/agent/Agent.ts:635-639](src/agent/Agent.ts:635-639)
```typescript
const response = await this.modelClient.send(this.messages, {
  functions,  // Function definitions passed separately
  stream: !this.config.isSpecializedAgent && this.config.config.parallel_tools,
});
```

**Purpose:** Enables structured tool calling via LLM's native function calling capability.

---

## 5. Tool Usage Guidance

In addition to function definitions, tools can provide extended usage guidance that is injected into the system prompt.

**Location:** [src/tools/ToolManager.ts:166-176](src/tools/ToolManager.ts:166-176)

**Collection Method:**
```typescript
getToolUsageGuidance(): string[] {
  const guidances: string[] = [];
  for (const tool of this.tools.values()) {
    if (tool.usageGuidance) {
      guidances.push(tool.usageGuidance);
    }
  }
  return guidances;
}
```

**Injection Point:** [src/prompts/systemMessages.ts:294-314](src/prompts/systemMessages.ts:294-314)

---

### 5.1 Example Tool Usage Guidance

#### ExploreTool ([src/tools/ExploreTool.ts:64-75](src/tools/ExploreTool.ts:64-75))

```
**When to use explore:**
- Understanding codebase structure and architecture
- Finding specific implementations or patterns
- Tracing feature implementations across files
- Analyzing dependencies and relationships

**Example usage:**
- explore(task_description="Find how user authentication is implemented")
- explore(task_description="Analyze the REST API structure and endpoints")
- explore(task_description="Understand the plugin system architecture")

The explore tool delegates to a read-only exploration agent. Use it instead of
manual grep/read sequences.
```

**Purpose:** Provides contextual examples and guidance beyond the basic function description.

---

### 5.2 System Prompt Injection

**Location:** [src/prompts/systemMessages.ts:304-308](src/prompts/systemMessages.ts:304-308)

```typescript
toolGuidanceContext = `

## Tool Usage Guidance

${guidances.join('\n\n')}`;
```

All tool usage guidance strings are combined under a "Tool Usage Guidance" section in the system prompt.

---

## 6. Specialized Agent Prompts

Specialized agents (created via `plan`, `explore`, or `agent` tools) receive different system prompts than the main agent.

**Location:** [src/prompts/systemMessages.ts:334-365](src/prompts/systemMessages.ts:334-365)

### 6.1 Agent Prompt Structure

```
**Primary Identity:**
{agentSystemPrompt}

{BEHAVIORAL_DIRECTIVES}

{GENERAL_GUIDELINES}

**Current Task:**
{taskPrompt}

**Context:**
{context}  (without agents list or project instructions to avoid recursion)

**Final Response Requirement**
As a specialized agent, you must conclude with a comprehensive final response...
- Monitor your context usage (shown above)
- At 90%+ context, stop using tools and provide your final summary
- Your final response should summarize: what you did, what you found, and recommendations
- If you run low on context, summarize what you've learned so far...

Execute this task thoroughly using available tools, then provide your comprehensive
final summary.
```

**Key Differences from Main Agent:**
- No `AGENT_DELEGATION_GUIDELINES` (can't delegate further)
- No project instructions (ALLY.md)
- No agents list (prevents recursion)
- Includes **Final Response Requirement** section
- Emphasizes comprehensive summary at completion

---

### 6.2 Hardcoded Specialized Prompts

Some tools provide hardcoded specialized prompts optimized for specific tasks.

#### PlanTool System Prompt ([src/tools/PlanTool.ts:30-111](src/tools/PlanTool.ts:30-111))

```
You are an expert implementation planner. Your role is to create detailed, actionable
implementation plans by researching existing patterns, understanding architecture, and
considering all necessary context.

**Your Capabilities:**
- View directory tree structures (tree) - understand project organization
- Search for files and patterns (glob, grep) - find similar implementations
- Read and analyze file contents (read) - study existing patterns
- List directory contents (ls)
- Execute parallel operations for efficiency (batch)
- Delegate complex exploration tasks (explore) - for deep pattern analysis
- Create proposed todo lists (todo_add) - draft structured implementation tasks...

**Your Planning Process:**
1. **Understand Requirements** - Parse the task, identify key components
2. **Assess Codebase State** - Determine what exists
3. **Research Patterns (if applicable)** - Find similar implementations
4. **Analyze Architecture** - Understand context
5. **Create Plan** - Produce detailed, actionable steps
6. **Create Proposed Todos** - Use todo_add() to draft implementation tasks

**Your Output Format (REQUIRED):**

## Implementation Plan

### Context
[Summarize the codebase state and relevant information]
...

### Implementation Steps
1. [Specific, actionable step with file references]
...

### Considerations
...

### Files to Modify/Create
...

### Proposed Todos
After providing the plan above, call todo_add() with proposed todos (status="proposed")
...
```

**Purpose:** Provides structured planning methodology and output format requirements.

---

#### ExploreTool System Prompt ([src/tools/ExploreTool.ts:29-53](src/tools/ExploreTool.ts:29-53))

```
You are a specialized code exploration assistant. Your role is to analyze codebases,
understand architecture, find patterns, and answer questions about code structure and
implementation.

**Your Capabilities:**
- View directory tree structures (tree) - preferred for understanding hierarchy
- Search for files and patterns across the codebase (glob, grep)
- Read and analyze file contents (read)
- List directory contents (ls)
- Execute parallel operations for efficiency (batch)

**Your Approach:**
- Start with structure: Use tree() to understand directory hierarchy and organization
- Search for patterns: Use glob/grep to find relevant files and implementations
- Read for details: Use read() to examine specific file contents
- Be systematic: Trace dependencies, identify relationships, understand flow
- Use batch() for parallel operations when appropriate
- Build comprehensive understanding before summarizing

**Important Guidelines:**
- You have READ-ONLY access - you cannot modify files
- Be thorough but efficient with tool usage (aim for 5-10 tool calls)
- Always provide clear, structured summaries of findings
- Highlight key files, patterns, and architectural decisions
- If you can't find something, explain what you searched and what was missing

Execute your exploration systematically and provide comprehensive results.
```

**Purpose:** Optimizes agent behavior for read-only exploration with systematic methodology.

---

## 7. Project-Specific Instructions (ALLY.md)

**File:** `ALLY.md` in the current working directory

**Loading Location:** [src/prompts/systemMessages.ts:181-197](src/prompts/systemMessages.ts:181-197)

### 7.1 Loading Process

```typescript
let allyMdContent = '';
if (includeProjectInstructions) {
  try {
    const allyMdPath = path.join(workingDir, 'ALLY.md');
    if (fs.existsSync(allyMdPath)) {
      const allyContent = fs.readFileSync(allyMdPath, 'utf-8').trim();
      if (allyContent) {
        allyMdContent = `
- Project Instructions (ALLY.md):
${allyContent}`;
      }
    }
  } catch (error) {
    logger.warn('Failed to read ALLY.md:', formatError(error));
  }
}
```

**When Loaded:**
- Main agent: Yes
- Specialized agents: No (to avoid recursion and context bloat)

**Purpose:** Provides project-specific instructions and conventions that override defaults.

---

### 7.2 Managing ALLY.md

**Tool:** [src/tools/AllyWriteTool.ts](src/tools/AllyWriteTool.ts)
- Appends content to ALLY.md file

**Commands:** Via [src/utils/ArgumentParser.ts](src/utils/ArgumentParser.ts)
- `/project init` - Create ALLY.md
- `/project show` - View ALLY.md
- `/project edit` - Edit ALLY.md

**Wizard:** [src/cli/ProjectWizard.ts](src/cli/ProjectWizard.ts)
- Interactive wizard for creating ALLY.md

---

## 8. Context Information

**Location:** [src/prompts/systemMessages.ts:167-260](src/prompts/systemMessages.ts:167-260)

**Function:** `getContextInfo()`

### 8.1 Context Components

The context section includes:

1. **Current Date** (ISO format)
2. **Working Directory** (absolute path)
3. **Git Branch** (if repository)
4. **Operating System** (platform and release)
5. **Node Version**
6. **Project Information** (detected)
   - Project type (Node.js, Python, etc.)
   - Languages
   - Frameworks
   - Package manager
   - Docker presence
   - CI/CD systems
7. **Context Usage** (percentage and estimated tool calls remaining)
8. **Project Instructions** (ALLY.md content)
9. **Available Agents** (list of specialized agents)

### 8.2 Example Context Output

```
- Current Date: 2025-10-31 14:32:15
- Working Directory: /Users/benmoore/CodeAlly-TS (git repository, branch: main)
- Operating System: darwin 25.0.0
- Node Version: v18.17.0
- Project: Node.js • TypeScript • Express • npm • Docker • GitHub Actions
- Context Usage: 45% (~25 tool calls remaining)
- Project Instructions (ALLY.md):
  When creating git commits, always use ./quick-commit tool if available.
- Available Agents:
  - general: General-purpose agent for complex tasks
  - security-reviewer: Security analysis and vulnerability detection
```

---

## 9. Token Budget Warnings

**Location:** [src/prompts/systemMessages.ts:120-162](src/prompts/systemMessages.ts:120-162)

**Function:** `getContextUsageInfo()`

### 9.1 Warning Thresholds

Defined in [src/config/toolDefaults.ts](src/config/toolDefaults.ts):

```typescript
export const CONTEXT_THRESHOLDS = {
  NORMAL: 70,    // Start mentioning context usage
  WARNING: 85,   // Warning level
  CRITICAL: 95,  // Critical level

  WARNINGS: {
    70: 'Context usage is moderate. Continue normally.',
    85: 'Context usage is high. Start wrapping up or use compaction.',
    95: 'CRITICAL: Context nearly full. Finish immediately or compact.'
  }
};
```

### 9.2 Warning Display

**Format:**
```
- Context Usage: 85% (~8 tool calls remaining)
  ⚠️ Context usage is high. Start wrapping up or use compaction.
```

**Purpose:** Helps the model manage context budget and decide when to conclude or compact.

---

### 9.3 Auto-Compaction

**Location:** [src/agent/Agent.ts](src/agent/Agent.ts) (various locations)

**Trigger:** When context usage exceeds `config.compact_threshold`

**Process:**
1. Detect threshold exceeded
2. Compact message history (summarize old messages)
3. Inject compaction notice system message

---

## 10. Todo System Integration

### 10.1 Todo Context in System Prompt

**Location:** [src/prompts/systemMessages.ts:269-291](src/prompts/systemMessages.ts:269-291)

**Generation:**
```typescript
let todoContext = '';
try {
  const serviceRegistry = ServiceRegistry.getInstance();
  if (serviceRegistry && serviceRegistry.hasService('todo_manager')) {
    const todoManager = serviceRegistry.get<any>('todo_manager');
    if (todoManager && typeof todoManager.generateActiveContext === 'function') {
      const todoStatus = todoManager.generateActiveContext();
      if (todoStatus) {
        todoContext = `\n${todoStatus}`;
      }

      // Log todos once per turn
      if (typeof todoManager.logTodosIfChanged === 'function') {
        todoManager.logTodosIfChanged();
      }
    }
  }
}
```

**Purpose:** Shows current todo status in the system prompt's context section.

---

### 10.2 TodoManager Service

**Location:** [src/services/TodoManager.ts](src/services/TodoManager.ts)

**Key Method:** `generateActiveContext()`

Generates a summary like:
```
📋 Active Todos (3/5 completed):
→ Currently working on: "Implement user authentication"
○ Pending: "Write tests for auth system"
○ Pending: "Update documentation"
```

**Purpose:** Provides persistent context about current task state.

---

### 10.3 Todo Tools

**Tools:**
- [TodoAddTool.ts](src/tools/TodoAddTool.ts) - Add todos with dependencies and subtasks
- [TodoUpdateTool.ts](src/tools/TodoUpdateTool.ts) - Update todo status
- [TodoRemoveTool.ts](src/tools/TodoRemoveTool.ts) - Remove todos
- [TodoClearTool.ts](src/tools/TodoClearTool.ts) - Clear all todos
- [TodoListTool.ts](src/tools/TodoListTool.ts) - List all todos

**Integration:** These tools modify the TodoManager state, which is then reflected in the system prompt on the next LLM call.

---

## 11. Complete File Reference

### 11.1 Core Prompting Files

| File | Purpose | Key Content |
|------|---------|-------------|
| [src/prompts/systemMessages.ts](src/prompts/systemMessages.ts) | Main system prompt generation | ALLY_IDENTITY, BEHAVIORAL_DIRECTIVES, AGENT_DELEGATION_GUIDELINES, GENERAL_GUIDELINES, getMainSystemPrompt(), getAgentSystemPrompt(), getContextInfo() |
| [src/agent/Agent.ts](src/agent/Agent.ts) | Agent orchestration and message management | System reminder injection (interruption, todos, tool context, required tools), prompt regeneration, message history management |
| [src/tools/ToolManager.ts](src/tools/ToolManager.ts) | Tool registry and definitions | getFunctionDefinitions(), getToolUsageGuidance(), tool execution |
| [src/tools/BaseTool.ts](src/tools/BaseTool.ts) | Tool base class | name, description, getFunctionDefinition(), usageGuidance interface |

---

### 11.2 Service Files

| File | Purpose | Key Content |
|------|---------|-------------|
| [src/services/TodoManager.ts](src/services/TodoManager.ts) | Todo list management | generateActiveContext(), todo CRUD operations |
| [src/agent/TokenManager.ts](src/agent/TokenManager.ts) | Token tracking | Token estimation, context usage percentage |
| [src/services/ToolResultManager.ts](src/services/ToolResultManager.ts) | Tool result tracking | estimateRemainingToolCalls() |
| [src/services/AgentManager.ts](src/services/AgentManager.ts) | Specialized agent registry | Load agents from ~/.ally/agents/, getAgentsForSystemPrompt() |
| [src/services/ProjectContextDetector.ts](src/services/ProjectContextDetector.ts) | Project context detection | Detect languages, frameworks, tools |

---

### 11.3 Tool Files (Examples)

| File | Purpose | Custom Guidance |
|------|---------|-----------------|
| [src/tools/PlanTool.ts](src/tools/PlanTool.ts) | Implementation planning | Hardcoded planning system prompt, structured output format |
| [src/tools/ExploreTool.ts](src/tools/ExploreTool.ts) | Codebase exploration | Hardcoded exploration system prompt, read-only emphasis |
| [src/tools/BatchTool.ts](src/tools/BatchTool.ts) | Parallel tool execution | Custom function definition with array of tool specs |
| [src/tools/AgentTool.ts](src/tools/AgentTool.ts) | Generic agent delegation | Loads custom agent prompts from ~/.ally/agents/ |

---

### 11.4 Configuration Files

| File | Purpose | Key Content |
|------|---------|-------------|
| [src/config/toolDefaults.ts](src/config/toolDefaults.ts) | Tool-specific constants | CONTEXT_THRESHOLDS, TOOL_LIMITS, FILE_EXCLUSIONS |
| [src/config/defaults.ts](src/config/defaults.ts) | Application defaults | DEFAULT_CONFIG, context_size, compact_threshold |
| [src/config/constants.ts](src/config/constants.ts) | Global constants | BUFFER_SIZES, TEXT_LIMITS, FORMATTING |

---

### 11.5 Entry Points

| File | Purpose | Key Content |
|------|---------|-------------|
| [src/cli.ts](src/cli.ts) | CLI entry point | getMainSystemPrompt() call, Agent instantiation, tool registration |
| [src/utils/ArgumentParser.ts](src/utils/ArgumentParser.ts) | Command parsing | /project commands, --once flag |

---

## Summary: Instruction Flow

### At Startup
1. **CLI** initializes and registers all tools
2. **ToolManager** collects function definitions and usage guidance
3. **Main system prompt** is generated with:
   - Core directives (identity, behavior, delegation, guidelines)
   - Context information (date, directory, git, OS, project)
   - ALLY.md content (if present)
   - Available agents list
   - Token usage info
   - Todo status
   - Tool usage guidance

### Before Each LLM Call
1. **System prompt is regenerated** with current context
2. **Temporary system reminders are injected:**
   - Interruption reminder (if interrupted)
   - Todo list reminder (if main agent)
   - Tool context reminder (if set by tool)
   - Required tool reminder (if needed)
3. **Function definitions are prepared** separately
4. **Messages are sent** to LLM with system prompt + reminders + function definitions

### After Each LLM Response
1. **Temporary system reminders are removed** from message history
2. **Todo status is updated** (if todos were modified)
3. **Tool calls are executed** (if any)
4. **Token usage is tracked** and warnings updated
5. **Context compaction** triggered if threshold exceeded

### Persistent vs. Temporary Instructions

**Persistent (in system prompt, regenerated each turn):**
- Core directives (identity, behavior, guidelines)
- Context information (date, directory, project info)
- ALLY.md content
- Available agents
- Token usage warnings
- Todo status
- Tool usage guidance

**Temporary (injected before call, removed after):**
- Interruption reminders
- Todo housekeeping reminders
- Tool context reminders
- Required tool reminders
- Continuation reminders after errors

This architecture ensures the model always has:
- **Fresh context** (token usage, todos, project state)
- **Relevant reminders** (only when needed, not cluttering history)
- **Clear instructions** (separated by purpose and permanence)
- **Tool definitions** (structured function calling)

---

## Document Version
- **Created:** 2025-10-31
- **Codebase:** CodeAlly-TS
- **Git Branch:** main
- **Last Commit:** 68ac4ad
