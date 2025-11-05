# CodeAlly Prompting Patterns and Agent Architecture

## Executive Summary

CodeAlly uses a sophisticated system of specialized agents and tools with carefully designed prompting patterns to guide LLM behavior. The system includes:

1. **Core Agents**: Main agent, Explore agents, Plan agents, General-purpose agents
2. **System Prompts**: Dynamically generated with behavioral directives and tool usage guidance
3. **Tool-Specific Guidance**: Each tool includes `usageGuidance` strings injected into the system prompt
4. **Agent Delegation Pattern**: Strategic routing of tasks to specialized agents based on request type
5. **Prompting Philosophy**: Emphasis on direct execution, conciseness, and avoiding loops

---

## 1. Agent and Subagent Architecture

### Available Agents

#### 1.1 Main Agent (Ally)
- **Identity**: "You are Ally, an AI pair programming assistant"
- **Capabilities**: All tools available, can delegate to specialized agents
- **System Prompt**: `CORE_DIRECTIVES` + context information
- **File**: `/Users/bhm128/code-ally/src/prompts/systemMessages.ts`

#### 1.2 Explore Agent
- **Type**: Read-only specialized agent
- **Tools Available**: `read`, `glob`, `grep`, `ls`, `tree`, `batch`
- **Purpose**: Codebase exploration and architecture understanding
- **System Prompt**: `EXPLORATION_BASE_PROMPT` + `EXPLORATION_SYSTEM_PROMPT`
- **File**: `/Users/bhm128/code-ally/src/tools/ExploreTool.ts`
- **Key Directive**: "You have READ-ONLY access - you cannot modify files"

#### 1.3 Plan Agent
- **Type**: Planning-focused specialized agent
- **Tools Available**: `read`, `glob`, `grep`, `ls`, `tree`, `batch`, `explore`, `todo_add`
- **Purpose**: Create detailed implementation plans grounded in codebase patterns
- **System Prompt**: `PLANNING_BASE_PROMPT` + `PLANNING_SYSTEM_PROMPT`
- **File**: `/Users/bhm128/code-ally/src/tools/PlanTool.ts`
- **Key Directive**: "Ground recommendations in existing patterns, provide file references"

#### 1.4 General-Purpose Agent
- **Type**: Fully-equipped agent for complex tasks
- **Tools Available**: All tools (full access)
- **Purpose**: Multi-step complex analysis and implementation
- **System Prompt**: Custom agent prompt from `~/.code_ally/agents/general.md`
- **File**: `/Users/bhm128/code-ally/src/services/AgentManager.ts`
- **Default Prompt**: Stored at `/Users/bhm128/code-ally/src/services/AgentManager.ts:185`

#### 1.5 Custom Named Agents
- **Mechanism**: Load from `~/.code_ally/agents/{name}.md`
- **Format**: Markdown files with YAML front matter
- **Configuration**: Name, description, system_prompt, model (optional), temperature (optional), tools (optional)
- **File**: `/Users/bhm128/code-ally/src/services/AgentManager.ts`

### Agent Metadata Storage
- **Location**: `~/.code_ally/agents/` directory
- **Format**: Markdown files with YAML headers
- **Properties**:
  ```typescript
  {
    name: string;
    description: string;
    system_prompt: string;
    model?: string;
    temperature?: number;
    tools?: string[];  // Tool names agent can use. Empty/undefined = all tools
    created_at?: string;
    updated_at?: string;
  }
  ```

### Agent Pooling Service
- **Service**: `AgentPoolService`
- **File**: `/Users/bhm128/code-ally/src/services/AgentPoolService.ts`
- **Purpose**: Manages pool of reusable agent instances
- **Configuration**:
  - Max pool size: 10 agents
  - Idle timeout: 5 minutes
  - Cleanup interval: 1 minute
  - LRU eviction policy

---

## 2. System Prompts and Behavioral Directives

### 2.1 Core Directive Structure

**File**: `/Users/bhm128/code-ally/src/prompts/systemMessages.ts`

The system prompt is composed of several layers:

```
CORE_DIRECTIVES
├── ALLY_IDENTITY
├── BEHAVIORAL_DIRECTIVES
├── AGENT_DELEGATION_GUIDELINES
├── GENERAL_GUIDELINES
└── Context Information (injected dynamically)
    ├── Current Date/Time
    ├── Working Directory
    ├── Operating System
    ├── Project Context
    ├── Context Usage Warnings
    ├── Active Todos
    └── Tool Usage Guidance (from tools)
```

### 2.2 Identity Directive

