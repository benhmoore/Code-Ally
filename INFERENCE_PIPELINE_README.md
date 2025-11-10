# Ally Inference Pipeline Mapping - Documentation Index

## Overview

This directory contains comprehensive documentation of Ally's inference pipeline and plugin hook points. The mapping identifies where user messages flow through the system, how the LLM is invoked, and all the points where plugins can inject custom logic.

## Documents in This Collection

### 1. **INFERENCE_PIPELINE_MAP.md** (1,117 lines)
**The most comprehensive reference guide.**

Complete technical mapping of the entire inference pipeline with:
- Section 1: User Input → LLM Flow (Hooks 1-9)
- Section 2: LLM → User Response Flow (Hooks 10-31)
- Section 3: Idle Message Generation (Hooks 32-35)
- Section 4: Existing Event Hooks (Hook 36 with 12 event types)
- Section 5: System Prompt Assembly Details (Hooks 37-39)
- Section 6: Complete Hook Reference Table (all 39 hooks)
- Section 7: Data Flow Diagram (visual pipeline)
- Section 8: Implementation Guidelines
- Section 9: File Location Reference
- Section 10: Key Insights for Plugin Developers

**When to use:** Detailed technical reference, implementation specifics, complete context.

---

### 2. **PLUGIN_HOOKS_QUICK_REFERENCE.md** (362 lines)
**Quick lookup guide for plugin developers.**

Fast reference with:
- At-a-glance summary of all 39 hooks
- Tier 1 & 2 hooks (most important)
- Hook categories by phase (Input, Output, Execution, Response, Background)
- Critical files for hook implementation
- Safety guidelines (safe vs caution vs avoid)
- Plugin development checklist
- 7 plugin pattern examples
- Hook execution order
- Quick start guide
- When to use each hook table

**When to use:** Quick lookups, deciding which hook to implement, safety checks.

---

### 3. **HOOK_POINTS_VISUAL.txt** (305 lines)
**ASCII flow diagram of the entire pipeline.**

Visual representation showing:
- Phase 1: User Input → System Prompt (Hooks 1-6, 37-39)
- Phase 2: LLM Execution (Hooks 7-9)
- Phase 3: Response Validation (Hooks 10-18)
- Phase 4: Tool Execution (Hooks 19-24, recursive)
- Phase 5: Text Response Processing (Hooks 25-31)
- Parallel Process: Background Idle Messages (Hooks 32-35)
- Parallel Process: Event Subscription (Hook 36)
- Legend and statistics

**When to use:** Understanding overall flow, visual learners, presentation purposes.

---

## Quick Navigation by Task

### "I want to..."

#### ...add project-specific rules to the system prompt
**Use Hooks 4 or 37**
- Files: `src/agent/Agent.ts:663-691`, `src/prompts/systemMessages.ts:342`
- Docs: INFERENCE_PIPELINE_MAP.md Section 1.D & 5

#### ...validate tool calls before execution
**Use Hooks 7 or 23**
- Files: `src/agent/Agent.ts:661`, `src/agent/Agent.ts:1080`
- Docs: PLUGIN_HOOKS_QUICK_REFERENCE.md "Tier 2 Hooks"

#### ...monitor tool results in real-time
**Use Hook 24 or Hook 36 (TOOL_CALL_END event)**
- Files: `src/agent/Agent.ts:1080`, `src/plugins/EventSubscriptionManager.ts:67-80`
- Docs: INFERENCE_PIPELINE_MAP.md Section 2.E, Hook Reference Table

#### ...inject context-aware suggestions while idle
**Use Hook 32**
- Files: `src/services/IdleMessageGenerator.ts:173`
- Docs: INFERENCE_PIPELINE_MAP.md Section 3

#### ...validate LLM responses
**Use Hook 10 or Hook 8**
- Files: `src/agent/Agent.ts:721` or `src/agent/Agent.ts:717`
- Docs: INFERENCE_PIPELINE_MAP.md Section 2.A-D

#### ...track what the user is asking about
**Use Hook 1 (pre-add) or Hook 36 (AGENT_START event)**
- Files: `src/agent/Agent.ts:395` or `src/services/ActivityStream.ts:32-98`
- Docs: PLUGIN_HOOKS_QUICK_REFERENCE.md "Most Important Hooks"

#### ...run background processes
**Use Hook 36 (event subscription)**
- Files: `src/plugins/EventSubscriptionManager.ts`
- Docs: INFERENCE_PIPELINE_MAP.md Section 4

