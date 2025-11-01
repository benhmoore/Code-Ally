# Mid-Response User Prompts Implementation Plan

**Author**: Analysis conducted on 2025-10-31
**Feature**: Allow users to inject prompts mid-response to interrupt and redirect both main agent and subagents

---

## Executive Summary

This document provides a comprehensive implementation plan for enabling mid-response user prompts that can interrupt agent execution (both main and subagents) while preserving partial responses and injecting new user context. The feature enables users to type messages while the agent is working, which are then processed as new input without discarding the in-progress response.

### Key Requirements

1. User can type a prompt while agent is generating a response
2. Current response is interrupted but preserved in conversation history
3. New user prompt is submitted and processed by the active agent (main or subagent)
4. For subagents: message goes to subagent context, not main conversation
5. UI shows interjected prompts nested under the relevant tool call
6. Tool execution doesn't end - subagent continues with new context

---

## 1. Current System Analysis

### 1.1 Interrupt Mechanism (Ctrl+C/Escape)

**Location**: `/src/ui/components/InputPrompt.tsx` (lines 916-960)

**Current Flow**:
```typescript
// Escape key handling (line 916)
if (key.escape) {
  // 1. Dismiss completions (if showing)
  if (showCompletions) { /* ... */ }
  
  // 2. Interrupt agent if processing
  if (agent && agent.isProcessing()) {
    // Emit visual feedback
    activityStream.emit({
      type: ActivityEventType.USER_INTERRUPT_INITIATED,
      // ...
    });
    
    // Interrupt main agent
    agent.interrupt();
    
    // Interrupt all subagents
    activityStream.emit({
      type: ActivityEventType.INTERRUPT_ALL,
      // ...
    });
    return;
  }
  
  // 3. Double-escape opens rewind
  // ...
}
```

**Agent.interrupt() Implementation**: `/src/agent/Agent.ts` (lines 441-467)
```typescript
interrupt(): void {
  if (this.requestInProgress) {
    this.interrupted = true;
    
    // Cancel LLM request
    this.cancel();
    
    // Abort tool executions
    if (this.toolAbortController) {
      this.toolAbortController.abort();
    }
    
    // Stop watchdog
    this.stopActivityWatchdog();
    
    // Emit event
    this.emitEvent({
      type: ActivityEventType.AGENT_END,
      data: { interrupted: true }
    });
  }
}
```

**Key Observations**:
- Interrupt is **destructive** - cancels LLM stream, aborts tools
- Sets `interrupted` flag which throws error in `processLLMResponse()`
- Returns `"[Request interrupted by user]"` as response
- Conversation state preserved BUT partial response is lost

### 1.2 Input Handling Flow

**Location**: `/src/ui/App.tsx` (lines 1444-1550)

```typescript
const handleInput = async (input: string) => {
  const trimmed = input.trim();
  
  // Handle bash shortcuts (! prefix)
  if (trimmed.startsWith('!')) { /* ... */ }
  
  // Handle slash commands (/ prefix)
  if (trimmed.startsWith('/')) {
    await commandHandler.current?.handleCommand(trimmed);
    return;
  }
  
  // Regular message - send to agent
  actions.setThinking(true);
  const response = await agent.sendMessage(trimmed);
  
  actions.addMessage({
    role: 'assistant',
    content: response,
  });
  actions.setThinking(false);
};
```

**Key Observations**:
- Currently blocks until agent completes
- No mechanism to inject messages during execution
- InputPrompt is still active/listening during execution (for Ctrl+C)

### 1.3 Subagent Communication

**AgentTool**: `/src/tools/AgentTool.ts`
- Creates isolated Agent instances with own message history
- Each subagent has own `ActivityStream` (scoped with parentId)
- Listens to `INTERRUPT_ALL` event (line 41)
- Uses `AgentPoolService` for agent lifecycle management

**Interrupt Propagation**:
```typescript
// AgentTool constructor (line 40-43)
this.activityStream.subscribe(ActivityEventType.INTERRUPT_ALL, () => {
  this.interruptAll();
});

// Interrupts all active delegations
private interruptAll(): void {
  this.activeDelegations.forEach((delegation, callId) => {
    if (delegation.agent && delegation.agent.isProcessing()) {
      delegation.agent.interrupt();
    }
  });
}
```

**Key Observations**:
- Subagents already have interrupt mechanism
- No current way to send messages to specific subagent
- Each subagent has isolated message history (`Agent.messages[]`)

### 1.4 State Management

**App.tsx State**:
- `state.isThinking`: boolean (main agent processing)
- `state.messages`: Message[] (conversation history)
- `state.toolCalls`: ToolCallState[] (tracked tool executions)

**Agent State**:
- `messages`: Message[] (conversation history)
- `requestInProgress`: boolean (processing flag)
- `interrupted`: boolean (interrupt flag)

**Session Persistence**: `/src/services/SessionManager.ts`
- Auto-saves messages + todos after each turn
- Messages include timestamps for ordering

---

## 2. Design: Input Capture During Response

### 2.1 Requirements

1. **Capture user input while agent is responding**
2. **Distinguish interrupt-only vs interrupt-with-message**
3. **Route message to correct agent (main or active subagent)**
4. **Preserve partial assistant response**
5. **Visual feedback in real-time**

### 2.2 Input Detection Strategy

**Option A: Dedicated Prompt Mode (Recommended)**

Add a new input mode triggered by a special key (e.g., `Ctrl+M` for "message"):

