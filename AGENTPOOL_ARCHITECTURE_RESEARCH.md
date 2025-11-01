# AgentPoolService Architecture Research

Comprehensive investigation of existing architectural patterns and integration points in the Code Ally codebase for implementing AgentPoolService.

---

## 1. ServiceRegistry Patterns

### Overview
The `ServiceRegistry` is a dependency injection container that manages all application services with lifecycle management and dependency resolution.

**Location:** `/Users/benmoore/CodeAlly-TS/src/services/ServiceRegistry.ts` (lines 1-220)

### Service Registration Patterns

#### Pattern 1: Singleton Registration
```typescript
// From cli.ts (line 359)
registry.registerSingleton<ServiceType>(
  'service_name',
  ServiceClass,
  undefined,  // optional factory function
  dependencies // optional: { 'paramName': 'depServiceName' }
);
```

**Real Examples from cli.ts:**
```typescript
// Instance registration (simplest form)
registry.registerInstance('config_manager', configManager);  // line 359
registry.registerInstance('activity_stream', activityStream);  // line 364
registry.registerInstance('todo_manager', todoManager);  // line 368
registry.registerInstance('token_manager', tokenManager);  // line 558

// Class-based singleton with factory
const focusManager = new FocusManager();
registry.registerInstance('focus_manager', focusManager);  // line 377
```

#### Pattern 2: Service Lifecycle Values
The `ServiceLifecycle` enum defines three lifecycle types:

**Location:** `/Users/benmoore/CodeAlly-TS/src/types/index.ts` (lines 256-260)

```typescript
export enum ServiceLifecycle {
  SINGLETON = 'singleton',      // Single instance, cached after creation
  TRANSIENT = 'transient',      // New instance each time
  SCOPED = 'scoped',            // Scoped to a context (e.g., sub-agents)
}
```

**Usage in ServiceRegistry:**
- **SINGLETON:** `registry.registerSingleton(name, ServiceClass, factory, dependencies)`
- **TRANSIENT:** `registry.registerTransient(name, ServiceClass, factory, dependencies)`
- **INSTANCE:** `registry.registerInstance(name, instance)` - Always acts as singleton

#### Pattern 3: Dependency Declaration
Dependencies are declared as a `Record<string, string>` mapping parameter names to service names:

```typescript
// ServiceRegistry.ts lines 29-41
resolveDepencencies: (registry: ServiceRegistry) => {
  const resolvedDeps: any[] = [];
  if (this.dependencies) {
    for (const [_paramName, serviceName] of Object.entries(this.dependencies)) {
      const dependency = registry.get(serviceName);
      if (!dependency) {
        throw new Error(`Cannot resolve dependency '${serviceName}'...`);
      }
      resolvedDeps.push(dependency);
    }
  }
  // ... create instance with resolved dependencies
}
```

**Example from cli.ts (lines 379-387):**
```typescript
const patchManager = new PatchManager({
  getSessionId: () => sessionManager.getCurrentSession(),
  maxPatchesPerSession: 100,
  maxPatchesSizeBytes: 10 * 1024 * 1024,
});
await patchManager.initialize();
registry.registerInstance('patch_manager', patchManager);
```

#### Pattern 4: Service Retrieval
```typescript
// Get optional service (returns null if not found)
const service = registry.get<ServiceType>('service_name');

// Get required service (throws if not found)
const requiredService = registry.getRequired<ServiceType>('service_name');

// Check if service exists
if (registry.hasService('service_name')) { ... }
```

### Key Files for Integration
- **Main entry point:** `/Users/benmoore/CodeAlly-TS/src/cli.ts` (lines 314-560)
- **ServiceRegistry definition:** `/Users/benmoore/CodeAlly-TS/src/services/ServiceRegistry.ts`
- **Service interface:** `/Users/benmoore/CodeAlly-TS/src/types/index.ts` (lines 262-265)

---

## 2. Tool Result Patterns

### ToolResult Interface
**Location:** `/Users/benmoore/CodeAlly-TS/src/types/index.ts` (lines 81-87)

```typescript
export interface ToolResult {
  success: boolean;              // Whether tool executed successfully
  error: string;                 // Error message (empty if success=true)
  error_type?: ErrorType;        // Specific error category
  suggestion?: string;           // Optional: How to fix/retry
  [key: string]: any;            // Additional fields (tool-specific)
}
```