#### ...understand the complete flow
**Read all three documents in order:**
1. HOOK_POINTS_VISUAL.txt (overview)
2. PLUGIN_HOOKS_QUICK_REFERENCE.md (decision making)
3. INFERENCE_PIPELINE_MAP.md (implementation details)

---

## Hook Statistics

| Category | Count | Hook Numbers |
|----------|-------|--------------|
| **Input Phase** | 9 | 1, 2, 3, 4, 5, 6, 7, 8, 9 |
| **Output Phase** | 9 | 10, 11, 12, 13, 14, 15, 16, 17, 18 |
| **Execution Phase** | 6 | 19, 20, 21, 22, 23, 24 |
| **Response Phase** | 7 | 25, 26, 27, 28, 29, 30, 31 |
| **Background Phase** | 4 | 32, 33, 34, 35 |
| **Event Subscriptions** | 12 | 36 (12 event types) |
| **Prompt Assembly** | 3 | 37, 38, 39 |
| **TOTAL** | 39 | |

---

## Top 5 Most Important Hooks

1. **Hook 4: PRE-SYSTEM-PROMPT-GENERATION**
   - Location: `src/prompts/systemMessages.ts:342`
   - Use: Inject project rules, custom directives
   - Impact: Affects all LLM responses

2. **Hook 8: PRE-LLM-SEND**
   - Location: `src/agent/Agent.ts:717`
   - Use: Request validation, compliance checks
   - Impact: Last chance to modify before LLM

3. **Hook 10: POST-LLM-RESPONSE**
   - Location: `src/agent/Agent.ts:721`
   - Use: Response analysis, validation
   - Impact: Analyze model output

4. **Hook 23: PRE-TOOL-EXECUTION**
   - Location: `src/agent/Agent.ts:1080`
   - Use: Tool validation, pre-execution filtering
   - Impact: Control what tools execute

5. **Hook 36: EVENT-SUBSCRIPTION**
   - Location: `src/plugins/EventSubscriptionManager.ts`
   - Use: Background monitoring (12 event types)
   - Impact: Safest place to start

---

## Safe vs Risky Hooks

### Green: Safe to Modify
- Hook 4, 5, 6 (system prompt) - Add sections only
- Hook 10, 13, 17, 24 (post-operation) - Read-only observation
- Hook 37, 38, 39 (prompt assembly) - Add providers only
- Hook 36 (events) - Read-only subscription

### Yellow: Proceed with Caution
- Hook 1 (pre-user-message-add) - Validate thoroughly
- Hook 2 (pre-system-reminder-add) - Don't remove critical reminders
- Hook 7 (pre-function-defs-fetch) - Don't break schemas
- Hook 34 (pre-queue-update) - Preserve queue integrity

### Red: Avoid Unless Critical
- Hook 5, 6 (system prompt assignment) - Breaking structure
- Hook 24 (tool results) - Modifying results
- Hook 36 (suppressing events) - Hiding important data

---

## File References

### Core Files Involved in Inference Pipeline

```
src/agent/Agent.ts
├── sendMessage(message) - Line 366
├── getLLMResponse() - Line 655
├── processLLMResponse() - Line 760
├── processToolResponse() - Line 1000
├── processTextResponse() - Line 1192
└── autoSaveSession() - Line 1443

src/prompts/systemMessages.ts
├── getMainSystemPrompt() - Line 342
├── getAgentSystemPrompt() - Line 414
├── getContextInfo() - Line 240
└── getContextBudgetReminder() - Line 198

src/llm/OllamaClient.ts
├── send() - Line 174
├── processStreamingResponse() - Line 378
├── parseNonStreamingResponse() - Line 545
└── normalizeToolCallsInMessage() - Line 597

src/agent/ToolOrchestrator.ts
├── executeToolCalls() - Line 117
├── executeConcurrent() - (concurrent execution)
└── executeSequential() - (sequential execution)

src/services/IdleMessageGenerator.ts
├── generateMessageBatch() - Line 168
├── generateMessageBackground() - Line 228
├── buildBatchMessagePrompt() - Line 293
└── generateAndRefillQueueAsync() - Line 272

src/services/ActivityStream.ts
├── emit() - Line 32
└── mapToPluginEventType() - Line 81

src/plugins/EventSubscriptionManager.ts
├── APPROVED_EVENTS - Line 67
├── dispatch() - Event forwarding
└── EventSubscription interface - Line 90
```

---

## Quick Implementation Steps

### To Implement a Plugin Hook

1. **Choose your hook** from Quick Reference
2. **Read the details** in the Reference Table (Section 6)
3. **Understand the data** available at that hook
4. **Check safety** guidelines (Green/Yellow/Red)
5. **Locate the file** in File References section
6. **Study the context** by reading source code
7. **Implement with error handling**
8. **Test thoroughly** with edge cases
9. **Document your hooks** clearly

