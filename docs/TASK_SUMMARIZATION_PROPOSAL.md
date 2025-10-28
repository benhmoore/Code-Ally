# Task Summarization System - Feasibility Analysis

## Current System Overview

### 1. Todo List Reminder System

**Location**: `src/agent/Agent.ts:268-305` and `src/agent/ToolOrchestrator.ts:467-533`

**How it works**:

1. **At start of turn** (`Agent.ts:sendMessage()`):
   ```typescript
   // Inject system reminder about todos (main agent only)
   if (!this.config.isSpecializedAgent) {
     if (todos.length === 0) {
       // Encourage creating todo list
       reminderContent += 'IMPORTANT: The todo list is currently empty.
         Create a todo list using todo_write for any task requiring
         multiple steps...';
     } else {
       // Show current todos
       reminderContent += 'Current todos:\n';
       todos.forEach((todo, idx) => {
         reminderContent += `${idx + 1}. [${status}] ${todo.task}\n`;
       });

       // Highlight in-progress task
       if (inProgressTodo) {
         reminderContent += `\nYou are currently working on:
           "${inProgressTodo.task}". Stay focused...`;
       }
     }
   }
   ```

2. **After each tool result** (`ToolOrchestrator.ts:generateFocusReminder()`):
   ```typescript
   // Only if there's an in_progress todo
   if (inProgressTodo) {
     reminder = `Stay focused. You're working on: ${inProgressTodo.task}.`;

     // Show tool call summary
     if (toolCalls.length > 0) {
       reminder += ` You've made ${toolCalls.length} tool calls...`;
       // List tools used: bash(...), read(...)
     }

     reminder += `\n\nStay on task. Use todo_write to mark complete...`;
   }
   ```

3. **Cleanup** (`Agent.ts:484-486`):
   ```typescript
   // Remove system-reminder messages after receiving response
   // These are temporary context hints that should not persist
   this.messages = this.messages.filter(msg =>
     !(msg.role === 'system' && msg.content.includes('<system-reminder>'))
   );
   ```

**Lifecycle**:
- Reminders inserted as system messages with `<system-reminder>` tags
- Sent to LLM in current turn
- Removed immediately after LLM responds
- Never persisted in conversation history

---

## Proposed System: Task Summarization

### Concept

Instead of relying on the todo system, have the model explicitly state their understanding:

1. **At turn start**: Model calls `summarize_task` tool:
   ```
   summarize_task({
     task: "Fix failing tests in CommandHandler and PathSecurity"
   })
   ```

2. **After each tool result**: Inject reminder:
   ```
   <system-reminder>
   Your overall task is: Fix failing tests in CommandHandler and PathSecurity.
   Stay on track.
   </system-reminder>
   ```

### Benefits

1. **Lower friction**: No need to create full todo list for simple tasks
2. **Better than nothing**: When model doesn't use todos, still get reminders
3. **Explicit commitment**: Model states their understanding upfront
4. **Simpler UX**: One sentence vs. multi-step todo list

### Comparison

| Aspect | Current (Todo) | Proposed (Summarization) |
|--------|---------------|-------------------------|
| **Setup cost** | Must create todo list with multiple items | One sentence summary |
| **Granularity** | Multiple tasks, statuses, progress tracking | Single high-level goal |
| **Reminder frequency** | After every tool (if in_progress) | After every tool (always) |
| **Reminder content** | Current task + tool history | Just the task |
| **Completion tracking** | Explicit marking complete | None |
| **Best for** | Multi-step workflows | Simple, focused tasks |

---

## Implementation Feasibility

### ✅ Very Feasible - Architecture Already Supports This

The existing system provides all the building blocks:

1. **Tool definition** - Add `SummarizeTaskTool` to tool registry
2. **Storage** - Store task summary in Agent instance: `this.taskSummary: string | null`
3. **Injection point** - Use existing `generateFocusReminder()` pattern
4. **Cleanup** - Use existing `<system-reminder>` cleanup mechanism

### Implementation Sketch

#### 1. New Tool: `SummarizeTaskTool`

```typescript
// src/tools/SummarizeTaskTool.ts
export class SummarizeTaskTool extends BaseTool {
  name = 'summarize_task';
  description = 'Summarize your current task in 1-2 sentences to maintain focus';

  parameters = {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Brief summary of what you are working on (1-2 sentences)',
      },
    },
    required: ['task'],
  };

  async execute(args: { task: string }): Promise<string> {
    // Store in Agent via service registry
    const registry = ServiceRegistry.getInstance();
    const taskTracker = registry.get<TaskTracker>('task_tracker');

    if (taskTracker) {
      taskTracker.setCurrentTask(args.task);
    }

    return `Task summary recorded: "${args.task}"`;
  }
}
```

#### 2. Task Tracker Service

```typescript
// src/services/TaskTracker.ts
export class TaskTracker {
  private currentTask: string | null = null;

  setCurrentTask(task: string): void {
    this.currentTask = task;
  }

  getCurrentTask(): string | null {
    return this.currentTask;
  }

