# CodeAlly Tool Routing Guide

## Quick Decision Tree

```
User Request
    ↓
Is it asking about code structure/how something works?
├─ YES → Use EXPLORE (read-only codebase investigation)
│         Returns: Comprehensive findings with architecture analysis
│         Tools: read, glob, grep, ls, tree, batch (READ-ONLY)
│
└─ NO → Continue...
    ↓
Is it asking to implement a new feature or major change?
├─ YES → Use PLAN (structured approach with todos)
│         Returns: Implementation plan with proposed todos
│         Tools: read, glob, grep, ls, tree, batch, explore, todo_add
│
└─ NO → Continue...
    ↓
Is it a complex task needing specialized expertise?
├─ YES → Use AGENT (delegate to specialized agent)
│         Returns: Task completion with agent results
│         Tools: All available (configurable per agent)
│
└─ NO → Continue...
    ↓
Is it a follow-up to a previous explore/plan call?
├─ YES → Use AGENT_ASK (continue with same agent instance)
│         Returns: Additional insights from persistent agent
│         Tools: Same as original agent
│
└─ NO → Use DIRECT TOOLS (read, grep, glob, write, edit, bash, etc.)
         Returns: Direct tool result
         Tools: Specific tool selected
```

## Tool Categories

### Read-Only Tools (Safe for Parallel Execution)
```
read      - Read file contents (keep in context)
glob      - Find files by pattern
grep      - Search with regex (supports context lines)
ls        - List directory contents
tree      - Show directory structure with depth control
batch     - Run multiple tools in parallel
```

**When to use these directly:**
- Reading a specific file: `read(["/path/to/file.ts"])`
- Finding specific class: `glob(pattern="**/*ClassName*.ts")`
- Searching within 2-3 files: `read([file1, file2, file3])`
- Needle-in-haystack queries: `grep(pattern="pattern", path="/search/path")`

### Write/Modify Tools (Sequential Execution)
```
write         - Write new files
edit          - Edit full file content
line_edit     - Edit specific line ranges
bash          - Execute shell commands
lint          - Check code quality
format        - Format code
```

**When to use:**
- Modifying files: Use `edit` for normal changes, `write` for full rewrites
- Running commands: Use `bash` with explicit command
- Code quality: Use `lint` before `format`

### Specialized Agent Tools
```
explore       - Codebase investigation (read-only agent)
plan          - Implementation planning (planning agent)
agent         - Generic task delegation (any agent)
agent_ask     - Follow-up questions (persistent agent)
```

**Characteristics:**
- Each creates/manages an Agent instance
- Agent handles its own tool execution
- Returns summarized result
- Can persist agent for reuse (`persist=true`)
- Agent lifecycle is managed automatically (auto-cleanup on idle)

### Todo Management Tools
```
todo_add      - Add todo item (with dependencies/subtasks)
todo_update   - Update todo item
todo_remove   - Remove todo item
todo_list     - List all todos
todo_clear    - Clear all todos
deny_proposal - Reject proposed todo plan
```

**Usage:**
- After `plan`: Use `todo_add()` to create implementation tasks
- Structure work: Use dependencies array for task ordering
- Track progress: Update todo status as work completes

## When to Use Each Pattern

### Pattern 1: Direct Tool Usage
```
Task: "Read the authentication file"
→ read(file_paths=["/src/auth.ts"])

Task: "Find all error handlers"
→ grep(pattern="catch|error.*handler", path="/src", type="ts")

Task: "Show project structure"
→ tree(paths=["."], depth=3)
```

### Pattern 2: Explore Pattern
```
Task: "How does the error handling system work?"
→ explore(task_description="Explain error handling architecture and flow")

Task: "Find all database operations"
→ explore(task_description="Locate and analyze database query patterns")

Result: Comprehensive analysis with multiple files reviewed
```

### Pattern 3: Plan Pattern
```
Task: "Add user authentication"
→ plan(requirements="Implement user authentication with JWT")

Task: "Refactor database layer"
→ plan(requirements="Refactor database access layer for better testability")

Result: Implementation steps + proposed todos with dependencies
```

### Pattern 4: Agent Pattern
```
Task: "Implement OAuth integration"
→ agent(task_prompt="Add OAuth 2.0 authentication to API", 
        agent_name="implementor")

Task: "Code review the authentication module"
→ agent(task_prompt="Review authentication implementation for security issues",
        agent_name="security-reviewer")

Result: Task-specific execution with specialized focus
```

### Pattern 5: Iterative Pattern
```
Step 1: explore(task_description="Understand auth flow", persist=true)
        Returns: agent_id="pool-xxx-yyy"

Step 2: agent_ask(agent_id="pool-xxx-yyy", 
                   message="How should we handle token refresh?")
        Returns: Follow-up insights

Step 3: agent_ask(agent_id="pool-xxx-yyy",
                   message="What about role-based access control?")
        Returns: More detailed analysis
```