```typescript
const ALLY_IDENTITY = `You are Ally, an AI pair programming assistant. 
Use tools directly to complete tasks efficiently. Apply creative problem 
solving and leverage tool combinations to find elegant solutions.`;
```

### 2.3 Behavioral Directives

**Key Points**:
1. **Post-Tool Response Required**: "After executing tools, you MUST provide a text response. NEVER end with only tool calls."
2. **Direct Execution**: "Use tools yourself, never ask users to run commands"
3. **Conciseness**: "1-3 sentences unless detail requested. No emoji."
4. **Task Management**: Use todos for multi-step tasks with dependencies
5. **Error Handling**: "Analyze failures and retry with adjustments"
6. **Avoid Loops**: "If repeating steps, reassess your approach"
7. **Efficiency**: "Use multiple tools per response when independent"
8. **System Reminders**: "Tool results may include a `system_reminder` key. Read and respect this content"
9. **Trust Delegation**: "Trust specialized agent results"

### 2.4 Agent Delegation Guidelines

**File**: `/Users/bhm128/code-ally/src/prompts/systemMessages.ts:47-84`

Tool selection guidance:
```markdown
- `plan`: Multi-step features/fixes needing structured approach 
          (creates todos with dependencies/subtasks)
- `explore`: Read-only codebase investigation for understanding 
            architecture and structure
- `agent`: Complex tasks requiring specialized expertise or multiple steps
- Manual tools: Simple single-file operations and targeted searches
```

**When to use explore**:
- Understanding codebase structure and architecture
- Finding implementations when location unknown
- Tracing feature implementations across files
- Analyzing dependencies and relationships

**When NOT to use explore** (use direct tools instead):
- Reading a specific file path → use `read` tool
- Searching for a specific class → use `glob` tool
- Searching within 2-3 files → use `read` tool
- Needle-in-haystack queries → use `glob` or `grep` tools

**When to use plan**:
- New features
- Complex fixes
- Significant changes
- Skip for: quick fixes, simple adjustments, continuing existing plans

### 2.5 General Guidelines

- Check existing patterns/libraries before creating new code
- Follow surrounding context for framework choices
- For structural corruption: Read entire file, Write clean version
- For normal changes: Use incremental editing (edit, line_edit)
- Always use regular reads by default to keep content in context
- Avoid brackets in file references outside link context
- Never commit without explicit request

---

## 3. Tool Definitions and Usage Guidance

### 3.1 Tool Registration and Function Definitions

**File**: `/Users/bhm128/code-ally/src/tools/ToolManager.ts`

**Tools Initialized** (from `/Users/bhm128/code-ally/src/cli.ts:469-496`):

#### Read-Only Tools
- `read` - Read file contents
- `glob` - Find files by pattern
- `grep` - Search file contents with regex
- `ls` - List directory contents
- `tree` - Display directory tree structure
- `batch` - Execute multiple tools in parallel

#### Write/Modification Tools
- `write` - Write files
- `edit` - Edit files
- `line_edit` - Edit specific lines
- `ally_write` - Alternative write tool
- `bash` - Execute shell commands
- `lint` - Lint code
- `format` - Format code

#### Agent/Task Tools
- `agent` - Delegate to specialized agent
- `explore` - Read-only codebase exploration
- `plan` - Create implementation plan
- `agent_ask` - Continue conversation with persistent agent

#### Todo Management
- `todo_add` - Add todo item
- `todo_remove` - Remove todo item
- `todo_update` - Update todo item
- `todo_clear` - Clear all todos
- `todo_list` - List todos

#### Session Management
- `list_sessions` - List previous sessions
- `session_lookup` - Find session by description
- `session_read` - Read previous session
- `ask_session` - Ask question about session

#### Other
- `deny_proposal` - Deny a proposed todo plan

### 3.2 Tool Usage Guidance Strings

Each tool can define `usageGuidance` which is automatically injected into the system prompt.

**Examples**:

#### ReadTool
```typescript
readonly usageGuidance = `**When to use read:**
Regular reads (default) keep file content in context for future reference - 
prefer this for most use cases. ONLY use ephemeral=true when file exceeds 
normal token limit AND you need one-time inspection.
WARNING: Ephemeral content is automatically removed after one turn`;
```

#### GrepTool
```typescript
readonly usageGuidance = `**When to use grep:**
Locate patterns across files or inspect matching lines with regex.
Set output_mode="files_with_matches" for file lists (default), 
"content" for snippets with context, "count" for per-file totals.`;
```