```typescript
// InputPrompt.tsx - new key handler
if (key.ctrl && input === 'm') {
  if (agent && agent.isProcessing()) {
    // Enter "mid-response prompt mode"
    setMidResponsePromptActive(true);
    setMidResponseBuffer('');
    return;
  }
}
```

**Why this approach**:
- Clear user intent (Ctrl+M = "I want to send a message NOW")
- Avoids conflict with normal input buffering
- Easy to implement visual indicator
- Can show special "Interjection >" prompt

**Option B: Automatic Buffering (Not Recommended)**

Buffer all input during agent processing and submit on Enter:
- **Risk**: Confusing UX - user might expect Enter to just interrupt
- **Risk**: No way to cancel the buffered message
- **Risk**: Conflicts with completion/history navigation

**Decision**: Use **Option A** (Ctrl+M trigger)

### 2.3 Input Flow State Machine

```
[Normal Mode]
  ↓ (User presses Ctrl+M while agent processing)
[Mid-Response Prompt Mode]
  ↓ (User types message)
[Buffer Accumulating]
  ↓ (User presses Enter)
[Submit Interjection]
  → Interrupt current response (preserve partial)
  → Emit USER_INTERJECTION event
  → Add user message to correct context
  → Resume agent processing
  ↓
[Normal Mode]
```

### 2.4 Visual Indicators

**During Typing**:
```
> Agent is processing...
Interjection > [cursor here]
```

**After Submit (in tool call display)**:
```
→ explore (task="Find auth code") [... 45s]
    ✓ tree (...) [11ms]
    ✓ grep (...) [26ms]
    > Wrap this up and give me what you have so far
    ✓ read (...) [56ms]
```

---

## 3. Design: Message Routing

### 3.1 Target Detection

**Challenge**: Determine if message should go to main agent or active subagent.

**Solution**: Track active agent stack in App.tsx

```typescript
// Track agent execution stack
const agentStack = useRef<Array<{
  agentId: string;
  callId: string;    // Tool call ID (for UI nesting)
  agentType: 'main' | 'subagent';
  agentName?: string; // For subagents (e.g., "explore", "general")
}>>([]);

// Update stack on AGENT_START events
useActivityEvent(ActivityEventType.AGENT_START, (event) => {
  agentStack.current.push({
    agentId: event.id,
    callId: event.parentId || 'root',
    agentType: event.data.isSpecializedAgent ? 'subagent' : 'main',
    agentName: event.data.agentName,
  });
});

// Pop on AGENT_END
useActivityEvent(ActivityEventType.AGENT_END, (event) => {
  const idx = agentStack.current.findIndex(a => a.agentId === event.id);
  if (idx !== -1) agentStack.current.splice(idx, 1);
});

// Get current active agent
function getCurrentAgent() {
  return agentStack.current[agentStack.current.length - 1] || {
    agentId: 'main',
    callId: 'root',
    agentType: 'main',
  };
}
```

### 3.2 Message Injection Points

**For Main Agent**:
```typescript
// Inject directly via Agent.addMessage()
agent.addMessage({
  role: 'user',
  content: interjectionText,
  timestamp: Date.now(),
  metadata: { isInterjection: true },
});
```

**For Subagent** (via AgentTool):
```typescript
// Need to expose method on AgentTool to inject messages
class AgentTool {
  async injectUserMessage(callId: string, message: string): Promise<void> {
    const delegation = this.activeDelegations.get(callId);
    if (!delegation || !delegation.agent) {
      throw new Error('No active delegation for this callId');
    }
    
    // Add message to subagent's context
    delegation.agent.addMessage({
      role: 'user',
      content: message,
      timestamp: Date.now(),
      metadata: { isInterjection: true },
    });
  }
}
```

**Routing Logic**:
```typescript
async function submitInterjection(message: string) {
  const currentAgent = getCurrentAgent();
  
  if (currentAgent.agentType === 'main') {
    // Inject into main agent
    agent.addMessage({
      role: 'user',
      content: message,
      metadata: { isInterjection: true },
    });
  } else {
    // Inject into subagent via tool
    const toolManager = serviceRegistry.get<ToolManager>('tool_manager');
    const agentTool = toolManager.getTool('agent') as AgentTool;
    
    await agentTool.injectUserMessage(
      currentAgent.callId,
      message
    );
  }
  
  // Emit event for UI display
  activityStream.emit({
    type: ActivityEventType.USER_INTERJECTION,
    parentId: currentAgent.callId,
    data: {
      message,
      targetAgent: currentAgent.agentType,
      targetCallId: currentAgent.callId,
    },
  });
}
```

### 3.3 Agent Continuation Strategy

**Challenge**: How does the agent continue after interjection?

**Current LLM Flow** (Agent.ts):
```
getLLMResponse() → processLLMResponse() → 
  [if tools] → executeToolCalls() → getLLMResponse() → ...
  [if text] → return response
```

**Interrupt Current Behavior**:
- Sets `interrupted = true`
- Throws error in `processLLMResponse()`
- Returns `"[Request interrupted by user]"`

**New Behavior for Interjections**:

1. **Don't throw error** - just cancel current LLM stream
2. **Preserve partial response** if any content exists
3. **Add user interjection** to message history
4. **Resume LLM call** with updated context

