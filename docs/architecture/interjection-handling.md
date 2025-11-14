# Interjection Handling Architecture

User interjection handling enables users to submit new messages mid-response, allowing them to redirect, clarify, or provide additional input while the agent is actively processing. The system intelligently routes these interjections to the appropriate agent context.

## Overview

**What are interjections?**

Interjections occur when a user submits a message while the agent is actively generating a response or executing tool calls. Unlike cancellations (Ctrl+C), interjections are handled gracefully:

- The current operation is interrupted but not discarded
- The user's message is routed to the appropriate agent context
- Execution continues with the new user input incorporated

**Key characteristics:**
- Non-destructive: Work-in-progress is preserved
- Context-aware: Routes to the correct agent (main or subagent)
- Seamless: User experience is fluid and natural

## Architecture Components

### Core Components

```
InputPrompt (UI)
    ↓
useInputHandlers.handleInterjection()
    ↓
ToolManager.getActiveInjectableTool()
    ↓ (if active tool exists)
    ├─ Tool.injectUserMessage()
    │   ↓
    │   Agent.addUserInterjection()
    │   Agent.interrupt('interjection')
    │
    └─ (if no active tool)
        Main Agent.addUserInterjection()
        Main Agent.interrupt('interjection')
```

### Component Responsibilities

**InputPrompt** (`src/ui/components/InputPrompt.tsx`)
- Captures user input during active responses
- Triggers `onInterjection` callback instead of `onSubmit`
- Maintains input buffer state across renders

**useInputHandlers** (`src/ui/hooks/useInputHandlers.ts`)
- Central input routing logic
- Queries ToolManager for active injectable tools
- Routes interjections to appropriate destination
- Emits UI events for interjection tracking

**ToolManager** (`src/tools/ToolManager.ts`)
- Tracks active tools that support interjection
- Provides `getActiveInjectableTool()` to find injection target
- Manages tool registry and capabilities

**Injectable Tools** (`AgentTool`, `ExploreTool`, `PlanTool`)
- Implement `injectUserMessage()` method
- Track `currentPooledAgent` state
- Forward messages to active subagent

**Agent** (`src/agent/Agent.ts`)
- Manages conversation history
- Handles interruption state via InterruptionManager
- Processes interjected messages in next turn

**InterruptionManager** (`src/agent/InterruptionManager.ts`)
- Tracks interruption type: `'cancel'` vs `'interjection'`
- Manages interruption state and context
- Distinguishes between hard stops and graceful redirects

## Routing Logic

### Injectable vs Non-Injectable Tools

The system distinguishes between tools that should receive interjections and those that shouldn't:

**Injectable tools** (interjections route to subagent):
- `agent` - Long-running delegated tasks
- `explore` - Codebase exploration sessions
- `plan` - Implementation planning sessions

**Non-injectable tools** (interjections route to main agent):
- `agent-ask` - Quick queries to existing agents
- All other tools (bash, read, write, etc.)

### Why agent-ask is Non-Injectable

`agent-ask` is intentionally excluded from interjection routing because:

1. **Query semantics**: It's designed for quick, one-off questions to persistent agents
2. **Main conversation continues**: The main agent is driving the conversation
3. **Context clarity**: User interjections are directed at the main agent, not the queried subagent
4. **User mental model**: Users expect to interact with the main agent during queries

Example:
```
Main Agent: "Let me ask the exploration agent about that..."
[agent-ask is executing]
User: "Actually, never mind, do something else"
→ Routes to main agent (not the exploration agent being queried)
```

### Routing Decision Tree

```
User submits message mid-response
    ↓
Is there an active injectable tool?
    ├─ YES: Tool has active pooled agent?
    │   ├─ YES: Route to subagent
    │   │   - Call tool.injectUserMessage(message)
    │   │   - Subagent.addUserInterjection(message)
    │   │   - Subagent.interrupt('interjection')
    │   │   - parentId = tool call ID
    │   │
    │   └─ NO: Route to main agent
    │       - MainAgent.addUserInterjection(message)
    │       - MainAgent.interrupt('interjection')
    │       - parentId = 'root'
    │
    └─ NO: Route to main agent
        - MainAgent.addUserInterjection(message)
        - MainAgent.interrupt('interjection')
        - parentId = 'root'
```

## Flow Diagrams

### Normal Interjection Flow (No Active Tool)