#### TreeTool
```typescript
readonly usageGuidance = `**When to use tree:**
Project structure overview, directory hierarchy, exploring multiple branches.
Prefer over multiple ls calls.`;
```

#### ExploreTool
```typescript
readonly usageGuidance = `**When to use explore:**
Understand structure, find implementations, trace features, analyze dependencies.
Delegates to read-only agent. Prefer over manual grep/read sequences.`;
```

#### PlanTool
```typescript
readonly usageGuidance = `**When to use plan:**
Multi-step features, complex changes, structure and patterns.
Returns implementation plan with proposed todos.`;
```

#### AgentAskTool
```typescript
readonly usageGuidance = `**When to use agent_ask:**
Follow-up questions to persistent agents, iterative exploration, 
refining plans. Requires agent_id from previous explore(persist=true) 
or plan(persist=true) call.`;
```

### 3.3 Tool Function Definitions

Tools provide function definitions via `getFunctionDefinition()` method, implementing:
```typescript
interface FunctionDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}
```

---

## 4. Prompting Patterns and Decision Logic

### 4.1 Tool Selection Logic Flow

**Entry Point**: Main Agent receives user message
↓
**Decision Tree**:

```
1. Is it a read-only exploration task?
   → Use `explore` tool for codebase investigation
   
2. Is it a planning/architecture task?
   → Use `plan` tool for structured approach with todos
   
3. Is it a complex multi-step task?
   → Use `agent` tool with specialized agent name
   
4. Is it a simple single-file operation?
   → Use direct tools: read, glob, grep, ls
   
5. Is it continuing a previous agent conversation?
   → Use `agent_ask` with agent_id
   
6. Is it a write/modification task?
   → Use write, edit, line_edit, bash (with permission check)
   
7. Is it multi-task work needing structure?
   → Use plan tool to create todos, then execute
   
8. Is it independent parallel operations?
   → Use batch tool to run multiple tools concurrently
```

### 4.2 Context Usage Awareness

**File**: `/Users/bhm128/code-ally/src/prompts/systemMessages.ts:120-209`

System prompt includes dynamic context usage information:
- **70% usage**: Normal threshold info
- **75% usage**: Moderate reminder about context budget
- **90% usage**: Strong warning to wrap up

### 4.3 Tool Execution Mode Determination

**File**: `/Users/bhm128/code-ally/src/agent/ToolOrchestrator.ts:46-58`

Safe tools that run concurrently:
```typescript
const SAFE_CONCURRENT_TOOLS = new Set([
  'read', 'file_read', 'grep', 'glob', 'ls', 'bash_readonly',
  'git_status', 'git_log', 'git_diff', 'web_fetch', 'agent'
]);
```

**Execution Decision**:
- If all tools are safe → Run concurrently
- If any destructive tool → Run sequentially

### 4.4 Permission Screening

**File**: `/Users/bhm128/code-ally/src/security/PermissionManager.ts`

Tools requiring confirmation (before execution):
- `write`, `edit`, `line_edit` - File modifications
- `bash` - Shell command execution
- Sensitive operations flagged by `requiresConfirmation` property

**Permission Levels**:
- NORMAL: Read operations, no prompt
- SENSITIVE: Single file operations, prompt with "Always Allow"
- EXTREMELY_SENSITIVE: Dangerous operations, always prompt without "Always Allow"

---

## 5. System Prompt Generation Flow

### 5.1 Main System Prompt Generation

**Function**: `getMainSystemPrompt(tokenManager?, toolResultManager?, isOnceMode?)`
**File**: `/Users/bhm128/code-ally/src/prompts/systemMessages.ts:312-379`

```
CORE_DIRECTIVES
↓
Once-Mode Instructions (if applicable)
↓
Tool Usage Guidance (from all tools)
↓
Context Budget Reminder (if 75%+ usage)
↓
Context Information (date, env, project, git branch, etc.)
↓
Todo Context (active todos from TodoManager)
```

### 5.2 Specialized Agent System Prompt

**Function**: `getAgentSystemPrompt(agentSystemPrompt, taskPrompt, tokenManager?, toolResultManager?)`
**File**: `/Users/bhm128/code-ally/src/prompts/systemMessages.ts:384-418`

```
Primary Identity (from agent definition)
↓
BEHAVIORAL_DIRECTIVES
↓
GENERAL_GUIDELINES
↓
Current Task Prompt
↓
Context Information
↓
Context Budget Reminder
↓
Final Response Requirement (must provide comprehensive summary)
```

### 5.3 Agent-Specific Prompts