**Implementation** (modify Agent.ts):
```typescript
// New flag to distinguish interrupt types
private interruptionType: 'cancel' | 'interjection' | null = null;

// Modified interrupt method
interrupt(type: 'cancel' | 'interjection' = 'cancel'): void {
  this.interrupted = true;
  this.interruptionType = type;
  this.cancel(); // Cancel LLM stream
  // ... rest of interrupt logic
}

// Modified processLLMResponse
private async processLLMResponse(response: LLMResponse): Promise<string> {
  // Check for interruption
  if (this.interrupted) {
    if (this.interruptionType === 'interjection') {
      // Preserve partial response
      if (response.content || response.tool_calls) {
        this.messages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.tool_calls,
          timestamp: Date.now(),
          metadata: { partial: true },
        });
      }
      
      // User message will be added externally
      // Just reset flags and continue
      this.interrupted = false;
      this.interruptionType = null;
      
      // Resume with continuation call
      const continuationResponse = await this.getLLMResponse();
      return await this.processLLMResponse(continuationResponse);
    } else {
      // Regular cancel - throw error as before
      throw new Error('Request interrupted by user');
    }
  }
  
  // ... rest of processing
}
```

---

## 4. Design: State Management

### 4.1 Message History Updates

**Challenge**: Preserve conversation continuity across interruptions.

**Message Structure**:
```typescript
interface Message {
  role: MessageRole;
  content: string;
  timestamp?: number;
  metadata?: {
    isInterjection?: boolean;  // NEW: marks user interjections
    partial?: boolean;          // NEW: marks partial responses
    ephemeral?: boolean;        // Existing
    isCommandResponse?: boolean; // Existing
  };
}
```

**Conversation Example After Interjection**:
```json
[
  { "role": "user", "content": "Analyze this codebase" },
  { "role": "assistant", "content": "I'll start by exploring...", "tool_calls": [...], "metadata": { "partial": true } },
  { "role": "user", "content": "Focus on auth only", "metadata": { "isInterjection": true } },
  { "role": "assistant", "content": "Understood, narrowing to auth..." }
]
```

**Session Persistence**: Auto-save already handles this (saves full `messages[]`)

### 4.2 UI State Tracking

**New State Variables** (App.tsx):
```typescript
// Track mid-response prompt mode
const [midResponsePromptActive, setMidResponsePromptActive] = useState(false);
const [midResponseBuffer, setMidResponseBuffer] = useState('');

// Track agent execution stack
const agentStack = useRef<AgentStackEntry[]>([]);

// Track interjection submissions
const [pendingInterjections, setPendingInterjections] = useState<Map<string, string>>(new Map());
```

**Agent Stack Entry**:
```typescript
interface AgentStackEntry {
  agentId: string;      // Unique agent instance ID
  callId: string;       // Tool call ID (for UI hierarchy)
  agentType: 'main' | 'subagent';
  agentName?: string;   // Subagent name (e.g., "explore")
  startTime: number;
}
```

### 4.3 Resume Mechanism

**After Interjection**:
1. Agent's `interrupted` flag is reset
2. New user message is in history
3. Call `getLLMResponse()` again (continuation)
4. Model sees: partial response + user interjection + new context

**No Special Resume Logic Needed** - just continue normal flow!

---

## 5. Design: UI Updates

### 5.1 New Event Type

**Add to ActivityEventType enum** (`/src/types/index.ts`):
```typescript
export enum ActivityEventType {
  // ... existing events
  USER_INTERJECTION = 'user_interjection',
}
```

**Event Structure**:
```typescript
{
  id: string;
  type: ActivityEventType.USER_INTERJECTION;
  timestamp: number;
  parentId: string; // Tool call ID or 'root' for main agent
  data: {
    message: string;
    targetAgent: 'main' | 'subagent';
    targetCallId: string;
  };
}
```

### 5.2 ToolCallDisplay Component Updates

**Location**: `/src/ui/components/ToolCallDisplay.tsx`

**Current Structure**:
```tsx
<Box>
  {/* Tool call header */}
  <Text>{statusIcon} {toolName} ({args})</Text>
  
  {/* Diff preview */}
  {toolCall.diffPreview && <DiffDisplay />}
  
  {/* Error output */}
  {toolCall.error && <Text color="red">...</Text>}
  
  {/* Output */}
  {toolCall.output && <Text dimColor>...</Text>}
  
  {/* Nested children */}
  {children}
</Box>
```

**New Structure** (insert interjections):
```tsx
<Box>
  {/* Tool call header */}
  
  {/* Nested children (tools + interjections mixed) */}
  {childrenWithInterjections}
</Box>
```

**Rendering Logic**:
```typescript
interface ToolCallChild {
  type: 'tool' | 'interjection';
  timestamp: number;
  data: ToolCallState | UserInterjection;
}

interface UserInterjection {
  id: string;
  message: string;
  timestamp: number;
}

// Build combined children list
const childrenWithInterjections = useMemo(() => {
  const items: ToolCallChild[] = [];
  
  // Add nested tool calls
  nestedToolCalls.forEach(tc => {
    items.push({ type: 'tool', timestamp: tc.startTime, data: tc });
  });
  
  // Add interjections for this call
  interjections
    .filter(i => i.parentId === toolCall.id)
    .forEach(i => {
      items.push({ type: 'interjection', timestamp: i.timestamp, data: i });
    });
  
  // Sort by timestamp
  items.sort((a, b) => a.timestamp - b.timestamp);
  
  return items;
}, [nestedToolCalls, interjections, toolCall.id]);

// Render combined list
return (
  <Box>
    {/* ... header ... */}
    
    {childrenWithInterjections.map((child, idx) => {
      if (child.type === 'interjection') {
        return (
          <Box key={`interjection-${idx}`}>
            <Text>{indent}    </Text>
            <Text color="yellow">&gt; </Text>
            <Text color="yellow" dimColor>{child.data.message}</Text>
          </Box>
        );
      } else {
        return (
          <ToolCallDisplay 
            key={child.data.id}
            toolCall={child.data}
            level={level + 1}
          />
        );
      }
    })}
  </Box>
);
```