### For Event Subscriptions (Hook 36)

1. Get EventSubscriptionManager from ServiceRegistry
2. Call `subscribe()` with plugin name, socket path, and event list
3. Listen on socket for JSON-RPC notifications
4. Process `on_event` notifications asynchronously
5. Don't block - return immediately

---

## Common Plugin Patterns

### Pattern 1: Context-Aware Suggestions
- Hooks: 32 (pre-idle-gen)
- Purpose: Inject suggestions based on project context
- Example: "Detected TypeScript project, suggest TS-specific messages"

### Pattern 2: Request Validation
- Hooks: 8 (pre-LLM-send)
- Purpose: Validate before costly LLM call
- Example: "Check message format, warn about potential issues"

### Pattern 3: Response Analysis
- Hooks: 10 (post-LLM-response)
- Purpose: Analyze model output quality
- Example: "Track response lengths, detect repeated patterns"

### Pattern 4: Tool Monitoring
- Hooks: 23-24 (pre/post-tool-exec) or 36 (TOOL_CALL_START/END)
- Purpose: Track tool usage and performance
- Example: "Log slow tool executions, suggest alternatives"

### Pattern 5: System Prompt Enhancement
- Hooks: 4, 37-39 (prompt generation)
- Purpose: Add project-specific rules
- Example: "Add coding standards, security requirements"

### Pattern 6: Session Management
- Hooks: 29-30 (pre/post-session-save)
- Purpose: Customize persistence
- Example: "Sync with external system, backup to cloud"

### Pattern 7: Background Monitoring
- Hooks: 36 (event subscription)
- Purpose: Non-blocking analytics
- Example: "Collect metrics, trigger alerts, sync UI"

---

## Troubleshooting

### "Where do I hook in to modify the system prompt?"
Use **Hook 4** (pre-system-prompt-gen) or **Hooks 37-39** (prompt assembly).
Details: INFERENCE_PIPELINE_MAP.md Section 1.D & 5

### "How can I intercept tool calls?"
Use **Hook 7** (pre-function-defs), **Hook 23** (pre-tool-exec), or **Hook 36** (event).
Details: PLUGIN_HOOKS_QUICK_REFERENCE.md "Tier 2 Hooks"

### "Is it safe to modify messages?"
**Generally no.** Use Hook 1/2 for message modification with heavy validation.
Safer: Use Hooks 4-6 for system prompt, Hook 37-39 for context.
Details: PLUGIN_HOOKS_QUICK_REFERENCE.md "Safety Guidelines"

### "How do I run something in the background?"
Use **Hook 36** (event subscription) - only async safe option currently.
Details: INFERENCE_PIPELINE_MAP.md Section 4

### "What's the safest hook to start with?"
**Hook 36** (event subscription) - read-only, no modification risk.
Details: PLUGIN_HOOKS_QUICK_REFERENCE.md "Quick Start"

---

## Next Steps for Plugin Development

1. **Review this README** to understand the overall structure
2. **Read HOOK_POINTS_VISUAL.txt** for a complete visual overview
3. **Reference PLUGIN_HOOKS_QUICK_REFERENCE.md** for decision making
4. **Use INFERENCE_PIPELINE_MAP.md** for implementation details
5. **Check the source code** at the line numbers provided
6. **Implement safely** with error handling and validation
7. **Test thoroughly** with various inputs and edge cases
8. **Document your hooks** in your plugin code

---

## Document Maintenance

These documents map the inference pipeline as of the current code state. As the codebase evolves:

1. Check line numbers in source files (they may shift)
2. Verify hook availability with actual code
3. Test any assumptions about data availability
4. Report inconsistencies for documentation updates

---

## Summary

Ally's inference pipeline provides **39 distinct insertion points** for plugin logic:
- 23 synchronous hooks (PRE-* and POST-*)
- 12 event subscriptions (for async monitoring)
- 3 prompt assembly hooks (for dynamic injection)

The safest approach is to start with **Hook 36** (event subscription), which provides read-only observation of 12 important events. For active modifications, **Hook 4** (system prompt) is the highest-impact, lowest-risk option.

All hook points are documented with:
- Exact file locations and line numbers
- Available data at that point
- Safe vs dangerous modifications
- Real-world plugin use cases
- Visual flow diagrams
- Implementation guidelines

---

**Last Updated:** November 10, 2024
**Total Hook Points:** 39
**Coverage:** Complete inference pipeline mapping