#### Exploration Agent Prompt
**Base**: `EXPLORATION_BASE_PROMPT` (lines 31-46)
**Full**: `EXPLORATION_SYSTEM_PROMPT` (lines 49-58)

Key directives:
- "You have READ-ONLY access - you cannot modify files"
- "Be thorough but efficient with tool usage (aim for 5-10 tool calls)"
- "Always provide clear, structured summaries of findings"

#### Planning Agent Prompt
**Base**: `PLANNING_BASE_PROMPT` (lines 32-91)
**Full**: `PLANNING_SYSTEM_PROMPT` (lines 101-114)

Key directives:
- "Be efficient in research (use 5-15 tool calls depending on complexity)"
- "Ground recommendations in existing patterns"
- "For empty/new projects: recommend modern best practices"
- "Don't waste time searching for patterns that don't exist"

---

## 6. Context Information Injection

**Function**: `getContextInfo(options)`
**File**: `/Users/bhm128/code-ally/src/prompts/systemMessages.ts:214-307`

**Information Provided**:
```
- Current Date: ISO datetime
- Working Directory: Full path
- Operating System: Platform and version
- Node Version: Runtime version
- Project Context: Type, languages, frameworks, tools
- Git Branch: If applicable
- Context Usage: Percentage with remaining tool calls estimate
- Project Instructions: Content from ALLY.md if present
- Available Agents: List of custom agents from ~/.code_ally/agents/
```

---

## 7. Key Prompting Principles

Based on analysis of system messages and directives:

### 7.1 Direct Tool Usage
- Tools should be invoked directly by the LLM
- Never ask user to run commands
- Use tool combinations for efficiency
- Leverage batch tool for parallel operations

### 7.2 Post-Tool Communication Required
- Every tool execution must be followed by text response
- Never end response with only tool calls
- Summarize what was learned or accomplished
- Explain failures and next steps

### 7.3 Conciseness Over Verbosity
- 1-3 sentences default unless detail requested
- No emoji in responses
- Be direct and actionable
- Avoid over-explanation

### 7.4 Error Recovery
- Analyze failures before retrying
- Adjust approach based on error messages
- Don't repeat same approach if it fails
- Consider alternative tools/strategies

### 7.5 Loop Avoidance
- Monitor for repeating patterns
- Reassess approach if doing same thing
- Use different tools or strategies
- Escalate to planning if stuck

### 7.6 Task Structuring
- Use todos for multi-step work
- Create todos with dependencies
- Use subtasks for hierarchical breakdown
- Update progress as work completes

### 7.7 Agent Delegation
- Delegate to explore for codebase investigation
- Delegate to plan for architecture/design work
- Delegate to agent for complex specialized tasks
- Trust specialized agent results

### 7.8 Tool Selection Specificity
- Don't use generic tools when specialized ones exist
- Use explore instead of manual grep sequences
- Use plan instead of ad-hoc implementation planning
- Use tree instead of multiple ls calls

---

## 8. Configuration and Customization Points

### 8.1 Agent Configuration
- **Custom Agents**: Add markdown files to `~/.code_ally/agents/`
- **Tool Access Control**: Specify `tools` array in agent metadata
- **Model/Temperature**: Override default per agent
- **Prompt**: Custom system prompt in markdown file

### 8.2 Tool Configuration
- **Tool Limits**: Configure in `/Users/bhm128/code-ally/src/config/toolDefaults.ts`
- **Timeouts**: Configure in `/Users/bhm128/code-ally/src/config/constants.ts`
- **Exclusions**: File exclusion patterns in `toolDefaults.ts`

### 8.3 Agent Pool Configuration
**File**: `/Users/bhm128/code-ally/src/config/constants.ts`
```typescript
export const AGENT_POOL = {
  DEFAULT_MAX_SIZE: 10,
  DEFAULT_IDLE_TIMEOUT_MS: 5 * 60 * 1000,
  DEFAULT_CLEANUP_INTERVAL_MS: 60 * 1000,
};
```

### 8.4 Context Thresholds
**File**: `/Users/bhm128/code-ally/src/config/toolDefaults.ts`
- Normal: 70%
- Moderate reminder: 75%
- Strong reminder: 90%
- Critical: 95%

---

## 9. Current Prompting Examples

### Example 1: Exploration Request
**User**: "How does the error handling system work?"
**System Decision**: Use `explore` tool
**Agent Prompt** (ExploreTool):
```
You are a specialized code exploration assistant...
- View directory tree structures (tree)
- Search for files and patterns (glob, grep)
- Read and analyze file contents (read)
You have READ-ONLY access...
Be thorough but efficient (5-10 tool calls)
```