### Error Types
**Location:** `/Users/benmoore/CodeAlly-TS/src/types/index.ts` (lines 65-79)

```typescript
export type ErrorType =
  | 'validation_error'      // Parameter validation failed
  | 'system_error'          // Unexpected system error
  | 'permission_error'      // User permission denied
  | 'permission_denied'     // Security check failed
  | 'security_error'        // Path security violation
  | 'timeout_error'         // Operation timed out
  | 'command_failed'        // External command failed
  | 'interrupted'           // User interrupted (Ctrl+C)
  | 'interactive_command'   // Requires interactive input
  | 'execution_error'       // Runtime error during execution
  | 'plugin_error'          // Plugin-related error
  | 'user_error'            // Invalid user input
  | 'file_error'            // File I/O error
  | 'general';              // Generic/uncategorized error
```

### Standard Success Response Pattern

**Location:** `/Users/benmoore/CodeAlly-TS/src/tools/BaseTool.ts` (lines 321-327)

```typescript
protected formatSuccessResponse(fields: Record<string, any>): ToolResult {
  return {
    success: true,
    error: '',
    ...fields,
  };
}

// Example usage from AgentTool.ts (lines 123-127)
return this.formatSuccessResponse({
  content: result.result,           // Human-readable output for LLM
  agent_name: result.agent_used,    // Return identifiers/handles
  duration_seconds: result.duration_seconds,
});
```

### Standard Error Response Pattern

**Location:** `/Users/benmoore/CodeAlly-TS/src/tools/BaseTool.ts` (lines 263-313)

```typescript
protected formatErrorResponse(
  errorMessage: string,
  errorType: ErrorType = 'general',
  suggestion?: string,
  additionalFields?: Record<string, any>
): ToolResult {
  // Builds context with tool name and parameters
  // Example: "read(file_path="src/main.ts"): File not found"
  
  const result: ToolResult = {
    success: false,
    error: `${paramContext}${errorMessage}`,
    error_type: errorType,
    ...additionalFields,
  };

  if (suggestion) {
    result.suggestion = suggestion;
  }

  return result;
}

// Example usage from ReadTool (lines 89-93)
return this.formatErrorResponse(
  'file_paths must be a non-empty array',
  'validation_error',
  'Example: read(file_paths=["src/main.ts", "package.json"])'
);
```

### Metadata Fields for Result Tracking

Common fields returned in ToolResult for tracking IDs/handles:

```typescript
// From AgentTool.ts (lines 122-127)
return this.formatSuccessResponse({
  content: result.result,              // Main output for LLM
  agent_name: result.agent_used,       // ID/identifier for the resource
  duration_seconds: result.duration_seconds,  // Metadata
  agent_instance_id: 'agent-xxx',      // Unique handle for tracking
  request_id: 'req-xxx',               // Request tracking ID
});

// Internal-only response (not displayed to user)
protected formatInternalResponse(fields: Record<string, any>): ToolResult {
  return {
    success: true,
    error: '',
    _internal_only: true,               // Flag to prevent display
    ...fields,
  };
}
```

### Tool Result Metadata Patterns

**Location:** `/Users/benmoore/CodeAlly-TS/src/tools/BaseTool.ts` (lines 316-344)

```typescript
// Success response (visible to LLM and user)
success: true,
error: '',
// ... custom fields

// Error response (visible to LLM with error details)
success: false,
error: 'Tool description: Error message',
error_type: 'specific_error_category',
suggestion: 'How to fix or retry',

// Internal response (only available to LLM, not shown to user)
_internal_only: true,
success: true,
error: '',
```

---

## 3. Command Infrastructure

### Command Base Class Pattern

**Location:** `/Users/benmoore/CodeAlly-TS/src/agent/commands/Command.ts` (lines 1-130)

```typescript
export abstract class Command {
  // Required by all commands
  abstract readonly name: string;           // e.g., "/undo", "/clear"
  abstract readonly description: string;   // For help text
  
  // Optional presentation control
  protected readonly useYellowOutput: boolean = false;
  
  // Core execution method
  abstract execute(
    args: string[],
    messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult>;
}
```

### CommandResult Interface

**Location:** `/Users/benmoore/CodeAlly-TS/src/agent/CommandHandler.ts` (lines 42-47)