### 5.3 InputPrompt Visual State

**Mid-Response Prompt Mode**:
```tsx
{midResponsePromptActive ? (
  <Box borderColor="yellow" borderStyle="round">
    <Text color="yellow" bold>Interjection &gt; </Text>
    <Text>{midResponseBuffer}</Text>
    <Text backgroundColor="yellow" color="black">█</Text>
  </Box>
) : (
  /* Normal input prompt */
)}
```

**Status Indicator** (show target):
```tsx
{agent.isProcessing() && midResponsePromptActive && (
  <Text dimColor>
    → Sending to: {getCurrentAgent().agentName || 'main'}
  </Text>
)}
```

---

## 6. Integration Points

### 6.1 InputPrompt Component

**File**: `/src/ui/components/InputPrompt.tsx`

**Changes**:
1. Add state for mid-response mode
2. Add Ctrl+M key handler
3. Add separate buffer for interjections
4. Add submit handler for interjections
5. Add visual mode indicator

**New Props**:
```typescript
interface InputPromptProps {
  // ... existing props
  
  /** Callback when user submits mid-response interjection */
  onInterjection?: (message: string) => void;
  
  /** Whether mid-response prompt mode is active */
  midResponseMode?: boolean;
  
  /** Current target for interjections */
  interjectionTarget?: {
    agentType: 'main' | 'subagent';
    agentName?: string;
  };
}
```

### 6.2 App Component

**File**: `/src/ui/App.tsx`

**Changes**:
1. Add agent stack tracking
2. Add interjection state
3. Implement `handleInterjection()` callback
4. Subscribe to USER_INTERJECTION events
5. Update ToolCallDisplay with interjections

**New Functions**:
```typescript
// Handle interjection submission
const handleInterjection = async (message: string) => {
  const target = getCurrentAgent();
  
  // Submit to correct agent
  await submitInterjection(message, target);
  
  // Reset UI state
  setMidResponsePromptActive(false);
  setMidResponseBuffer('');
};

// Get current active agent
const getCurrentAgent = (): AgentTarget => {
  return agentStack.current[agentStack.current.length - 1] || {
    agentId: 'main',
    callId: 'root',
    agentType: 'main',
  };
};
```

### 6.3 Agent Class

**File**: `/src/agent/Agent.ts`

**Changes**:
1. Add `interruptionType` property
2. Modify `interrupt()` to accept type parameter
3. Update `processLLMResponse()` to handle interjections
4. Preserve partial responses
5. Auto-resume after interjection

**New Methods**:
```typescript
/**
 * Add user message for interjection
 * Called externally when user submits mid-response prompt
 */
addUserInterjection(message: string): void {
  this.messages.push({
    role: 'user',
    content: message,
    timestamp: Date.now(),
    metadata: { isInterjection: true },
  });
  
  logger.debug('[AGENT_INTERJECTION]', this.instanceId, 'User interjection added');
}
```

### 6.4 AgentTool

**File**: `/src/tools/AgentTool.ts`

**Changes**:
1. Add `injectUserMessage()` method
2. Expose delegation lookup by callId
3. Support interjection propagation

**New Methods**:
```typescript
/**
 * Inject user message into active subagent
 * @param callId - Tool call ID identifying the delegation
 * @param message - User's interjection message
 */
async injectUserMessage(callId: string, message: string): Promise<void> {
  const delegation = this.activeDelegations.get(callId);
  
  if (!delegation || !delegation.agent) {
    throw new Error(`No active delegation found for callId: ${callId}`);
  }
  
  if (!delegation.agent.isProcessing()) {
    throw new Error(`Agent for callId ${callId} is not currently processing`);
  }
  
  // Add interjection to subagent's context
  delegation.agent.addUserInterjection(message);
  
  logger.debug('[AGENT_TOOL_INTERJECTION]', 
    'Injected message into subagent:', callId, message.substring(0, 50));
}
```

### 6.5 ActivityStream

**File**: `/src/services/ActivityStream.ts`

**No changes needed** - already supports event emission/subscription.

**Usage**:
```typescript
// Emit interjection event
activityStream.emit({
  id: `interjection-${Date.now()}`,
  type: ActivityEventType.USER_INTERJECTION,
  timestamp: Date.now(),
  parentId: targetCallId,
  data: { message, targetAgent },
});
```

### 6.6 ToolOrchestrator

**File**: `/src/agent/ToolOrchestrator.ts`

**No changes needed** - tool execution continues after interjection.

### 6.7 SessionManager

**File**: `/src/services/SessionManager.ts`

**No changes needed** - auto-save already persists full message history.

---

## 7. Edge Cases & Mitigations

### 7.1 Multiple Rapid Interjections

**Problem**: User sends multiple interjections in quick succession.

**Mitigation**:
- Queue interjections (FIFO)
- Only process one at a time
- Block new interjections until current one is processed

```typescript
const interjectionQueue = useRef<string[]>([]);
const processingInterjection = useRef(false);

async function handleInterjection(message: string) {
  interjectionQueue.current.push(message);
  
  if (processingInterjection.current) return;
  
  processingInterjection.current = true;
  while (interjectionQueue.current.length > 0) {
    const msg = interjectionQueue.current.shift()!;
    await submitInterjection(msg);
    await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
  }
  processingInterjection.current = false;
}
```