### Example 2: Feature Implementation
**User**: "Add OAuth authentication to the API"
**System Decision**: Use `plan` tool
**Agent Prompt** (PlanTool):
```
You are an expert implementation planner...
1. Understand Requirements
2. Assess Codebase State (use tree, glob, grep)
3. Research Patterns (use explore if complex)
4. Analyze Architecture
5. Create Plan with specific file references
6. Create Proposed Todos using todo_add()
```

### Example 3: Complex Task
**User**: "Refactor the authentication module for better security"
**System Decision**: Use `agent` with custom agent or `plan` then `agent`
**Flow**:
1. Use `plan` to create structured approach
2. Use `agent` with implementation agent to execute plan
3. Use `agent_ask` for follow-up questions

---

## 10. Files and Code Locations

### Core System Prompt Files
| File | Purpose |
|------|---------|
| `/Users/bhm128/code-ally/src/prompts/systemMessages.ts` | All system messages and prompt generation functions |

### Agent Definition Files
| File | Purpose |
|------|---------|
| `/Users/bhm128/code-ally/src/agent/Agent.ts` | Main Agent class, orchestrates conversation |
| `/Users/bhm128/code-ally/src/services/AgentManager.ts` | Load/save agent definitions from disk |
| `/Users/bhm128/code-ally/src/services/AgentPoolService.ts` | Pool management for reusable agents |

### Tool Definition Files
| File | Purpose |
|------|---------|
| `/Users/bhm128/code-ally/src/tools/BaseTool.ts` | Abstract base class for all tools |
| `/Users/bhm128/code-ally/src/tools/ToolManager.ts` | Tool registration and execution |
| `/Users/bhm128/code-ally/src/tools/ExploreTool.ts` | Read-only exploration agent |
| `/Users/bhm128/code-ally/src/tools/PlanTool.ts` | Planning agent with todo creation |
| `/Users/bhm128/code-ally/src/tools/AgentTool.ts` | Generic agent delegation tool |
| `/Users/bhm128/code-ally/src/tools/AgentAskTool.ts` | Continue conversation with persistent agents |
| `/Users/bhm128/code-ally/src/tools/ReadTool.ts` | Read files |
| `/Users/bhm128/code-ally/src/tools/GrepTool.ts` | Search files with regex |
| `/Users/bhm128/code-ally/src/tools/GlobTool.ts` | Find files by pattern |
| `/Users/bhm128/code-ally/src/tools/TreeTool.ts` | Display directory structure |

### Tool Execution Files
| File | Purpose |
|------|---------|
| `/Users/bhm128/code-ally/src/agent/ToolOrchestrator.ts` | Coordinate tool execution (concurrent/sequential) |
| `/Users/bhm128/code-ally/src/cli.ts` | CLI entry point, tool initialization |

### Configuration Files
| File | Purpose |
|------|---------|
| `/Users/bhm128/code-ally/src/config/constants.ts` | Application-wide constants |
| `/Users/bhm128/code-ally/src/config/toolDefaults.ts` | Tool-specific limits and thresholds |

---

## 11. Key Takeaways for Improvement

1. **Tool Usage Guidance is Powerful**: Each tool's `usageGuidance` string is automatically injected into system prompt, creating contextual guidance without explicit instruction

2. **Behavioral Directives Over Prescriptive Instructions**: Rather than detailed step-by-step prompts, the system emphasizes principles (e.g., "avoid loops", "use multiple tools per response")

3. **Agent Specialization is Strategic**: Different agents have different system prompts and tool access levels:
   - Explore: Read-only, deeply investigative
   - Plan: Research + planning focused, can create todos
   - General: Full capability, complex multi-step work

4. **Context-Aware Prompting**: System prompt dynamically includes:
   - Current todo context
   - Context usage warnings
   - Tool-specific guidance
   - Project information

5. **Tool Selection Guidance Prevents Misuse**: Clear directives about when to use `explore` vs direct `grep/read`, when to use `plan` vs immediate implementation

6. **Conciseness Principle**: "1-3 sentences unless detail requested, no emoji" - prevents verbose LLM outputs

7. **Trust Delegation Principle**: "Trust specialized agent results" - allows agents to be more decisive without second-guessing

8. **Post-Tool Response Required**: Forces summarization and prevents tool-only responses, ensuring transparency

9. **System Reminders Mechanism**: Tool results can include `system_reminder` key to inject dynamic guidance mid-conversation

10. **Error Recovery as Principle**: Rather than specific error handling code, the prompt emphasizes "analyze failures and retry with adjustments"