```typescript
export interface CommandResult {
  handled: boolean;                 // Whether command was handled
  response?: string;                // Response text to display
  updatedMessages?: Message[];      // Modified message history (e.g., undo)
  metadata?: MessageMetadata;       // Presentation hints (isCommandResponse, etc.)
}
```

### Command Registration Pattern

**Location:** `/Users/benmoore/CodeAlly-TS/src/agent/CommandHandler.ts` (lines 49-81)

```typescript
export class CommandHandler {
  private commands: Map<string, Command> = new Map();
  
  constructor(...) {
    // Register class-based commands
    this.registerCommand(new UndoCommand());
    this.registerCommand(new ClearCommand());
    this.registerCommand(new FocusCommand());
    this.registerCommand(new ConfigCommand());
    this.registerCommand(new TodoCommand());
    this.registerCommand(new AgentCommand());
    // ... more commands
  }
  
  private registerCommand(command: Command): void {
    // Strip leading "/" from name and store
    const commandName = command.name.startsWith('/') 
      ? command.name.slice(1) 
      : command.name;
    this.commands.set(commandName, command);
  }
}
```

### Command Handler Routing

**Location:** `/Users/benmoore/CodeAlly-TS/src/agent/CommandHandler.ts` (lines 90-131)

```typescript
async handleCommand(input: string, messages: Message[]): Promise<CommandResult> {
  const parsed = this.parseCommand(input);
  
  if (!parsed) {
    return { handled: false };
  }
  
  const { command, args } = parsed;
  
  // Route to class-based command instance
  const commandInstance = this.commands.get(command);
  if (commandInstance) {
    return await commandInstance.execute(args, messages, this.serviceRegistry);
  }
  
  // Fallback: switch statement for other commands
  switch (command) {
    case 'help': return await this.handleHelp();
    case 'debug': return await this.handleDebug(args, messages);
    case 'context': return await this.handleContext(messages);
    default: return { handled: true, response: `Unknown command: /${command}` };
  }
}
```

### Example Command Implementation: AgentCommand

**Location:** `/Users/benmoore/CodeAlly-TS/src/agent/commands/AgentCommand.ts`

```typescript
export class AgentCommand extends Command {
  readonly name = '/agent';
  readonly description = 'Manage agents';
  
  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // Handle subcommands
    if (args.length === 0) {
      return this.showHelp();
    }
    
    const subcommand = args[0]!;
    const restArgs = args.slice(1);
    
    switch (subcommand.toLowerCase()) {
      case 'create':
        return this.handleCreate(restArgs.join(' '), serviceRegistry);
      case 'ls':
      case 'list':
        return this.handleList(serviceRegistry);
      case 'show':
        return this.handleShow(restArgs.join(' '), serviceRegistry);
      case 'delete':
        return this.handleDelete(restArgs.join(' '), serviceRegistry);
      case 'use':
        return this.handleUse(restArgs.join(' '), serviceRegistry);
      default:
        return {
          handled: true,
          response: `Unknown agent subcommand: ${subcommand}`,
        };
    }
  }
}
```

### Helper Methods from Base Command Class

**Location:** `/Users/benmoore/CodeAlly-TS/src/agent/commands/Command.ts` (lines 49-129)

```typescript
// Create response (applies yellow styling if useYellowOutput=true)
protected createResponse(content: string): CommandResult {
  return {
    handled: true,
    response: content,
    metadata: this.useYellowOutput ? { isCommandResponse: true } : undefined,
  };
}

// Create error response
protected createError(error: string): CommandResult {
  return {
    handled: true,
    response: `Error: ${error}`,
  };
}

// Get required service with error handling
protected getRequiredService<T>(
  serviceRegistry: ServiceRegistry,
  serviceName: string,
  featureName: string
): T | CommandResult {
  const service = serviceRegistry.get<T>(serviceName);
  if (!service) {
    return this.createError(`${featureName} not available`);
  }
  return service;
}

// Emit activity event (for UI integration)
protected emitActivityEvent(
  serviceRegistry: ServiceRegistry,
  eventType: any,
  data: Record<string, any>,
  requestIdPrefix: string = 'cmd'
): CommandResult {
  const activityStream = serviceRegistry.get('activity_stream');
  if (!activityStream || typeof (activityStream as any).emit !== 'function') {
    return this.createError('Activity stream not available');
  }
  
  const requestId = `${requestIdPrefix}_${Date.now()}`;
  (activityStream as any).emit({
    id: requestId,
    type: eventType,
    timestamp: Date.now(),
    data: { requestId, ...data },
  });
  
  return { handled: true };
}
```