  clearCurrentTask(): void {
    this.currentTask = null;
  }
}
```

#### 3. Modified Focus Reminder

```typescript
// src/agent/ToolOrchestrator.ts:generateFocusReminder()
private generateFocusReminder(): string | null {
  const registry = ServiceRegistry.getInstance();

  // Option 1: Check for in_progress todo (existing behavior)
  const todoManager = registry.get<TodoManager>('todo_manager');
  if (todoManager) {
    const todos = todoManager.getTodos();
    const inProgressTodo = todos.find(t => t.status === 'in_progress');

    if (inProgressTodo) {
      // Existing detailed reminder
      let reminder = `Stay focused. You're working on: ${inProgressTodo.task}.`;
      // ... tool call summary ...
      return reminder;
    }
  }

  // Option 2: Check for task summary (NEW - fallback when no todos)
  const taskTracker = registry.get<TaskTracker>('task_tracker');
  if (taskTracker) {
    const currentTask = taskTracker.getCurrentTask();

    if (currentTask) {
      // Simple reminder
      return `Your overall task is: ${currentTask}. Stay on track.`;
    }
  }

  // Option 3: No todo, no summary - no reminder
  return null;
}
```

#### 4. System Prompt Addition

```typescript
// src/prompts/systemMessages.ts
const taskManagementGuidance = `
# Task Management

For complex multi-step tasks, use the 'todo_write' tool to create a detailed todo list.

For simpler focused tasks, use 'summarize_task' at the start to state your goal:
- Keep it to 1-2 sentences
- Be specific about what you're accomplishing
- You'll receive periodic reminders to stay on track

Example:
- Task: "Implement error handling in the authentication module"
- Task: "Debug the memory leak in the WebSocket connection"
- Task: "Refactor the API client to use async/await"
`;
```

---

## Decision Points

### 1. When to Use Which System?

**Option A: Automatic Fallback** (Recommended)
- Model can use either `todo_write` OR `summarize_task`
- If todo exists: Use existing detailed reminders
- If no todo but summary exists: Use simple reminders
- If neither: Prompt to create one

**Option B: Explicit Choice**
- System prompt tells model to choose based on task complexity
- Complex → `todo_write`
- Simple → `summarize_task`

**Option C: Replace Entirely**
- Remove "empty todo" reminders
- Only use task summary for simple tasks
- Still support full todo system for complex tasks

### 2. Reminder Frequency

**Current**: Only when `in_progress` todo exists
**Proposed**:
- Option 1: Always (after every tool call)
- Option 2: Throttled (every N tools or M minutes)
- Option 3: Context-aware (when context usage > threshold)

### 3. Content Richness

**Minimal** (as proposed):
```
Your overall task is: [task]. Stay on track.
```

**Enhanced**:
```
Your overall task is: [task].
You've used [N] tools so far: [tool list].
Stay on track.
```

### 4. Lifecycle Management

When to clear task summary?
- After user sends new message (assume new task)
- After explicit completion (model says "done")
- When model creates a todo list (upgraded to todos)
- Never (persist across turns)

---

## Recommendation

### ✅ Implement as "Lightweight Task Tracking"

1. **Add** `SummarizeTaskTool` and `TaskTracker` service
2. **Modify** `generateFocusReminder()` to check for task summary as fallback
3. **Update** system prompt to mention both options
4. **Keep** existing todo system unchanged
5. **Use** simple reminder format: "Your overall task is: [task]. Stay on track."

### Why This Works

- **Zero breaking changes** - Enhances existing system
- **Low implementation cost** - ~200 lines of code
- **Clear value** - Better than no reminders when todos not used
- **Coexistence** - Todo system still available for complex tasks
- **Simple UX** - One tool call vs. multi-step todo creation

### Migration Path

**Phase 1**: Add feature (this proposal)
```
- Implement SummarizeTaskTool
- Add TaskTracker service
- Modify generateFocusReminder() fallback
```

**Phase 2**: Observe usage
```
- Track: How often is summarize_task used vs todo_write?
- Track: Does it reduce "no reminder" scenarios?
- Track: Do models stay on task better?
```

**Phase 3**: Refine
```
- Adjust reminder frequency based on data
- Consider auto-suggesting summarize_task if no todo after 3+ tools
- Experiment with reminder content richness
```

---

## Code Locations to Modify

### New Files
- `src/tools/SummarizeTaskTool.ts` (~60 lines)
- `src/services/TaskTracker.ts` (~40 lines)
- `src/services/__tests__/TaskTracker.test.ts` (~80 lines)

### Modified Files
1. `src/agent/ToolOrchestrator.ts:483-533`
   - Modify `generateFocusReminder()` to check TaskTracker

2. `src/agent/Agent.ts:268-305`
   - Consider suggesting `summarize_task` when todo list empty

3. `src/prompts/systemMessages.ts`
   - Add guidance about when to use each approach

4. `src/tools/ToolManager.ts`
   - Register SummarizeTaskTool

5. `src/services/ServiceRegistry.ts` (initialization)
   - Register TaskTracker singleton

### Test Coverage
- Unit tests for SummarizeTaskTool
- Unit tests for TaskTracker
- Integration test: Agent + TaskTracker + reminders
- Behavior test: Does reminder appear after tool calls?

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Model confusion about which to use | Medium | Low | Clear system prompt guidance |
| Overhead of extra tool call | Low | Low | Optional - model can skip |
| Summary becomes stale | Medium | Medium | Clear on new user message |
| Reminder fatigue | Low | Low | Same as current system |
| Doesn't improve task adherence | Medium | Low | Easy to disable if ineffective |

**Overall Risk**: **Low** - Conservative enhancement to existing system

---

## Timeline Estimate

- Implementation: 4-6 hours
- Testing: 2-3 hours
- Documentation: 1 hour
- **Total**: ~1 day of work

---

## Conclusion

**Verdict: ✅ Highly Feasible and Low Risk**

This proposal is:
1. **Architecturally sound** - Fits naturally into existing patterns
2. **Low cost** - Minimal code, no breaking changes
3. **Clear value** - Addresses gap when todos aren't used
4. **Easy to test** - Observable behavior change
5. **Reversible** - Can disable without impact

The existing `<system-reminder>` infrastructure makes this almost trivial to implement. The main design decision is determining the right reminder frequency and when to auto-suggest using the tool.

**Next Step**: Implement Phase 1 and gather usage data to inform Phase 2 refinements.