### 7.2 Interjection During Permission Prompt

**Problem**: User tries to interject while waiting for tool permission.

**Mitigation**:
- Disable interjection mode when permission prompt is active
- Show message: "Cannot interject during permission prompt"

```typescript
// InputPrompt.tsx
if (key.ctrl && input === 'm') {
  // Block if permission prompt active
  if (permissionRequest) {
    // Show error message
    return;
  }
  
  // ... proceed with interjection
}
```

### 7.3 Interjection During Batch Tool Execution

**Problem**: Agent is executing multiple tools concurrently - unclear which context to inject into.

**Mitigation**:
- Interjections during batch execution go to the agent level (not individual tools)
- Agent processes interjection after current tool batch completes
- Clear in UI which agent receives the message

### 7.4 Nested Subagent Interjections

**Problem**: Main agent delegates to subagent A, which delegates to subagent B. User interjections should go to deepest active agent.

**Mitigation**:
- Agent stack tracks full nesting (already designed)
- `getCurrentAgent()` returns deepest agent
- UI shows full path: "main → explore → general"

### 7.5 Interjection After Tool Completes

**Problem**: User submits interjection, but target tool/agent finishes before message is processed.

**Mitigation**:
- Check `agent.isProcessing()` before injection
- If no longer processing, route to parent agent (or main)
- Show warning in UI: "Agent completed - message sent to main context"

```typescript
async function submitInterjection(message: string) {
  let target = getCurrentAgent();
  
  // Verify target is still active
  if (!isAgentActive(target)) {
    // Find next active parent
    target = findActiveParent(target) || getMainAgent();
    
    // Notify user
    showNotification(`Agent completed - sending to ${target.agentName || 'main'}`);
  }
  
  // ... proceed with submission
}
```

### 7.6 Session Resume with Interjections

**Problem**: Loading a session that contains interjection metadata - need to reconstruct UI state.

**Mitigation**:
- Interjections are stored as regular user messages (with metadata)
- On load, reconstruct by timestamp ordering
- ToolCallDisplay checks message timestamps to place interjections correctly

**Implementation**:
```typescript
// Reconstruct interjections from loaded messages
function extractInterjections(messages: Message[]): UserInterjection[] {
  return messages
    .filter(m => m.role === 'user' && m.metadata?.isInterjection)
    .map(m => ({
      id: `interjection-${m.timestamp}`,
      message: m.content,
      timestamp: m.timestamp!,
      // Infer parentId from adjacent tool calls (heuristic)
      parentId: inferParentCall(messages, m),
    }));
}
```

### 7.7 LLM Confusion from Interjections

**Problem**: Model might get confused by abrupt context switches.

**Mitigation**:
- Add system reminder before user interjection:

```typescript
// Agent.ts - when processing interjection
if (userMessageIsInterjection) {
  this.messages.push({
    role: 'system',
    content: '<system-reminder>\nUser sent a mid-response message. Address their new input, then continue your previous task if still relevant.\n</system-reminder>',
  });
}

this.messages.push({
  role: 'user',
  content: interjectionMessage,
  metadata: { isInterjection: true },
});
```

### 7.8 Interjection During Compaction

**Problem**: Auto-compaction starts while user is typing interjection.

**Mitigation**:
- Disable compaction during interjection mode
- Queue compaction for after response completes

```typescript
// Agent.ts
private async checkAutoCompaction(): Promise<void> {
  // Don't auto-compact during interjections
  if (this.processingInterjection) {
    return;
  }
  
  // ... rest of compaction logic
}
```

---

## 8. Phased Implementation Plan

### Phase 1: Basic Mid-Response Prompts (Main Agent Only)

**Goal**: Enable interjections for main agent without subagent support.

**Deliverables**:
1. ✅ InputPrompt: Ctrl+M trigger for interjection mode
2. ✅ InputPrompt: Visual indicator for interjection mode
3. ✅ InputPrompt: Separate submit handler for interjections
4. ✅ Agent: Modified `interrupt()` with type parameter
5. ✅ Agent: Updated `processLLMResponse()` to preserve partial responses
6. ✅ Agent: `addUserInterjection()` method
7. ✅ App: `handleInterjection()` callback
8. ✅ Types: Add `USER_INTERJECTION` event type
9. ✅ Types: Add `isInterjection` and `partial` message metadata

**Testing**:
- User can press Ctrl+M while main agent is processing
- Interjection prompt appears with visual indicator
- User can type message and submit with Enter
- Main agent receives message and continues processing
- Partial response is preserved in conversation
- Session saving includes interjection metadata

**Files to Modify**:
- `/src/ui/components/InputPrompt.tsx` (~100 lines)
- `/src/agent/Agent.ts` (~50 lines)
- `/src/ui/App.tsx` (~80 lines)
- `/src/types/index.ts` (~10 lines)

**Estimated Effort**: 1-2 days

---

### Phase 2: Subagent Message Injection

**Goal**: Route interjections to active subagents.

**Deliverables**:
1. ✅ App: Agent stack tracking (AGENT_START/END listeners)
2. ✅ App: `getCurrentAgent()` helper
3. ✅ App: Route interjections based on agent stack
4. ✅ AgentTool: `injectUserMessage()` method
5. ✅ AgentTool: Delegation lookup by callId
6. ✅ ExploreTool/PlanTool: Same interjection support
7. ✅ App: Visual indicator showing target agent

