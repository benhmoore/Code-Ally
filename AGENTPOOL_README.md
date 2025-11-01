# AgentPoolService Architecture Research

Complete architectural investigation for implementing concurrent agent pooling in Code Ally.

## Documents Overview

### 1. AGENTPOOL_RESEARCH_SUMMARY.txt (Quick Start)
**Size:** 3.9 KB | **Format:** Plain text  
**Purpose:** Executive summary with key findings and implementation checklist

Quick reference with:
- Key findings from the architecture investigation
- File locations and line numbers
- Implementation checklist for all components
- Next steps guide

**Read this first** to get oriented.

---

### 2. AGENTPOOL_ARCHITECTURE_RESEARCH.md (Detailed Reference)
**Size:** 21 KB | **Format:** Markdown  
**Purpose:** Complete patterns extracted from existing codebase

Comprehensive coverage of:
- **ServiceRegistry Patterns** (Section 1)
  - Registration methods with real examples
  - Lifecycle values (SINGLETON, TRANSIENT, SCOPED)
  - Dependency declaration
  - Service retrieval patterns
  
- **Tool Result Patterns** (Section 2)
  - ToolResult interface definition
  - Error types
  - Success/error response formatting
  - Metadata fields for ID/handle tracking
  
- **Command Infrastructure** (Section 3)
  - Command base class pattern
  - CommandResult interface
  - Registration and routing
  - Example implementation (AgentCommand)
  - Helper methods
  
- **Service Cleanup Patterns** (Section 4)
  - IService interface contract
  - ServiceRegistry shutdown mechanism
  - Error handling during cleanup
  - Integration in cli.ts
  
- **Service Registration Flow** (Section 5)
  - Complete step-by-step service setup
  - All 11 steps with examples
  
- **Integration Points** (Section 6)
  - Dynamic imports and lazy loading
  - Dependency injection patterns
  - Service configuration patterns

Every pattern includes:
- File path and line numbers
- Code examples
- Real usage from existing services

**Reference this** for detailed pattern documentation.

---

### 3. AGENTPOOL_INTEGRATION_GUIDE.md (Implementation Template)
**Size:** 16 KB | **Format:** Markdown  
**Purpose:** Ready-to-use code templates following Code Ally patterns

Complete implementation templates:
- **Section 1:** AgentPoolService class template
  - Full IService implementation
  - submitTask() method
  - Concurrent execution with queue
  - Timeout handling
  - Auto-cleanup
  
- **Section 2:** AgentPoolTool integration
  - Extends BaseTool
  - FunctionDefinition for LLM
  - ToolResult formatting
  - Error handling
  
- **Section 3:** CLI integration code
  - Exact placement in cli.ts
  - Service creation and initialization
  - Registry registration
  - Shutdown integration
  
- **Section 4:** Optional command integration
  - PoolCommand class template
  - Subcommand routing
  - Status and management commands
  
- **Section 5:** ToolResult patterns
  - Success response examples
  - Error response examples
  - Handle tracking patterns
  
- **Section 6:** Testing patterns
  - vitest test templates
  - Test cases for core functionality
  - Mock setup

All code is production-ready and follows existing Code Ally conventions.

**Copy from this** for implementation.

---

### 4. AGENTPOOL_ARCHITECTURE_DIAGRAM.txt (Visual Reference)
**Size:** 14 KB | **Format:** ASCII diagrams  
**Purpose:** Visual architecture and flow diagrams

Includes:
- **CLI Entry Point Flow** - High-level service setup sequence
- **Service Architecture** - How AgentPoolService, Tool, and Command connect
- **Execution Lifecycle** - Complete flow from user message to task completion
- **ToolResult Flow** - Data format and transformation through the pipeline
- **Concurrent Execution Timeline** - Example with multiple tasks and agents
- **Service Lifecycle Pattern** - Creation through cleanup sequence
- **Integration Points** - Key locations for each component

Visual diagrams help understand:
- Component relationships
- Data flow
- Execution sequence
- Timing and concurrency

**Look at this** to visualize the architecture.

---

## How to Use These Documents

### For Quick Understanding
1. Read **AGENTPOOL_RESEARCH_SUMMARY.txt** (5 min)
2. View **AGENTPOOL_ARCHITECTURE_DIAGRAM.txt** (5 min)
3. Browse **AGENTPOOL_ARCHITECTURE_RESEARCH.md** summaries (10 min)

### For Implementation
1. Use **AGENTPOOL_INTEGRATION_GUIDE.md** as primary reference
2. Copy code templates and adapt for your needs
3. Reference specific patterns from **AGENTPOOL_ARCHITECTURE_RESEARCH.md**
4. Use **AGENTPOOL_ARCHITECTURE_DIAGRAM.txt** for design verification

### For Details
1. Deep dive into **AGENTPOOL_ARCHITECTURE_RESEARCH.md** sections
2. Check exact file paths and line numbers for patterns
3. Verify existing code matches patterns described

---

## Key Files Referenced

All documents include specific file paths and line numbers:

**Core Infrastructure:**
- `/Users/benmoore/CodeAlly-TS/src/services/ServiceRegistry.ts` (lines 1-220)
- `/Users/benmoore/CodeAlly-TS/src/cli.ts` (lines 314-560)
- `/Users/benmoore/CodeAlly-TS/src/types/index.ts` (lines 256-265)

**Tools and Commands:**
- `/Users/benmoore/CodeAlly-TS/src/tools/BaseTool.ts` (lines 200-344)
- `/Users/benmoore/CodeAlly-TS/src/agent/commands/Command.ts` (lines 1-130)
- `/Users/benmoore/CodeAlly-TS/src/agent/CommandHandler.ts` (lines 42-131)

**Example Services:**
- `/Users/benmoore/CodeAlly-TS/src/services/SessionManager.ts` (lines 37-107)
- `/Users/benmoore/CodeAlly-TS/src/services/TodoManager.ts`
- `/Users/benmoore/CodeAlly-TS/src/agent/Agent.ts`

---

## Implementation Checklist

From AGENTPOOL_RESEARCH_SUMMARY.txt:

### Service Implementation
- [ ] Create AgentPoolService class implementing IService
- [ ] Implement initialize() for setup
- [ ] Implement cleanup() for shutdown
- [ ] Add submitTask(agentConfig, message) method
- [ ] Return PooledAgentHandle with pool_id
- [ ] Implement concurrent execution (max agents)
- [ ] Add task queuing (max queue size)
- [ ] Implement timeout handling
- [ ] Add result caching with auto-cleanup

### Tool Integration
- [ ] Create AgentPoolTool extending BaseTool
- [ ] Implement getFunctionDefinition()
- [ ] Use formatSuccessResponse()
- [ ] Use formatErrorResponse()
- [ ] Return pool_ids for tracking
- [ ] Support wait_for_completion parameter

### CLI Integration
- [ ] Import service in cli.ts
- [ ] Create instance with config
- [ ] Call initialize()
- [ ] Register in ServiceRegistry
- [ ] Add tool to tools array
- [ ] Register cleanup via registry.shutdown()

### Testing
- [ ] Test unique pool ID generation
- [ ] Test queuing when at capacity
- [ ] Test rejection when queue full
- [ ] Test concurrent execution
- [ ] Test timeout handling
- [ ] Test cleanup

### Optional Command
- [ ] Create PoolCommand
- [ ] Add status subcommand
- [ ] Add clear subcommand
- [ ] Register in CommandHandler

---

## Architecture Summary

### Service Registration Pattern
```
registry.registerInstance('service_name', serviceInstance)
registry.get<ServiceType>('service_name')
registry.shutdown()  // Calls cleanup() on all IService implementations
```

### Tool Result Pattern
```typescript
// Success
formatSuccessResponse({ custom_fields })
// Error
formatErrorResponse(message, errorType, suggestion)
// Both return ToolResult { success, error, error_type, ...custom }
```

### Service Lifecycle
```
new Service() → initialize() → register in registry → cleanup() on shutdown
```

### Command Pattern
```
extends Command → implement execute() → register in CommandHandler
```

---

## Quick Reference

**ServiceRegistry Methods:**
- `registerInstance(name, instance)` - Register singleton
- `registerSingleton(name, Class, factory, deps)` - Lazy-loaded singleton
- `registerTransient(name, Class, factory, deps)` - New instance each time
- `get<T>(name)` - Retrieve optional service (returns null)
- `getRequired<T>(name)` - Retrieve required service (throws)
- `hasService(name)` - Check if service exists
- `shutdown()` - Call cleanup() on all services

**IService Interface:**
```typescript
interface IService {
  initialize(): Promise<void>;
  cleanup(): Promise<void>;
}
```

**ToolResult Interface:**
```typescript
interface ToolResult {
  success: boolean;
  error: string;
  error_type?: ErrorType;
  suggestion?: string;
  [key: string]: any;  // Custom fields
}
```

**Error Types:**
validation_error, system_error, permission_error, security_error, timeout_error, command_failed, interrupted, execution_error, etc.

---

## Next Steps

1. **Start Here:** Read AGENTPOOL_RESEARCH_SUMMARY.txt
2. **Understand Design:** View AGENTPOOL_ARCHITECTURE_DIAGRAM.txt
3. **Get Details:** Read AGENTPOOL_ARCHITECTURE_RESEARCH.md
4. **Implement:** Use AGENTPOOL_INTEGRATION_GUIDE.md
5. **Test:** Follow testing patterns
6. **Integrate:** Register in cli.ts following pattern
7. **Verify:** Check against AGENTPOOL_ARCHITECTURE_RESEARCH.md patterns

---

## Document Statistics

- **Total Pages:** ~60 pages (if printed)
- **Code Examples:** 50+
- **File References:** 20+ with exact line numbers
- **Diagrams:** 10 ASCII flow diagrams
- **Coverage:** Complete architecture patterns + integration guide

All documents are self-contained and cross-referenced.

---

Created: October 31, 2025
Last Updated: October 31, 2025