---

## 4. Service Cleanup Patterns

### IService Interface (Standard Contract)

**Location:** `/Users/benmoore/CodeAlly-TS/src/types/index.ts` (lines 262-265)

```typescript
export interface IService {
  initialize(): Promise<void>;  // Called after service creation
  cleanup(): Promise<void>;     // Called on app shutdown
}
```

### ServiceRegistry Shutdown

**Location:** `/Users/benmoore/CodeAlly-TS/src/services/ServiceRegistry.ts` (lines 180-209)

```typescript
async shutdown(): Promise<void> {
  // Cleanup IService implementations
  const cleanupPromises: Promise<void>[] = [];
  
  // Clean up registered instances
  for (const [name, instance] of this._services.entries()) {
    if (this.isIService(instance)) {
      cleanupPromises.push(
        instance.cleanup().catch(error => {
          console.error(`Error cleaning up service ${name}:`, error);
        })
      );
    }
  }
  
  // Clean up singleton descriptors
  for (const [name, descriptor] of this._descriptors.entries()) {
    if (descriptor['_instance'] && this.isIService(descriptor['_instance'])) {
      cleanupPromises.push(
        descriptor['_instance'].cleanup().catch(error => {
          console.error(`Error cleaning up service ${name}:`, error);
        })
      );
    }
  }
  
  // Wait for all cleanup to complete
  await Promise.all(cleanupPromises);
  
  // Clear all registrations
  this._services.clear();
  this._descriptors.clear();
}
```

### Helper Method for Type Checking

**Location:** `/Users/benmoore/CodeAlly-TS/src/services/ServiceRegistry.ts` (lines 211-218)

```typescript
private isIService(obj: any): obj is IService {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof obj.initialize === 'function' &&
    typeof obj.cleanup === 'function'
  );
}
```

### Example: SessionManager Cleanup

**Location:** `/Users/benmoore/CodeAlly-TS/src/services/SessionManager.ts` (lines 37-107)

```typescript
export class SessionManager implements IService {
  // ... service state ...
  
  async initialize(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await fs.mkdir(join(this.sessionsDir, '.quarantine'), { recursive: true });
    await this.cleanupTempFiles();
  }
  
  async cleanup(): Promise<void> {
    if (this.titleGenerator) {
      await this.titleGenerator.cleanup?.();
    }
  }
}
```

### Shutdown Integration in CLI

**Location:** `/Users/benmoore/CodeAlly-TS/src/cli.ts` (lines 577-612)

```typescript
// Handle --once mode (single message)
if (options.once) {
  await handleOnceMode(options.once, options, agent, sessionManager);
  await registry.shutdown();  // line 580
  cleanExit(0);
}

// Interactive mode - wait for app exit
const { waitUntilExit } = render(React.createElement(App, {...}), {...});
await waitUntilExit();

// Cleanup on normal exit
await registry.shutdown();  // line 609
cleanExit(0);

// Global exit handlers
process.on('exit', () => {
  if (inkUIStarted) {
    resetTerminalState();
  }
});
```

### Cleanup Error Handling Pattern

The ServiceRegistry uses defensive cleanup:
- Catches errors during individual service cleanup
- Logs errors but continues cleaning remaining services
- Ensures all services attempt cleanup even if some fail
- Clears service registrations at the end

---

## 5. Service Registration Example: Full Flow

### Complete Service Setup in cli.ts (lines 357-559)