**Testing**:
- User starts task that delegates to subagent
- While subagent is processing, user presses Ctrl+M
- UI shows "Interjection → explore"
- User submits message
- Message is added to subagent's context (not main)
- Subagent continues processing with new context
- Main agent remains unaware of interjection

**Files to Modify**:
- `/src/ui/App.tsx` (~120 lines)
- `/src/tools/AgentTool.ts` (~60 lines)
- `/src/tools/ExploreTool.ts` (~40 lines)
- `/src/tools/PlanTool.ts` (~40 lines)

**Estimated Effort**: 2-3 days

---

### Phase 3: UI Indicators and Polish

**Goal**: Perfect visual feedback and edge case handling.

**Deliverables**:
1. ✅ ToolCallDisplay: Render interjections nested under tool calls
2. ✅ ToolCallDisplay: Timestamp-based ordering of children
3. ✅ ToolCallDisplay: Interjection styling (yellow `>` prefix)
4. ✅ StatusIndicator: Show interjection target
5. ✅ Edge case: Handle rapid interjections (queue)
6. ✅ Edge case: Handle interjection during permission prompt
7. ✅ Edge case: Handle agent completion before interjection processes
8. ✅ Edge case: System reminder for context switches
9. ✅ ConversationView: Show interjections in message flow
10. ✅ Session reconstruction: Extract interjections from loaded messages

**Testing**:
- Interjections appear correctly nested in tool call hierarchy
- UI shows clear visual distinction (yellow color, `>` prefix)
- Status bar updates to show target agent
- Rapid interjections are queued and processed in order
- Permission prompts block interjections
- Agent completion edge case handled gracefully
- Loaded sessions display interjections correctly
- System reminders help model understand context

**Files to Modify**:
- `/src/ui/components/ToolCallDisplay.tsx` (~80 lines)
- `/src/ui/components/StatusIndicator.tsx` (~30 lines)
- `/src/ui/components/ConversationView.tsx` (~40 lines)
- `/src/ui/App.tsx` (~100 lines - edge cases)

**Estimated Effort**: 2-3 days

---

### Phase 4: Advanced Features (Optional)

**Future Enhancements** (not in initial scope):

1. **Interjection History Navigation**
   - Arrow keys to browse previous interjections
   - Separate from main command history

2. **Batch Interjections**
   - Send message to multiple subagents at once
   - Useful for "stop all and focus on X"

3. **Conditional Interjections**
   - If agent hasn't responded in 10s, auto-interject "status update?"
   - User-configurable automation

4. **Interjection Templates**
   - Quick snippets: "wrap up", "be more detailed", "show code"
   - Hotkeys for common redirections

5. **Interjection Analytics**
   - Track which interjections are most effective
   - Suggest improvements to initial prompts

---

## 9. Risk Assessment

### 9.1 Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Race conditions between interjection and agent completion | Medium | Medium | Check `isProcessing()` before injection, queue if uncertain |
| LLM confusion from context switches | Medium | Medium | Add system reminders, design clear prompts |
| UI state sync issues (React updates) | Low | High | Use refs for real-time state, batch updates carefully |
| Message history corruption | Low | High | Validate message structure, extensive testing |
| Subagent delegation lifecycle mismatch | Medium | Medium | Track delegations with unique IDs, cleanup on end |

### 9.2 UX Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Users accidentally trigger interjection mode | Low | Low | Use non-conflicting key (Ctrl+M), show clear visual indicator |
| Confusion about which agent receives message | Medium | Medium | Prominent status indicator, clear "Sending to: X" message |
| Interjections lost or ignored | Low | High | Queue system, persistence, clear feedback |
| Overwhelming with too many interjections | Low | Medium | Rate limiting, UI warnings |

### 9.3 Performance Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Excessive event emissions slow UI | Low | Medium | Throttle events, batch updates, use memoization |
| Large interjection queues consume memory | Low | Low | Cap queue size at 10, warn user |
| Nested agent stack overflow | Very Low | Low | Limit nesting depth (already enforced elsewhere) |

---

## 10. Testing Strategy

### 10.1 Unit Tests

**Agent.ts**:
```typescript
describe('Agent interjections', () => {
  test('addUserInterjection() adds message with metadata', async () => {
    const agent = new Agent(/*...*/);
    agent.addUserInterjection('test message');
    
    const messages = agent.getMessages();
    expect(messages[messages.length - 1]).toMatchObject({
      role: 'user',
      content: 'test message',
      metadata: { isInterjection: true },
    });
  });
  
  test('interrupt(interjection) preserves partial response', async () => {
    const agent = new Agent(/*...*/);
    agent.sendMessage('test');
    
    // Simulate mid-response
    agent.interrupt('interjection');
    
    const messages = agent.getMessages();
    const partialResponse = messages.find(m => m.metadata?.partial);
    expect(partialResponse).toBeDefined();
  });
});
```

**AgentTool.ts**:
```typescript
describe('AgentTool interjections', () => {
  test('injectUserMessage() adds to subagent context', async () => {
    const tool = new AgentTool(activityStream);
    const callId = await tool.execute({
      task_prompt: 'test task',
    });
    
    await tool.injectUserMessage(callId, 'interjection');
    
    // Verify message was added to subagent
    // (requires exposing delegation agent for testing)
  });
  
  test('injectUserMessage() throws if delegation not found', async () => {
    const tool = new AgentTool(activityStream);
    
    await expect(
      tool.injectUserMessage('invalid-id', 'test')
    ).rejects.toThrow('No active delegation');
  });
});
```