```
1. User: "Analyze this code"
2. Main Agent: Processing...
3. User: [Submits interjection] "Focus on performance"
4. InputPrompt.onInterjection() called
5. useInputHandlers.handleInterjection()
6. ToolManager.getActiveInjectableTool() → undefined
7. MainAgent.addUserInterjection("Focus on performance")
8. MainAgent.interrupt('interjection')
9. InterruptionManager sets type='interjection'
10. Main Agent continues with new context
```

### Interjection to Active Subagent

```
1. User: "Explore the authentication system"
2. Main Agent: [Calls explore tool]
3. ExploreTool creates subagent
4. ExploreTool.currentPooledAgent = subagent
5. Subagent: [Actively exploring...]
6. User: [Submits interjection] "Check OAuth implementation"
7. InputPrompt.onInterjection() called
8. useInputHandlers.handleInterjection()
9. ToolManager.getActiveInjectableTool() → {
     tool: ExploreTool,
     name: 'explore',
     callId: 'explore-123-abc'
   }
10. ExploreTool.injectUserMessage("Check OAuth implementation")
11. Subagent.addUserInterjection("Check OAuth implementation")
12. Subagent.interrupt('interjection')
13. InterruptionManager sets type='interjection'
14. Subagent continues with new directive
15. ExploreTool returns to main agent
```

### Interjection During agent-ask (Non-Injectable)

```
1. User: "Ask the explore agent about error handling"
2. Main Agent: [Calls agent-ask]
3. AgentAskTool queries persistent explore agent
4. Explore agent: [Processing query...]
5. User: [Submits interjection] "Never mind, do X instead"
6. InputPrompt.onInterjection() called
7. useInputHandlers.handleInterjection()
8. ToolManager.getActiveInjectableTool() → undefined
   (agent-ask is NOT in injectable list)
9. MainAgent.addUserInterjection("Never mind, do X instead")
10. MainAgent.interrupt('interjection')
11. Main agent handles the redirection
```

## Integration Points

### UI Layer Integration

**InputPrompt Component:**
```typescript
<InputPrompt
  onSubmit={handleInput}           // Regular messages
  onInterjection={handleInterjection}  // Mid-response messages
  isActive={!isThinking}           // Enable during responses
/>
```

**Message Metadata:**
```typescript
{
  role: 'user',
  content: 'Focus on performance',
  metadata: {
    isInterjection: true,        // Mark as interjection
    parentId: 'explore-123-abc'  // Link to tool call or 'root'
  }
}
```

### Event System Integration

**USER_INTERJECTION Event:**
```typescript
activityStream.emit({
  id: 'interjection-1234567890',
  type: ActivityEventType.USER_INTERJECTION,
  timestamp: Date.now(),
  parentId: 'explore-123-abc',  // Tool call ID or 'root'
  data: {
    message: 'Focus on performance',
    targetAgent: 'explore'       // 'main' or tool name
  }
});
```

**Event Subscription (ToolCallDisplay):**
```typescript
// Capture interjections for nesting under tool calls
activityStream.subscribe(
  ActivityEventType.USER_INTERJECTION,
  (event) => {
    if (event.parentId === toolCallId) {
      // Display interjection under this tool call
    }
  }
);
```

### Session Persistence

**Saving Interjections:**
```json
{
  "messages": [
    {
      "role": "user",
      "content": "Focus on performance",
      "timestamp": 1699999999999,
      "metadata": {
        "isInterjection": true,
        "parentId": "explore-123-abc"
      }
    }
  ]
}
```

**Reconstructing on Load:**
```typescript
// Re-emit USER_INTERJECTION events for UI reconstruction
reconstructInterjectionsFromMessages(messages, activityStream);
```

## Design Decisions

### Why Separate 'interjection' from 'cancel'?

**Problem:** Need to distinguish between "stop everything" (Ctrl+C) and "change direction" (interjection).

**Solution:** InterruptionManager tracks interruption type:
- `'cancel'`: Abort ongoing operations, discard progress
- `'interjection'`: Graceful interruption, incorporate new input

**Benefits:**
- Tools can handle each type appropriately
- Main agent knows whether to discard or incorporate context
- Clear semantics for different user intents

### Why Route to Subagent vs Main Agent?

**Problem:** When user submits interjection during `agent()` tool execution, should it go to main agent or subagent?

**Design choice:** Route to active subagent when possible.