```typescript
// Step 1: Create/initialize core services
const registry = ServiceRegistry.getInstance();

// Step 2: Register configuration services
registry.registerInstance('config_manager', configManager);
registry.registerInstance('session_manager', sessionManager);

// Step 3: Create and register activity/event services
const activityStream = new ActivityStream();
registry.registerInstance('activity_stream', activityStream);

// Step 4: Create domain services with dependencies
const todoManager = new TodoManager(activityStream);
registry.registerInstance('todo_manager', todoManager);

// Step 5: Create specialized services
const focusManager = new FocusManager();
registry.registerInstance('focus_manager', focusManager);

// Step 6: Services with initialization
const patchManager = new PatchManager({...});
await patchManager.initialize();
registry.registerInstance('patch_manager', patchManager);

// Step 7: Register LLM clients
registry.registerInstance('model_client', modelClient);
registry.registerInstance('service_model_client', serviceModelClient);

// Step 8: Create tool manager
const toolManager = new ToolManager(allTools, activityStream);
registry.registerInstance('tool_manager', toolManager);

// Step 9: Create main agent with dependencies
const agent = new Agent(
  modelClient,
  toolManager,
  activityStream,
  { config, systemPrompt },
  configManager,
  permissionManager
);
registry.registerInstance('agent', agent);

// Step 10: Register agent's exported services
registry.registerInstance('token_manager', agent.getTokenManager());

// Step 11: Shutdown on exit
await registry.shutdown();
```

---

## 6. Service Integration Points

### Dynamic Service Import Pattern

**Location:** `/Users/benmoore/CodeAlly-TS/src/cli.ts` (lines 374-434)

Services and tools are imported dynamically to enable lazy loading and plugin architecture:

```typescript
// Pattern 1: Service with initialization
const { FocusManager } = await import('./services/FocusManager.js');
const focusManager = new FocusManager();
registry.registerInstance('focus_manager', focusManager);

// Pattern 2: Service requiring config
const { PatchManager } = await import('./services/PatchManager.js');
const patchManager = new PatchManager({
  getSessionId: () => sessionManager.getCurrentSession(),
  maxPatchesPerSession: 100,
});
await patchManager.initialize();
registry.registerInstance('patch_manager', patchManager);

// Pattern 3: Tool registration
const tools = [
  new BashTool(activityStream, config),
  new ReadTool(activityStream, config),
  new WriteTool(activityStream),
  // ... more tools
];

// Pattern 4: Plugin loading
const pluginLoader = new PluginLoader(activityStream, pluginConfigManager);
const { tools: pluginTools } = await pluginLoader.loadPlugins(PLUGINS_DIR);
const allTools = [...tools, ...pluginTools];
```

### Service Dependencies and Configuration

Key patterns for connecting services:

```typescript
// 1. ActivityStream injection (for event emission)
new TodoManager(activityStream)
new ActivityStream() // No dependencies

// 2. Configuration injection
new OllamaClient({
  endpoint: config.endpoint,
  modelName: config.model,
  temperature: config.temperature,
  // ...
})

// 3. Callback-based configuration
const patchManager = new PatchManager({
  getSessionId: () => sessionManager.getCurrentSession(),
  // ... allows dynamic session switching
});

// 4. Lazy initialization
sessionManager.setModelClient(serviceModelClient);  // Set after creation

idleMessageGenerator.setOnQueueUpdated(() => {
  // Trigger auto-save on idle message changes
});
```

---

## Summary: Key Patterns for AgentPoolService

### For ServiceRegistry Integration:
1. **Registration:** Use `registry.registerInstance()` for singletons, `registerSingleton()` for lazy-loaded services
2. **Lifecycle:** Implement `IService` interface if resource cleanup needed
3. **Retrieval:** Use `registry.get<Type>()` for optional, `getRequired<Type>()` for required
4. **Shutdown:** Implement `async cleanup()` for resource cleanup

### For Tool Result Patterns:
1. **Success:** Use `formatSuccessResponse({ custom_fields })`
2. **Errors:** Use `formatErrorResponse(message, errorType, suggestion)`
3. **IDs/Handles:** Return in custom fields: `{ agent_id, handle, instance_id, request_id }`
4. **Internal:** Use `formatInternalResponse()` for LLM-only results

### For Command Infrastructure:
1. **Extend Command** base class with `name`, `description`, and `execute()`
2. **Register** in CommandHandler constructor
3. **Use helpers:** `createResponse()`, `createError()`, `getRequiredService()`, `emitActivityEvent()`
4. **Support subcommands** via argument parsing in execute method

### For Service Cleanup:
1. **Implement IService** if service needs cleanup (connections, file handles, etc.)
2. **Registry calls cleanup()** on all services during shutdown
3. **Handle errors gracefully** - cleanup continues even if some services fail
4. **Call registry.shutdown()** before process exit