### 10.2 Integration Tests

**Full Flow Tests**:
```typescript
describe('End-to-end interjection flow', () => {
  test('main agent receives and processes interjection', async () => {
    // 1. Start agent processing
    const responsePromise = agent.sendMessage('analyze this code');
    
    // 2. Wait for processing to start
    await waitFor(() => agent.isProcessing());
    
    // 3. Inject message
    agent.addUserInterjection('focus on security only');
    agent.interrupt('interjection');
    
    // 4. Wait for completion
    const response = await responsePromise;
    
    // 5. Verify response incorporates interjection
    expect(response).toContain('security');
    
    // 6. Verify message history
    const messages = agent.getMessages();
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: 'focus on security only',
        metadata: { isInterjection: true },
      })
    );
  });
  
  test('subagent receives interjection via AgentTool', async () => {
    // Similar test for subagent flow
  });
});
```

### 10.3 UI Tests

**InputPrompt Tests**:
```typescript
describe('InputPrompt interjection mode', () => {
  test('Ctrl+M activates interjection mode', () => {
    const { getByText } = render(<InputPrompt {...props} />);
    
    fireEvent.keyPress(document, { key: 'm', ctrlKey: true });
    
    expect(getByText('Interjection >')).toBeInTheDocument();
  });
  
  test('Enter submits interjection', () => {
    const onInterjection = jest.fn();
    const { getByText } = render(
      <InputPrompt {...props} onInterjection={onInterjection} />
    );
    
    // Activate mode
    fireEvent.keyPress(document, { key: 'm', ctrlKey: true });
    
    // Type message
    fireEvent.input(document, { target: { value: 'test' } });
    
    // Submit
    fireEvent.keyPress(document, { key: 'Enter' });
    
    expect(onInterjection).toHaveBeenCalledWith('test');
  });
});
```

### 10.4 Manual Testing Checklist

**Phase 1 (Main Agent)**:
- [ ] Press Ctrl+M during agent processing
- [ ] Interjection prompt appears
- [ ] Type message and press Enter
- [ ] Agent receives message and continues
- [ ] Partial response preserved
- [ ] Conversation history correct
- [ ] Session save/load works
- [ ] Escape cancels interjection mode
- [ ] Ctrl+C during interjection mode clears buffer

**Phase 2 (Subagents)**:
- [ ] Start task that uses subagent (explore, plan, agent)
- [ ] Press Ctrl+M while subagent processing
- [ ] Status shows correct target agent
- [ ] Interjection goes to subagent (not main)
- [ ] Subagent continues with new context
- [ ] Nested subagents route correctly
- [ ] Subagent completion before interjection handled

**Phase 3 (UI)**:
- [ ] Interjections appear nested in tool calls
- [ ] Yellow `>` prefix visible
- [ ] Timestamp ordering correct
- [ ] Status bar updates
- [ ] Rapid interjections queued properly
- [ ] Permission prompt blocks interjections
- [ ] Session reconstruction displays interjections

---

## 11. Success Metrics

### 11.1 Functional Metrics

- ✅ Interjections delivered to correct agent (100% accuracy)
- ✅ Partial responses preserved (100% retention)
- ✅ Zero data loss (message history integrity)
- ✅ Zero crashes from interjections
- ✅ Subagent routing accuracy (100%)

### 11.2 Performance Metrics

- ⏱️ Interjection mode activation: <50ms
- ⏱️ Message injection latency: <100ms
- ⏱️ UI update latency: <200ms
- 📊 Memory overhead: <5MB per interjection
- 📊 Event emission rate: <10 events/second

### 11.3 UX Metrics

- 😊 User can discover feature (Ctrl+M hotkey shown in help)
- 😊 Visual feedback is clear (obvious which agent receives message)
- 😊 Error states are handled gracefully (clear error messages)
- 😊 No confusion from partial responses (system reminders help)

---

## 12. Documentation Updates

### 12.1 User Documentation

**File**: `docs/USER_GUIDE.md` (new section)

```markdown
## Mid-Response Prompts (Interjections)

You can send messages to the agent while it's processing a response. This is useful for:
- Redirecting the agent's focus ("actually, focus on X instead")
- Providing clarification ("use this specific approach")
- Stopping runaway subagents ("wrap this up")

### How to Use

1. **While the agent is processing**, press `Ctrl+M`
2. The prompt changes to "Interjection >"
3. Type your message
4. Press `Enter` to send

### Where Messages Go

- **Main agent**: Your message goes to the main conversation
- **Subagent** (explore, plan, etc.): Your message goes to the active subagent's context

The status bar shows which agent will receive your message.

### Example

```
> Analyze this codebase for bugs
[Agent starts analyzing...]

[Press Ctrl+M]
Interjection > Focus only on memory leaks

[Agent receives your message and adjusts its analysis]
```

### Tips

- Interjections are **additive** - they don't replace the original task
- The agent sees your interjection as a new user message
- Partial responses are preserved in conversation history
- Press `Escape` to cancel interjection mode
```

### 12.2 Developer Documentation

**File**: `docs/ARCHITECTURE.md` (new section)

```markdown
## Interjection System

The interjection system allows users to inject messages mid-response without losing partial progress.

### Architecture

```
User Input (Ctrl+M)
  ↓
InputPrompt (interjection mode)
  ↓
App.handleInterjection()
  ↓
Route based on agent stack
  ├─→ Main Agent: agent.addUserInterjection()
  └─→ Subagent: agentTool.injectUserMessage()
       ↓
