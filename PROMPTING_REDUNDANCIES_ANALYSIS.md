# Prompting System Redundancies & Context Pollution Analysis

## Executive Summary

This analysis identifies redundancies and unnecessary context pollution in the Ally prompting system. Issues range from **Critical** (significant token waste) to **Minor** (optimization opportunities).

**Total Estimated Waste per LLM Call:** ~800-1200 tokens (~10-15% of typical system prompt)

---

## Critical Issues

### 1. **Triple Todo Instruction Redundancy**

**Severity:** 🔴 Critical
**Token Waste:** ~400 tokens per turn
**Locations:**
- [systemMessages.ts:35](src/prompts/systemMessages.ts:35) - BEHAVIORAL_DIRECTIVES (static)
- [Agent.ts:347](src/agent/Agent.ts:347) - Empty todo reminder (dynamic)
- [systemMessages.ts:277](src/prompts/systemMessages.ts:277) - Todo context in system prompt (dynamic)

**Problem:**

The model receives todo guidance in **three separate locations**:

1. **Static Instructions (BEHAVIORAL_DIRECTIVES):**
   ```
   **Task management (optional)**: For complex multi-step tasks, consider using todos to
   track progress and prevent drift. Todos help you stay focused by providing reminders
   after each tool use. Tool selection: Use todo_add to append new tasks (keeps existing
   work), todo_update to change status (e.g., mark completed), todo_remove to delete tasks,
   and todo_clear to start fresh. Optional: Specify dependencies (array of todo IDs) to
   enforce order, and subtasks (nested array, max depth 1) for hierarchical breakdown.
   Blocked todos (with unmet dependencies) cannot be in_progress. For simple single-step
   operations, todos are optional.
   ```

2. **Temporary System Reminder (injected every turn when empty):**
   ```xml
   <system-reminder>
   Note: The todo list is currently empty. For complex multi-step tasks, consider using
   todo_add to track progress and stay focused. Todos provide reminders after each tool
   use and help prevent drift. For simple single-step operations, todos are optional.
   </system-reminder>
   ```

3. **Todo Context (injected into system prompt every turn):**
   ```
   📋 Active Todos (3/5 completed):
   → Currently working on: "Implement user authentication"
   ```

**Analysis:**