**Rationale:**
1. **Context preservation**: Subagent has full context of the delegated task
2. **User mental model**: User is focused on the active investigation/task
3. **Efficiency**: Subagent can incorporate feedback immediately
4. **Conversation coherence**: Maintains thread of thought

**Example:**
```
User: "Explore authentication system"
Agent Tool: [Creating exploration agent...]
Exploration Agent: "I found 5 authentication modules..."
User: "Focus on OAuth specifically"
→ Routes to exploration agent (has context)
→ Exploration agent adjusts its investigation
```

### Why ToolManager Tracks Active Tools?

**Problem:** Multiple tools might be executing concurrently. Which one should receive interjections?

**Design choice:** ToolManager tracks a single "active injectable tool" based on precedence.

**Precedence order:**
1. `explore` - Active exploration
2. `plan` - Active planning
3. `agent` - Active delegation

**Rationale:**
- Only one can be truly "active" from user's perspective
- User interjections are directed at the most visible operation
- Clear, deterministic routing eliminates ambiguity

**Implementation:**
```typescript
getActiveInjectableTool(): { tool, name, callId } | undefined {
  for (const toolName of ['explore', 'plan', 'agent']) {
    const tool = this.tools.get(toolName);
    if (tool?.currentPooledAgent) {
      return { tool, name: toolName, callId: tool.currentCallId };
    }
  }
  return undefined;
}
```

### Why Use parentId for Nesting?

**Problem:** UI needs to display interjections in context (under tool calls).

**Design choice:** Store parentId in message metadata:
- `'root'`: Top-level interjection (display in main conversation)
- Tool call ID: Nested interjection (display under that tool call)

**Benefits:**
1. **Visual hierarchy**: UI can nest interjections under tool calls
2. **Conversation flow**: Clear which messages belong to which context
3. **Session reconstruction**: Preserve structure across save/load cycles

## Implementation Examples

### Scenario 1: Basic Interjection (No Active Tool)

**User flow:**
```
User: "What's in this codebase?"
Agent: "Let me analyze the structure..."
[Agent is processing]
User: [Presses Enter] "Focus on the API layer"
```

**Code execution:**
```typescript
// 1. InputPrompt captures interjection
onInterjection("Focus on the API layer")

// 2. useInputHandlers routes to main agent
handleInterjection(async (message) => {
  const activeTool = toolManager.getActiveInjectableTool();
  // activeTool is undefined (no injectable tool active)

  agent.addUserInterjection(message);
  agent.interrupt('interjection');

  // Add to UI with parentId: 'root'
  actions.addMessage({
    role: 'user',
    content: message,
    metadata: { isInterjection: true, parentId: 'root' }
  });
});

// 3. Agent processes interjection
InterruptionManager.getInterruptionType() // Returns 'interjection'
// Agent incorporates new message in next turn
```

### Scenario 2: Interjection to Explore Agent

**User flow:**
```
User: "Explore the authentication system"
Agent: [Calls explore tool]
Explore Agent: "Analyzing auth modules..."
User: [Presses Enter] "Check for security vulnerabilities"
```

**Code execution:**
```typescript
// 1. ExploreTool has active subagent
ExploreTool.currentPooledAgent = {
  agentId: 'explore-agent-123',
  agent: exploreAgent,
  // ...
}
ExploreTool.currentCallId = 'explore-123-abc'

// 2. ToolManager finds active tool
const activeTool = toolManager.getActiveInjectableTool();
// Returns: {
//   tool: ExploreTool,
//   name: 'explore',
//   callId: 'explore-123-abc'
// }

// 3. Route to explore agent
ExploreTool.injectUserMessage("Check for security vulnerabilities");
// Internally:
exploreAgent.addUserInterjection(message);
exploreAgent.interrupt('interjection');

// 4. Add to UI with parentId = tool call ID
actions.addMessage({
  role: 'user',
  content: message,
  metadata: {
    isInterjection: true,
    parentId: 'explore-123-abc'  // Nests under explore tool call
  }
});
```

### Scenario 3: Interjection During agent-ask (Routes to Main)

**User flow:**
```
User: "Ask the explore agent about error handling patterns"
Agent: [Calls agent-ask]
Agent Ask: Querying explore agent...
User: [Presses Enter] "Actually, let's move on to testing"
```