Agent.interrupt('interjection')
  ↓
Preserve partial response
  ↓
Add user message to context
  ↓
Resume LLM call
```

### Key Components

- **InputPrompt**: Captures interjections via Ctrl+M
- **App.agentStack**: Tracks active agent hierarchy
- **Agent.interruptionType**: Distinguishes cancel vs interjection
- **AgentTool.injectUserMessage()**: Routes to subagents
- **USER_INTERJECTION event**: UI updates

### Message Metadata

```typescript
{
  role: 'user',
  content: 'user message',
  metadata: {
    isInterjection: true, // Marks interjected messages
  }
}
```

### Event Flow

1. USER_INTERJECTION emitted with parentId (tool call)
2. ToolCallDisplay listens and renders nested
3. ActivityStream propagates to all listeners
```

---

## 13. Alternative Approaches Considered

### 13.1 Approach: Websocket-Based Input

**Description**: Use websocket connection for real-time bidirectional communication.

**Pros**:
- True real-time input capture
- No need for special key triggers
- Could support other real-time features

**Cons**:
- Massive architecture change (CLI uses stdin/stdout)
- Overkill for this feature
- Adds complexity and dependencies
- Breaks terminal-native feel

**Decision**: ❌ Rejected - too invasive for CLI app

### 13.2 Approach: Separate Input Thread

**Description**: Run input capture in separate thread/process.

**Pros**:
- True parallel input
- No blocking on agent processing

**Cons**:
- Complex IPC required
- State synchronization issues
- Node.js worker threads are heavy
- Complicates debugging

**Decision**: ❌ Rejected - unnecessary complexity

### 13.3 Approach: Auto-Detect Intent (No Ctrl+M)

**Description**: Automatically detect when user starts typing during processing.

**Pros**:
- No special key needed
- "Natural" UX

**Cons**:
- Ambiguous user intent (accidental typing?)
- No clear signal when to submit
- Risk of false positives
- Confusing if user expects Ctrl+C behavior

**Decision**: ❌ Rejected - too ambiguous

### 13.4 Approach: Command Prefix (e.g., ">message")

**Description**: User types special prefix to indicate interjection.

**Pros**:
- Clear intent signal
- No new keybindings

**Cons**:
- Requires Enter to see prefix (too late)
- Doesn't solve "how to enter mid-response" problem
- Still need Ctrl+M or similar

**Decision**: ❌ Rejected - doesn't solve core problem

---

## 14. Open Questions

### 14.1 UX Questions

**Q1**: Should interjections automatically interrupt, or require confirmation?

**A**: Auto-interrupt is better UX. User pressed Ctrl+M explicitly, then Enter to submit - two deliberate actions. Confirmation dialog would be annoying.

**Q2**: Should we show a preview of the partial response before submitting interjection?

**A**: Not in MVP. Could be Phase 4 enhancement. Shows last N lines of assistant's partial response above interjection prompt.

**Q3**: What happens if user presses Ctrl+M when agent is NOT processing?

**A**: Ignore silently, or show brief message "Agent not processing - use normal input". Prefer latter for discoverability.

### 14.2 Technical Questions

**Q1**: Should interjections count toward context limits?

**A**: Yes - they're regular messages. But we could add metadata to deprioritize them during auto-compaction (keep original task, drop some interjections).

**Q2**: How to handle interjections that fundamentally change the task?

**A**: Let the model decide. System reminder helps: "User sent mid-response message. Address their new input, then continue your previous task **if still relevant**."

**Q3**: Should subagent interjections be visible in main conversation?

**A**: No - they're scoped to subagent. But main agent might see summarized tool result that mentions "User requested focus on X" if that affects the outcome.

**Q4**: Rate limiting for interjections?

**A**: Not in MVP. Could add if abuse detected (e.g., max 1 interjection per 5 seconds).

### 14.3 Future Enhancements

**Q1**: Voice input for interjections?

**A**: Interesting for accessibility. Would need speech-to-text integration. Phase 4+.

**Q2**: Undo an interjection?

**A**: Could support "Ctrl+Z" to remove last interjection message. Requires careful state management. Phase 4.

**Q3**: Interjection templates/shortcuts?

**A**: See Phase 4 - predefined quick actions. Example: "Ctrl+Shift+W" = "Wrap this up now"

---

## 15. Conclusion

This implementation plan provides a comprehensive roadmap for mid-response user prompts. The phased approach allows for incremental development and testing, with clear success criteria at each stage.

### Summary of Approach

1. **Ctrl+M trigger** for interjection mode (clear, non-conflicting)
2. **Agent stack tracking** for routing to correct context
3. **Interrupt preservation** (partial responses kept)
4. **Event-driven UI updates** (USER_INTERJECTION event)
5. **Graceful edge case handling** (queuing, validation, fallbacks)

### Next Steps

1. Review this plan with team
2. Set up feature branch: `feature/mid-response-prompts`
3. Begin Phase 1 implementation
4. Create test cases in parallel
5. User testing after Phase 2
6. Iterate based on feedback
7. Document thoroughly

### Key Risks to Monitor

- LLM confusion from context switches → Add clear system reminders
- Race conditions → Extensive testing of edge cases
- UX discoverability → Prominent help text, tutorials

### Success Criteria

- Users can redirect agents mid-execution
- Subagents receive focused instructions
- Zero data loss or corruption
- Clear, intuitive UX
- Robust error handling

---

**Document Version**: 1.0
**Last Updated**: 2025-10-31
**Status**: Ready for Review