### Pattern 6: Parallel Execution Pattern
```
Task: Read multiple related files at once
→ read(file_paths=["/src/user.ts", "/src/auth.ts", "/src/session.ts"])

Task: Execute multiple independent searches
→ batch(tools=[
    {name: "grep", arguments: {pattern: "error.*handler"}},
    {name: "grep", arguments: {pattern: "validate.*input"}},
    {name: "glob", arguments: {pattern: "**/*.test.ts"}}
])

Task: Delegate to multiple agents concurrently
→ agent(task_prompt="...", agent_name="agent1")
→ agent(task_prompt="...", agent_name="agent2")
→ agent(task_prompt="...", agent_name="agent3")
(All three execute in parallel in the response)
```

## Tool Usage Guidance Summary

### Read Tool
- Keep file content in context for reference
- Use `ephemeral=true` ONLY for large files exceeding normal limit
- Prefer regular reads (ephemeral content lost after one turn)

### Grep Tool
- Use `output_mode="files_with_matches"` for file lists (default)
- Use `output_mode="content"` for code snippets with context
- Use `output_mode="count"` for per-file match totals
- Supports `-A`, `-B`, `-C` for context lines

### Tree Tool
- Better than multiple `ls` calls for structure overview
- Use `depth` parameter to limit output (default: 3)
- Automatically ignores common build/dependency directories

### Explore Tool
- Better than manual `grep/read` sequences for complex exploration
- Returns comprehensive findings with multiple files analyzed
- Can use `thoroughness` parameter: quick, medium, very thorough, uncapped

### Plan Tool
- Creates structured approach with file references
- Returns proposed todos with dependencies
- Grounds recommendations in existing patterns

### Agent Tool
- For specialized expertise or multi-step complex tasks
- Can specify `agent_name` for role-specific agents
- Use `thoroughness` to control time budget

### Agent Ask Tool
- Requires `agent_id` from previous persist=true call
- Continues conversation with same agent context
- Use for iterative exploration and refinement

## Context Budget Management

### Normal Context Usage (< 70%)
- No special considerations needed
- Use tools freely
- Prefer regular reads over ephemeral

### Moderate Usage (70-75%)
- Be slightly more efficient with tool calls
- Combine related operations
- Consider using batch tool for parallel execution

### High Usage (75-90%)
- Wrap up current task
- Avoid starting new major operations
- Use more efficient tools (batch, tree vs multiple ls)
- Consider summarizing findings

### Critical Usage (90%+)
- Stop tool calls
- Provide final summary
- Conclude current task
- Avoid starting new work

## Common Anti-Patterns to Avoid

### Anti-Pattern 1: Overusing explore
```
WRONG: Use explore for finding a specific file
explore(task_description="Find the login form file")
→ INEFFICIENT

RIGHT: Use glob directly
glob(pattern="**/login*.tsx")
→ DIRECT & FAST
```

### Anti-Pattern 2: Manual exploration sequences
```
WRONG: Multiple tool calls for exploration
grep(...) → read(...) → grep(...) → read(...) ...
→ TEDIOUS & LONG

RIGHT: Use explore once
explore(task_description="Analyze login flow across all files")
→ COMPREHENSIVE
```

### Anti-Pattern 3: Planning without using plan tool
```
WRONG: Ask for manual plan in chat
"Tell me how to implement feature X"
→ UNSTRUCTURED

RIGHT: Use plan tool
plan(requirements="Implement feature X")
→ STRUCTURED WITH TODOS
```

### Anti-Pattern 4: Sequential reads when batch available
```
WRONG: Read files one at a time
read([file1]) → read([file2]) → read([file3])
→ INEFFICIENT

RIGHT: Read in parallel
read([file1, file2, file3])
→ ONE CALL, ALL FILES
```

### Anti-Pattern 5: Asking user to run commands
```
WRONG: "You need to run `npm install`"
→ VIOLATES DIRECT EXECUTION PRINCIPLE

RIGHT: Use bash tool directly
bash(command="npm install")
→ DIRECT EXECUTION
```

## Tool Selection Checklist

- [ ] Is it read-only exploration? → explore
- [ ] Is it planning/design? → plan
- [ ] Is it a complex specialized task? → agent
- [ ] Is it follow-up to previous agent? → agent_ask
- [ ] Is it simple file read? → read
- [ ] Is it file search? → glob or grep
- [ ] Is it structure overview? → tree
- [ ] Is it directory listing? → ls
- [ ] Are multiple independent operations? → batch
- [ ] Is it file modification? → write, edit, line_edit
- [ ] Is it shell execution? → bash
- [ ] Is it code quality? → lint, format
- [ ] Is it multi-step work? → plan then todo_add