**Code execution:**
```typescript
// 1. AgentAskTool is executing but NOT injectable
AgentAskTool.currentPooledAgent = queriedAgent  // Set during execution

// 2. ToolManager checks for injectable tools
const activeTool = toolManager.getActiveInjectableTool();
// Returns: undefined
// (agent-ask is not in ['explore', 'plan', 'agent'])

// 3. Routes to main agent
agent.addUserInterjection("Actually, let's move on to testing");
agent.interrupt('interjection');

// 4. Add to UI with parentId: 'root'
actions.addMessage({
  role: 'user',
  content: message,
  metadata: { isInterjection: true, parentId: 'root' }
});

// 5. Main agent handles the redirection
// (agent-ask call may complete or be cancelled)
```

## Testing Considerations

### Test Coverage Areas

1. **Routing logic:**
   - Interjection with no active tool → main agent
   - Interjection with active explore tool → explore agent
   - Interjection with active agent tool → agent tool
   - Multiple concurrent tools (precedence)

2. **Tool type distinction:**
   - Injectable tools (explore, plan, agent) receive interjections
   - Non-injectable tools (agent-ask, etc.) don't receive interjections

3. **State management:**
   - currentPooledAgent lifecycle
   - InterruptionManager state transitions
   - Message metadata preservation

4. **Session persistence:**
   - Save interjection messages with metadata
   - Reconstruct USER_INTERJECTION events on load
   - Preserve parentId relationships

5. **Edge cases:**
   - Interjection after tool completes
   - Multiple rapid interjections
   - Interjection during compaction
   - Tool cleanup after interjection

### Test Examples

```typescript
describe('Interjection routing', () => {
  it('routes to main agent when no active tool', async () => {
    const message = 'Focus on performance';
    await handleInterjection(message);

    expect(agent.addUserInterjection).toHaveBeenCalledWith(message);
    expect(agent.interrupt).toHaveBeenCalledWith('interjection');
  });

  it('routes to explore agent when active', async () => {
    const exploreTool = toolManager.getTool('explore');
    exploreTool.currentPooledAgent = mockPooledAgent;
    exploreTool.currentCallId = 'explore-123';

    const message = 'Check OAuth implementation';
    await handleInterjection(message);

    expect(mockPooledAgent.agent.addUserInterjection)
      .toHaveBeenCalledWith(message);
    expect(mockPooledAgent.agent.interrupt)
      .toHaveBeenCalledWith('interjection');
  });

  it('routes to main agent during agent-ask', async () => {
    const agentAskTool = toolManager.getTool('agent-ask');
    agentAskTool.currentPooledAgent = mockQueriedAgent;

    const message = 'Never mind';
    await handleInterjection(message);

    // Should NOT route to queried agent
    expect(mockQueriedAgent.agent.addUserInterjection)
      .not.toHaveBeenCalled();

    // Should route to main agent
    expect(agent.addUserInterjection).toHaveBeenCalledWith(message);
  });
});
```

## Future Enhancements

### Potential Improvements

1. **Multi-agent interjection:**
   - Support broadcasting interjections to multiple active agents
   - Allow user to select target agent explicitly

2. **Interjection queueing:**
   - Queue multiple interjections during processing
   - Batch-deliver when agent reaches checkpoint

3. **Visual feedback:**
   - Show which agent will receive interjection
   - Highlight active agent context in UI

4. **Interjection history:**
   - Track interjection patterns for UX insights
   - Suggest when to use interjections vs cancellation

5. **Scoped interjections:**
   - Allow interjections scoped to specific tool calls
   - Support hierarchical routing for nested agents

## Related Documentation

- [Architecture Overview](./overview.md) - Overall system architecture
- [Agent System](../src/agent/README.md) - Agent implementation details
- [Tool System](../src/tools/README.md) - Tool implementation and lifecycle
- [Event System](../src/services/ActivityStream.ts) - Event-driven communication

## Source Code References

- Interjection handling: `src/ui/hooks/useInputHandlers.ts`
- Routing logic: `src/tools/ToolManager.ts:getActiveInjectableTool()`
- Injectable tools:
  - `src/tools/AgentTool.ts:injectUserMessage()`
  - `src/tools/ExploreTool.ts:injectUserMessage()`
  - `src/tools/PlanTool.ts:injectUserMessage()`
- Interruption management: `src/agent/InterruptionManager.ts`
- Agent interjection: `src/agent/Agent.ts:addUserInterjection()`
- UI integration: `src/ui/components/InputPrompt.tsx`
- Session reconstruction: `src/ui/hooks/useSessionResume.ts`