- Items #1 and #2 contain **nearly identical text** about todo usage
- The empty reminder (#2) is redundant if static instructions (#1) already exist
- The "stay focused" message appears in **both** static directives and todo reminder

**Recommendation:**

**Option A (Aggressive):**
- Remove todo usage instructions from BEHAVIORAL_DIRECTIVES entirely
- Keep only the dynamic system reminder (when todos exist or are empty)
- Reduces static prompt size, makes todo guidance contextual

**Option B (Moderate):**
- Keep minimal static instruction: "Use todos to track multi-step tasks (todo_add, todo_update, todo_remove)"
- Remove detailed explanation from static directives
- Let system reminder provide detailed guidance only when relevant

**Expected Savings:** 300-400 tokens per turn

---

### 2. **Duplicate "Stay Focused" Instructions**

**Severity:** 🔴 Critical
**Token Waste:** ~100 tokens per turn
**Locations:**
- [systemMessages.ts:36](src/prompts/systemMessages.ts:36) - BEHAVIORAL_DIRECTIVES
- [Agent.ts:357](src/agent/Agent.ts:357) - Todo reminder when in-progress task exists

**Problem:**

Both locations tell the model to "stay focused on current task":

1. **Static (BEHAVIORAL_DIRECTIVES):**
   ```
   **Stay focused on your current task**: Don't get distracted by tangential findings
   in tool results. If you discover something interesting but unrelated (e.g., failing
   tests while investigating code structure), note it but continue with your current
   task unless it's blocking your work. Only deviate from your plan if absolutely
   necessary.
   ```

2. **Dynamic (Todo Reminder):**
   ```
   You are currently working on: "Implement user authentication". Stay focused on
   completing this task - don't get distracted by tangential findings in tool results
   unless they directly block your progress.
   ```

**Analysis:**

- Nearly identical phrasing
- Dynamic version is more contextual (mentions specific task)
- Static version is redundant when dynamic version exists

**Recommendation:**

Remove the static "stay focused" bullet point. The dynamic todo reminder already provides this guidance **when it matters** (when there's an in-progress task).

**Expected Savings:** 80-100 tokens per turn

---

### 3. **Batch Operation Duplication**

**Severity:** 🟡 Medium
**Token Waste:** ~150 tokens per turn
**Locations:**
- [systemMessages.ts:39](src/prompts/systemMessages.ts:39) - BEHAVIORAL_DIRECTIVES
- [systemMessages.ts:76-79](src/prompts/systemMessages.ts:76-79) - AGENT_DELEGATION_GUIDELINES
- [BatchTool.ts:17](src/tools/BatchTool.ts:17) - Tool description
- Function definition for `batch` tool

**Problem:**

Batch execution is explained in **four places**:

1. **BEHAVIORAL_DIRECTIVES:** "Use batch() to run them concurrently"
2. **AGENT_DELEGATION_GUIDELINES:** Full "Parallel Execution with batch()" section
3. **BatchTool description:** "Execute multiple tools concurrently..."
4. **Function definition:** Includes description and parameter schema

**Analysis:**

- Behavioral directives and delegation guidelines both mention batch()
- Tool description and function definition already explain usage
- Delegation guidelines section duplicates what function definition provides

**Recommendation:**

- **Remove batch() from BEHAVIORAL_DIRECTIVES** (just mention "use multiple tools per response")
- **Keep detailed guidance in AGENT_DELEGATION_GUIDELINES** for strategic usage
- Let function definition handle technical details

**Expected Savings:** 50-80 tokens per turn

---

## Medium Issues

### 4. **Tool Usage Guidance vs. Function Definitions**

**Severity:** 🟡 Medium
**Token Waste:** ~200 tokens per turn
**Locations:**
- Tool `usageGuidance` strings (TreeTool, ExploreTool, PlanTool)
- Function definitions (`description` field)

**Problem:**

Some tools provide **both** a description and extended usage guidance:

**TreeTool Example:**
- **Description:** "Display directory tree structure for one or more paths. Automatically filters out build artifacts..."
- **Usage Guidance:** "**When to use tree:** Getting an overview of project structure..." (adds examples)

**Analysis:**

- Usage guidance is helpful but verbose
- Many examples are self-explanatory from description
- Only 3 tools currently provide usage guidance (tree, explore, plan)

**Recommendation:**

**Keep usage guidance for:**
- Complex tools with non-obvious use cases (explore, plan, agent)
- Tools that replace common patterns (explore vs grep/read sequences)

**Remove usage guidance for:**
- Simple tools where description is sufficient (tree, ls, read)
- Tools with obvious use cases

**Expected Savings:** 100-150 tokens per turn

---

### 5. **Redundant Context Regeneration**

**Severity:** 🟡 Medium
**Token Waste:** ~200 tokens per turn
**Location:** [Agent.ts:569-592](src/agent/Agent.ts:569-592)

**Problem:**

The system prompt is fully regenerated **before every LLM call**, including static information that rarely changes:

**Static (rarely changes):**
- Operating System: `darwin 25.0.0`
- Node Version: `v18.17.0`
- Working Directory: `/Users/benmoore/CodeAlly-TS`
- Git Branch: `main`
- Project Type: `Node.js • TypeScript • Express`
- ALLY.md content

**Dynamic (changes frequently):**
- Current Date/Time
- Context Usage percentage
- Todo list status
- Available agents (if changed)

**Analysis:**

- OS, Node version, working directory, git branch, project detection rarely change during a session
- Full regeneration wastes computation and includes unchanged content
- Only date, context usage, and todos truly need regeneration

**Recommendation:**

Implement **partial regeneration**:
1. Generate static context once at agent initialization
2. Only regenerate dynamic portions (date, context usage, todos) each turn
3. Rebuild full prompt from cached static + fresh dynamic parts

**Expected Savings:** 150-200 tokens per turn + reduced computation

---

### 6. **Agent List Redundancy in Main Prompt**

**Severity:** 🟡 Medium
**Token Waste:** ~100-200 tokens per turn (scales with agent count)
**Location:** [systemMessages.ts:200-218](src/prompts/systemMessages.ts:200-218)

**Problem:**

Available agents list is included in system prompt:
```
- Available Agents:
  - general: General-purpose agent for complex tasks
  - security-reviewer: Security analysis and vulnerability detection
  - test-writer: Automated test generation
  [... potentially many more ...]
```

**Analysis:**

- Agent list can grow large as users add custom agents
- Information is already available via `agent` tool function definition
- Most turns don't involve agent delegation
- Listing all agents "just in case" is wasteful

**Recommendation:**

**Option A (Aggressive):**
- Remove agent list from system prompt entirely
- Let the model discover agents via function definition or by calling `agent` tool

**Option B (Moderate):**
- Only show agent list when context suggests delegation is relevant
- Use heuristics: complex tasks, "review" keywords, etc.

**Option C (Lazy Loading):**
- Provide a `list_agents` tool instead of including in prompt
- Model can call it when needed

**Expected Savings:** 100-300 tokens per turn (depending on agent count)

---

## Minor Issues

### 7. **Date/Time Updates Every Turn**

**Severity:** 🟢 Minor
**Token Waste:** ~30 tokens per turn
**Location:** [systemMessages.ts:175](src/prompts/systemMessages.ts:175)

**Problem:**

Current date/time is regenerated to **millisecond precision** every turn:
```
- Current Date: 2025-10-31 14:32:15.742
```

**Analysis:**

- Millisecond precision is unnecessary for most tasks
- Date likely doesn't change during short sessions
- Time precision beyond minutes is rarely relevant

**Recommendation:**

- Use **date only** or **hour precision** by default
- Only include precise timestamp when time-sensitive operations occur
- Could update only every N minutes instead of every turn

**Expected Savings:** Minimal tokens, but reduces noise

---

### 8. **Emoji in System Reminders**

**Severity:** 🟢 Minor
**Token Waste:** ~10 tokens per turn
**Location:** Various system reminders

**Problem:**

System reminders include emoji (⚠️, 🚨, 💡, 📋, ✓, →, ○) which:
- Consume extra tokens
- May not render consistently across models
- Are purely decorative

**Example:**
```
📋 Active Todos (3/5 completed):
→ Currently working on: "Task name"
○ Pending: "Other task"
✓ Completed: "Done task"
```

**Analysis:**

- Emoji adds visual distinction but no semantic value
- System prompt already specifies "No emoji in responses"
- Slight token overhead

**Recommendation:**

Replace emoji with ASCII:
- `📋` → `Todos:`
- `→` → `[IN_PROGRESS]`
- `○` → `[PENDING]`
- `✓` → `[COMPLETED]`

**Expected Savings:** 5-10 tokens per turn

---

### 9. **Verbose "Housekeeping" Instructions**

**Severity:** 🟢 Minor
**Token Waste:** ~60 tokens per turn
**Location:** [Agent.ts:360-365](src/agent/Agent.ts:360-365)

**Problem:**

Todo reminder includes verbose housekeeping instructions every turn:
```
Housekeeping: Keep the todo list clean and focused.
• Remove completed tasks that are no longer relevant to the conversation
• Remove pending tasks that are no longer needed
• Update task descriptions if they've changed
• Remember: when working on todos, keep exactly ONE task in_progress

Update the list now if needed based on the user's request.
```

**Analysis:**

- This is included **every turn** whether or not todo cleanup is needed
- Most turns don't require housekeeping
- Could be shown less frequently or only when list gets messy

**Recommendation:**

**Option A:**
- Show housekeeping reminder only every N turns or when todo count > threshold

**Option B:**
- Condense to single line: "Keep todo list clean: remove irrelevant tasks, maintain one in_progress task"

**Expected Savings:** 40-50 tokens per turn

---

### 10. **Project Context Over-Detection**

**Severity:** 🟢 Minor
**Token Waste:** ~50 tokens per turn
**Location:** [systemMessages.ts:229-253](src/prompts/systemMessages.ts:229-253)

**Problem:**

Project context detection runs and includes results every turn:
```
- Project: Node.js • TypeScript • Express • npm • Docker • GitHub Actions
```

**Analysis:**

- Project context rarely changes during a session
- Detection runs every turn (calling detector.getCached(), but still includes in prompt)
- Information is mostly static after first detection

**Recommendation:**

- Detect once at startup, cache result
- Only re-detect if project files change (package.json, etc.)
- Don't regenerate this line if project context unchanged

**Expected Savings:** Minimal tokens, reduces computation

---

## Detailed Redundancy Map

| Instruction Topic | Location 1 | Location 2 | Location 3 | Recommendation |
|-------------------|------------|------------|------------|----------------|
| **Todo usage** | BEHAVIORAL_DIRECTIVES (static) | Empty reminder (dynamic) | - | Remove from one location |
| **Stay focused** | BEHAVIORAL_DIRECTIVES (static) | Todo reminder (dynamic) | - | Remove static, keep dynamic |
| **Batch operations** | BEHAVIORAL_DIRECTIVES | DELEGATION_GUIDELINES | Function def | Consolidate |
| **Tool examples** | Usage guidance | Function description | - | Limit to complex tools |
| **Context info** | Regenerated every turn | - | - | Cache static portions |
| **Agent list** | System prompt | Function definition | - | Remove from prompt |

---

## Optimization Priority

### High Priority (Implement First)

1. **Remove duplicate todo instructions** → 300-400 token savings
2. **Remove static "stay focused"** → 80-100 token savings
3. **Cache static context portions** → 150-200 token savings
4. **Simplify batch() mentions** → 50-80 token savings

**Total High Priority Savings:** ~580-780 tokens per turn

### Medium Priority

5. **Optimize tool usage guidance** → 100-150 token savings
6. **Remove/lazy-load agent list** → 100-300 token savings

**Total Medium Priority Savings:** ~200-450 tokens per turn

### Low Priority

7. **Reduce date/time precision** → Minimal savings
8. **Replace emoji with ASCII** → 5-10 token savings
9. **Condense housekeeping** → 40-50 token savings
10. **Cache project context** → Minimal savings

**Total Low Priority Savings:** ~50-100 tokens per turn

---

## Implementation Recommendations

### Phase 1: Low-Hanging Fruit (1-2 hours)

1. **Remove static "stay focused" instruction**
   - File: [src/prompts/systemMessages.ts:36](src/prompts/systemMessages.ts:36)
   - Action: Delete the bullet point, keep dynamic version only

2. **Simplify todo instructions in BEHAVIORAL_DIRECTIVES**
   - File: [src/prompts/systemMessages.ts:35](src/prompts/systemMessages.ts:35)
   - Action: Reduce to 1 sentence: "Use todos to track multi-step tasks (see todo_add tool)"

3. **Remove batch() from BEHAVIORAL_DIRECTIVES**
   - File: [src/prompts/systemMessages.ts:39](src/prompts/systemMessages.ts:39)
   - Action: Change to "Use multiple tools per response for efficiency"

4. **Replace emoji in system reminders**
   - Files: [src/agent/Agent.ts:351](src/agent/Agent.ts:351), [src/services/TodoManager.ts](src/services/TodoManager.ts)
   - Action: Replace with ASCII equivalents

**Expected Phase 1 Savings:** ~400-500 tokens per turn

---

### Phase 2: Structural Changes (4-6 hours)

5. **Implement partial context regeneration**
   - File: [src/prompts/systemMessages.ts](src/prompts/systemMessages.ts)
   - Action: Split getContextInfo() into getStaticContext() and getDynamicContext()
   - Cache static portion at agent initialization
   - Only regenerate dynamic portions each turn

6. **Remove agent list from system prompt**
   - File: [src/prompts/systemMessages.ts:200-218](src/prompts/systemMessages.ts:200-218)
   - Action: Remove agentsInfo from context
   - Rely on function definition for agent discovery

7. **Trim tool usage guidance**
   - Files: [src/tools/TreeTool.ts](src/tools/TreeTool.ts), others
   - Action: Remove usageGuidance from simple tools
   - Keep only for explore, plan, agent

**Expected Phase 2 Savings:** ~300-500 tokens per turn

---

### Phase 3: Advanced Optimizations (8+ hours)

8. **Smart housekeeping reminder**
   - File: [src/agent/Agent.ts:360-365](src/agent/Agent.ts:360-365)
   - Action: Only show every 5 turns or when todo count > 5

9. **Lazy date/time updates**
   - File: [src/prompts/systemMessages.ts:175](src/prompts/systemMessages.ts:175)
   - Action: Only update timestamp when > 5 minutes elapsed

10. **Smart project context caching**
    - File: [src/prompts/systemMessages.ts:229-253](src/prompts/systemMessages.ts:229-253)
    - Action: Cache and only re-detect on file changes

**Expected Phase 3 Savings:** ~50-100 tokens per turn

---

## Total Potential Savings

**Per Turn:**
- Phase 1: ~400-500 tokens (50-63% of total waste)
- Phase 2: ~300-500 tokens (38-63% of total waste)
- Phase 3: ~50-100 tokens (6-13% of total waste)

**Total: 750-1100 tokens per turn (~10-15% of typical system prompt)**

**Over 100 Turns:**
- **75,000-110,000 tokens saved**
- At $3/M input tokens: **$0.23-$0.33 saved per session**
- More importantly: **Reduced cognitive load on model**, clearer instructions

---

## Risk Assessment

### Low Risk Changes
- Remove duplicate static instructions (todo, stay focused)
- Replace emoji with ASCII
- Simplify batch() mentions
- Trim tool usage guidance

### Medium Risk Changes
- Cache static context portions (requires testing to ensure cache invalidation works)
- Remove agent list (may reduce agent discoverability)
- Conditional housekeeping reminder (may lead to messy todos if threshold too high)

### High Risk Changes
- Aggressive prompt refactoring (could alter model behavior)
- Remove todo instructions entirely from static prompt (may reduce todo adoption)

**Recommendation:** Start with **Phase 1** (low risk, high reward), measure impact, then proceed to Phase 2.

---

## Measurement Strategy

Before implementing changes:

1. **Baseline Metrics:**
   - Average system prompt token count per turn
   - Average total context usage per 10-turn session
   - Model performance on standard test cases

2. **A/B Testing:**
   - Run same tasks with old vs new prompts
   - Compare: token usage, task completion rate, response quality

3. **Regression Testing:**
   - Ensure model still uses todos appropriately
   - Verify agent delegation still works
   - Check batch() usage patterns

4. **Success Criteria:**
   - 10%+ reduction in system prompt tokens
   - No degradation in task completion quality
   - Maintained or improved response conciseness

---

## Conclusion

The Ally prompting system has significant redundancy, primarily from:
1. **Triple todo instruction coverage** (static + 2 dynamic sources)
2. **Duplicate "stay focused" guidance**
3. **Full context regeneration every turn** (including static info)
4. **Over-verbose system reminders**

Implementing the **Phase 1 optimizations alone** could save **400-500 tokens per turn** with minimal risk and effort.

The redundancies aren't critical bugs, but represent:
- Wasted tokens (~10-15% of prompt per turn)
- Potential model confusion from contradictory or repetitive instructions
- Unnecessary computation regenerating static context

Recommended approach: **Implement Phase 1 immediately**, measure impact, then proceed with Phase 2 based on results.
