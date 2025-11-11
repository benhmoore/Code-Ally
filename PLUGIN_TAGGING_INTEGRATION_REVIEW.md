# Plugin Tagging System - Comprehensive Integration Review

## Executive Summary

This review examines all integration points for implementing a plugin tagging system in Code Ally. The system will allow users to:
- Designate plugins as "always" loaded (core plugins) vs "tagged" (on-demand activation)
- Use `#plugin-name` syntax to activate specific plugins mid-conversation
- Provide autocomplete for plugin tags
- Persist activation state in sessions

---

## 1. SESSION MANAGEMENT

### Current State
**File**: `/Users/bhm128/code-ally/src/services/SessionManager.ts` (742 lines)

#### Key Findings:
- **Session Storage**: JSON files in `.ally-sessions/` directory
- **Session Interface** (`/src/types/index.ts`, line 299-336):
  ```typescript
  export interface Session {
    id: string;
    name: string;
    created_at: string;
    updated_at: string;
    messages: Message[];
    todos?: Todo[];
    idle_messages?: string[];
    project_context?: ProjectContext;
    metadata?: SessionMetadata;  // Already exists!
  }
  ```

#### Atomic Write Pattern (Line 224-276)
- Uses promise chaining to serialize writes (prevents race conditions)
- Temp file + rename for atomicity
- Write queue managed per session name

#### Auto-Save Method (Line 675-741)
- Saves `messages`, `todos`, `idle_messages`, `project_context`
- Called after user input, tool execution, and text response
- Non-blocking (fire-and-forget)

#### Current Metadata Support (Line 293-297)
```typescript
export interface SessionMetadata {
  title?: string;
  tags?: string[];
  model?: string;
}
```

### Integration Point 1: Active Plugins State

**RECOMMENDATION**: Add to `Session` interface:
```typescript
export interface Session {
  // ... existing fields ...
  active_plugins?: {
    [pluginName: string]: {
      mode: 'always' | 'tagged';
      activated_at: string;
      last_used_at?: string;
    }
  }
}
```

**Changes Required**:
1. Line 158-166: Update `createSession()` to initialize `active_plugins: {}`
2. Line 285-314: Update `saveSession()` to include `active_plugins`
3. Line 427-450: Update `getSessionData()` return type
4. Line 675-741: Update `autoSave()` to accept and save `activePlugins` parameter

**Auto-Save Usage**:
```typescript
await sessionManager.autoSave(
  messages,
  todos,
  idleMessages,
  projectContext,
  activePlugins  // NEW PARAMETER
);
```

---

## 2. PLUGIN CONFIGURATION

### Current State
**Files**: 
- `/Users/bhm128/code-ally/src/plugins/PluginConfigManager.ts` (315 lines)
- `/Users/bhm128/code-ally/src/plugins/PluginLoader.ts` (1073 lines)

#### PluginConfigManager Features:
- Encrypts sensitive fields (AES-256-GCM) at line 39-52
- Saves config to `~/.ally/plugins/{name}/config.json`
- Validates against schema (line 164-193)
- Type coercion support (line 140-159)

#### PluginManifest Structure (Line 43-114):
```typescript
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  tools: ToolDefinition[];
  config?: PluginConfigSchema;
  runtime?: string;
  background?: { /* daemon config */ };
  // ... deprecated fields ...
}
```

#### Tool Definition (Line 119-149):
```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  type?: 'executable' | 'background_rpc';
  // ... command/method details ...
  timeout?: number;
  schema?: any;
  usageGuidance?: string;
}
```

### Integration Point 2: Plugin Activation Mode

**RECOMMENDATION**: Add to `PluginManifest`:
```typescript
export interface PluginManifest {
  // ... existing fields ...
  activation?: {
    mode?: 'always' | 'tagged';  // Default: 'always'
    description?: string;         // For UI: explain what plugin does
  };
}
```

**REASONING**:
- Set by plugin developer in `plugin.json`
- Defines whether plugin loads by default or only when tagged
- Example use cases:
  - `mode: 'always'` - Core utilities, frequently used
  - `mode: 'tagged'` - Domain-specific (AWS, Docker, specialized)

**Changes Required**:
1. PluginLoader.ts line 43-114: Add `activation` field to PluginManifest
2. PluginLoader.ts line 245-344: Update validation to support new field
3. PluginLoader.ts line 825-997: Update `loadPlugin()` to respect activation mode
4. PluginConfigManager.ts: Add method to persist activation preference per session

---

## 3. TOOL LOADING ARCHITECTURE

### Current State
**File**: `/Users/bhm128/code-ally/src/tools/ToolManager.ts` (364 lines)

#### Tool Manager Structure:
```typescript
export class ToolManager {
  private tools: Map<string, BaseTool>;  // All registered tools
  
  getTool(name: string): BaseTool | undefined
  getAllTools(): BaseTool[]
  getFunctionDefinitions(excludeTools?: string[]): FunctionDefinition[]
  executeTool(toolName, args, callId, ...): Promise<ToolResult>
  registerTools(tools: BaseTool[]): void
  registerTool(tool: BaseTool): void
  unregisterTool(toolName: string): void
}
```

#### Key Methods:
- **Line 53-55**: `getTool()` - Simple lookup
- **Line 60-62**: `getAllTools()` - Returns all registered
- **Line 144-159**: `getFunctionDefinitions()` - Already supports `excludeTools` parameter
- **Line 97-101**: `registerTools()` - Runtime registration
- **Line 112-119**: `registerTool()` - Single tool registration
- **Line 129-136**: `unregisterTool()` - Dynamic unregistration

### Integration Point 3: Plugin Tool Filtering

**CURRENT PATTERN** (Line 144-159):
```typescript
getFunctionDefinitions(excludeTools?: string[]): FunctionDefinition[] {
  const functionDefs: FunctionDefinition[] = [];
  const excludeSet = new Set(excludeTools || []);

  for (const tool of this.tools.values()) {
    if (excludeSet.has(tool.name)) continue;
    functionDefs.push(this.generateFunctionDefinition(tool));
  }
  return functionDefs;
}
```

**RECOMMENDATION**: Extend to support filtering by plugin tag:
```typescript
// Add new method
getToolsByActivation(activePlugins: Set<string>): BaseTool[] {
  const result: BaseTool[] = [];
  
  for (const tool of this.tools.values()) {
    // Include if:
    // 1. Not a plugin tool (pluginName is undefined)
    // 2. OR belongs to an active plugin
    if (!tool.pluginName || activePlugins.has(tool.pluginName)) {
      result.push(tool);
    }
  }
  return result;
}

// Add property to BaseTool (already partially in place at line 200)
// Line 200 shows: if (tool.pluginName) - we can leverage this
```

**Changes Required**:
1. BaseTool: Ensure `pluginName` property exists (already does at line 200)
2. ToolManager.ts: Add `getToolsByActivation()` method
3. ToolManager.ts line 144: Update `getFunctionDefinitions()` to accept `activePlugins` param
4. Agent.ts line 667: Pass active plugins when calling `getFunctionDefinitions()`

---

## 4. MESSAGE PROCESSING FLOW

### Current State
**File**: `/Users/bhm128/code-ally/src/agent/Agent.ts` (2243 lines)

#### Core Flow:
1. **Line 369-520**: `sendMessage()` - Main entry point
   - Adds user message to history
   - Saves session
   - Calls `getLLMResponse()`
   - Processes response (tools or text)

2. **Line 662-805**: `getLLMResponse()` 
   - Line 667: Gets function definitions from tool manager
   - Line 766-770: Sends to LLM with functions
   - Line 777-805: Error handling

3. **Line 1073-1225**: `processToolResponse()`
   - Executes tool calls
   - Gets follow-up from LLM

### Integration Point 4: Plugin Tag Parsing

**RECOMMENDATION**: Add to `sendMessage()` at line 393-420 (after adding user message):

```typescript
async sendMessage(message: string): Promise<string> {
  // ... existing setup (line 370-390) ...
  
  // NEW: Parse plugin tags from message
  const parsedTags = this.parsePluginTags(message);
  const activePlugins = await this.updateActivePlugins(parsedTags);
  
  const userMessage: Message = {
    role: 'user',
    content: message,
    timestamp: Date.now(),
    metadata: {
      activatedPlugins: parsedTags,  // Track what was activated
    }
  };
  this.messages.push(userMessage);
  
  // ... rest of method ...
}
```

**New Methods to Add**:
```typescript
private parsePluginTags(message: string): string[] {
  // Find all #plugin-name patterns
  const regex = /#([a-z0-9_-]+)/gi;
  const matches = message.matchAll(regex);
  return Array.from(matches).map(m => m[1]);
}

private async updateActivePlugins(tags: string[]): Promise<Set<string>> {
  const registry = ServiceRegistry.getInstance();
  const sessionManager = registry.get('session_manager');
  const currentSession = sessionManager?.getCurrentSession();
  
  if (!currentSession) return new Set();
  
  // Load existing active plugins
  const session = await sessionManager?.loadSession(currentSession);
  const currentActive = new Set(
    Object.keys(session?.active_plugins || {})
      .filter(p => session?.active_plugins[p].mode === 'always')
  );
  
  // Add tagged plugins
  for (const tag of tags) {
    currentActive.add(tag);
  }
  
  return currentActive;
}
```

**Changes Required**:
1. Agent.ts line 393-420: Add tag parsing and activation logic
2. Agent.ts line 667: Update `getLLMResponse()` to filter tools by active plugins
3. Message metadata: Track which plugins were activated for this message
4. Auto-save: Include `activePlugins` in session state

---

## 5. AUTOCOMPLETE SYSTEM

### Current State
**Files**:
- `/Users/bhm128/code-ally/src/services/CompletionProvider.ts` (150+ lines shown)
- `/Users/bhm128/code-ally/src/ui/components/InputPrompt.tsx` (150+ lines shown)

#### Completion System:
1. **Line 42-61 in CompletionProvider**: SLASH_COMMANDS array
2. **Line 66-76**: AGENT_SUBCOMMANDS array
3. **Line 81-85**: PLUGIN_SUBCOMMANDS array (exists!)
4. **Line 150+**: `getCompletions()` method (not shown in excerpt)

#### CompletionContext (Line 30-37):
```typescript
export interface CompletionContext {
  input: string;
  cursorPosition: number;
  wordStart: number;
  wordEnd: number;
  currentWord: string;
  lineStart: string;
}
```

#### InputPrompt State Management:
- Uses `CompletionDropdown` component
- Tracks cursor position for @filepath completions
- History navigation (up/down arrows)

### Integration Point 5: Plugin Tag Autocomplete

**CURRENT @-COMPLETION PATTERN**:
- Line 124-139 in InputPrompt.tsx: Initial component setup
- CompletionProvider.ts: Uses `FuzzyFilePathMatcher` for @ completion

**RECOMMENDATION**: Add # autocomplete parallel to @ autocomplete:

```typescript
// In CompletionProvider.ts - add method:
private getPluginCompletions(
  context: CompletionContext,
  allPlugins: Map<string, PluginInfo>
): Completion[] {
  // Find # prefix in input
  const hashIndex = context.input.lastIndexOf('#');
  if (hashIndex === -1 || hashIndex > context.cursorPosition) {
    return [];
  }
  
  const word = context.input.substring(hashIndex + 1, context.cursorPosition);
  
  // Fuzzy match against plugin names
  const matches = Array.from(allPlugins.entries())
    .filter(([name]) => name.startsWith(word))
    .map(([name, info]) => ({
      value: name,
      description: info.description,
      type: 'plugin' as CompletionType,
      insertText: name + ' ',  // Add space after plugin name
    }));
  
  return matches;
}

// In getCompletions() method - add:
const hashMatch = this.isInHashContext(context);
if (hashMatch) {
  const pluginCompletions = await this.getPluginCompletions(context, allPlugins);
  return pluginCompletions;
}
```

**Changes Required**:
1. CompletionProvider.ts: Add plugin completion methods
2. CompletionProvider.ts: Add `PluginLoader` dependency to fetch active plugins
3. InputPrompt.tsx: Handle # prefix for plugin completion (similar to @ for files)
4. CompletionDropdown.tsx: Ensure it handles 'plugin' type completions

---

## 6. COMMAND SYSTEM

### Current State
**Files**:
- `/Users/bhm128/code-ally/src/agent/commands/PluginCommand.ts` (200+ lines shown)
- `/Users/bhm128/code-ally/src/agent/commands/AgentCommand.ts` (200+ lines shown)
- Pattern established in `/src/agent/commands/Command.ts`

#### Existing Command Pattern:

**AgentCommand.ts** (for reference):
```typescript
export class AgentCommand extends Command {
  readonly name = '/agent';
  readonly description = 'Manage agents and agent pool';
  
  async execute(args, messages, serviceRegistry): Promise<CommandResult> {
    const subcommand = args[0];
    switch (subcommand.toLowerCase()) {
      case 'active':
        return this.handleActive(serviceRegistry);
      case 'stats':
        return this.handleStats(serviceRegistry);
      // ... etc
    }
  }
  
  private async handleActive(serviceRegistry): Promise<CommandResult> {
    // Implementation
  }
}
```

**PluginCommand.ts** (line 25-66):
```typescript
export class PluginCommand extends Command {
  readonly name = '/plugin';
  
  async execute(args, messages, serviceRegistry): Promise<CommandResult> {
    const subcommand = parts[0];
    
    if (subcommand.toLowerCase() === 'config') {
      return this.handlePluginConfig(pluginName, serviceRegistry);
    }
    if (subcommand.toLowerCase() === 'install') {
      return this.handlePluginInstall(pluginPath, serviceRegistry);
    }
    if (subcommand.toLowerCase() === 'uninstall') {
      return this.handlePluginUninstall(pluginName, serviceRegistry);
    }
  }
}
```

### Integration Point 6: Plugin Activation Commands

**RECOMMENDATION**: Extend PluginCommand with new subcommands:

```typescript
export class PluginCommand extends Command {
  readonly name = '/plugin';
  
  async execute(args, messages, serviceRegistry): Promise<CommandResult> {
    const subcommand = parts[0];
    
    if (subcommand.toLowerCase() === 'config') {
      // ... existing
    } else if (subcommand.toLowerCase() === 'install') {
      // ... existing
    } else if (subcommand.toLowerCase() === 'uninstall') {
      // ... existing
    } else if (subcommand.toLowerCase() === 'activate') {
      // NEW
      return this.handleActivatePlugin(pluginName, serviceRegistry);
    } else if (subcommand.toLowerCase() === 'deactivate') {
      // NEW
      return this.handleDeactivatePlugin(pluginName, serviceRegistry);
    } else if (subcommand.toLowerCase() === 'active' || subcommand === 'list') {
      // NEW
      return this.handleListActivePlugins(serviceRegistry);
    }
  }
  
  private async handleActivatePlugin(
    pluginName: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const sessionManager = serviceRegistry.get('session_manager');
    const currentSession = sessionManager?.getCurrentSession();
    
    if (!currentSession) {
      return this.createError('No active session');
    }
    
    // Load session
    const session = await sessionManager?.loadSession(currentSession);
    if (!session) {
      return this.createError(`Session ${currentSession} not found`);
    }
    
    // Update active plugins
    if (!session.active_plugins) session.active_plugins = {};
    session.active_plugins[pluginName] = {
      mode: 'tagged',
      activated_at: new Date().toISOString(),
    };
    
    // Save session
    await sessionManager?.saveSessionData(currentSession, session);
    
    return this.createResponse(`✓ Plugin '${pluginName}' activated`);
  }
  
  private async handleDeactivatePlugin(
    pluginName: string,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // Similar to activate, but removes from active_plugins
  }
  
  private async handleListActivePlugins(
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // List all active plugins in current session
  }
}
```

**Commands to Support**:
- `/plugin activate <name>` - Manually activate a plugin
- `/plugin deactivate <name>` - Manually deactivate
- `/plugin active` or `/plugin list` - Show currently active plugins
- `/plugin config <name>` - Configure plugin (existing)
- `/plugin install <path>` - Install plugin (existing)

---

## 7. CORE VS PLUGIN TOOLS

### Current State

**Tool Identification**:
- BaseTool interface: Already has `pluginName` property (seen at ToolManager.ts line 200)
- Built-in tools: No `pluginName` set
- Plugin tools: Set `pluginName` during loading

**ToolManager.ts line 194-226** (Usage Guidance):
```typescript
getToolUsageGuidance(): string[] {
  const guidances: string[] = [];
  
  for (const tool of this.tools.values()) {
    if (tool.usageGuidance) {
      // If tool has a plugin name, prepend it to the first line
      if (tool.pluginName) {
        // ... modify guidance to show "(from plugin: X)"
      } else {
        // Built-in tool - use guidance as-is
      }
    }
  }
  return guidances;
}
```

### Integration Point 7: Plugin Tool Detection

**CURRENT PATTERN**:
- Plugin tools already tagged with `pluginName` during loading
- ToolManager already can distinguish them (line 200)

**RECOMMENDATION**: Enhance BaseTool interface:
```typescript
export class BaseTool {
  name: string;
  description: string;
  pluginName?: string;           // Existing
  pluginActivationMode?: 'always' | 'tagged';  // NEW
  
  // ... other methods ...
}
```

**Changes Required**:
1. ExecutableToolWrapper.ts: Set `pluginActivationMode` during tool creation
2. BackgroundToolWrapper.ts: Set `pluginActivationMode` during tool creation
3. ToolManager.ts: Use this property in filtering logic

---

## 8. PLUGIN INSTALLATION FLOW

### Current State
**File**: `/Users/bhm128/code-ally/src/plugins/PluginLoader.ts` (1073 lines)

#### Installation Process (Line 375-511):
```typescript
async installFromPath(
  sourcePath: string,
  pluginsDir: string
): Promise<{
  success: boolean;
  pluginName?: string;
  tools?: BaseTool[];
  error?: string;
  hadExistingConfig?: boolean;
}> {
  // 1. Validate source path exists
  // 2. Read and validate manifest
  // 3. Check if plugin already exists (preserve config)
  // 4. Copy plugin directory
  // 5. Restore saved config
  // 6. Load plugin (triggers dependency install)
  // 7. Register tools with ToolManager
}
```

#### Manifest Validation (Line 245-344):
```typescript
private validatePluginManifest(manifest: PluginManifest): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Required fields
  if (!manifest.name) errors.push(...);
  if (!manifest.version) errors.push(...);
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) 
    errors.push(...);
  
  // Background config validation
  if (manifest.background?.enabled) { /* ... */ }
  
  // Tool validation
  manifest.tools?.forEach((tool, index) => { /* ... */ });
  
  return { valid: errors.length === 0, errors, warnings };
}
```

#### Pending Config System (Line 187-191, 351-363):
```typescript
let pendingConfigRequests: Array<{
  pluginName: string;
  pluginPath: string;
  schema: PluginConfigSchema;
}> = [];

static getPendingConfigRequest() {
  if (pendingConfigRequests.length === 0) return null;
  return pendingConfigRequests.shift() || null;
}
```

### Integration Point 8: Activation Mode Configuration

**RECOMMENDATION**: Add wizard question during setup:

**Changes Required**:
1. Plugin wizard (SetupWizardView or new PluginSetupWizardView)
2. After loading config schema, ask: "Should this plugin be loaded always or only when tagged?"
3. Store answer in config or manifest preference
4. Update `PluginConfigManager` to persist this per-session or per-plugin

**Changes to `installFromPath()`**:
```typescript
async installFromPath(
  sourcePath: string,
  pluginsDir: string,
  userPreferences?: { activationMode: 'always' | 'tagged' }  // NEW
): Promise<InstallResult> {
  // ... existing validation ...
  
  // NEW: After config is loaded/requested
  if (manifest.config) {
    // Emit PLUGIN_ACTIVATION_MODE_REQUEST event
    return this.emitActivityEvent({
      type: ActivityEventType.PLUGIN_ACTIVATION_MODE_REQUEST,
      data: {
        pluginName: manifest.name,
        pluginPath: targetPath,
        suggestedMode: manifest.activation?.mode || 'always',
      }
    });
  }
  
  // ... rest of installation ...
}
```

**New Event Type** (in ActivityEventType enum):
```typescript
export enum ActivityEventType {
  // ... existing ...
  PLUGIN_ACTIVATION_MODE_REQUEST = 'plugin_activation_mode_request',
  // ... existing ...
}
```

---

## 9. CLI INITIALIZATION

### Current State
**File**: `/Users/bhm128/code-ally/src/cli.ts` (1200+ lines)

#### Plugin Loading Sequence (Line 535-562):
```typescript
// 1. Create PluginLoader
const pluginLoader = new PluginLoader(/* ... */);
registry.registerInstance('plugin_loader', pluginLoader);

// 2. Load all plugins from PLUGINS_DIR
const { tools: pluginTools, pluginCount } = await pluginLoader.loadPlugins(PLUGINS_DIR);

// 3. Start background plugin daemons
await pluginLoader.startBackgroundPlugins();

// 4. Merge with built-in tools
const allTools = [...tools, ...pluginTools];

// 5. Create ToolManager
const toolManager = new ToolManager(allTools, activityStream);
registry.registerInstance('tool_manager', toolManager);
```

### Integration Point 9: Session-Based Plugin Activation

**RECOMMENDATION**: Add post-loading setup:

```typescript
// After creating ToolManager and Agent
const agent = new Agent(modelClient, toolManager, activityStream, config);

// NEW: Load session and activate plugins
const sessionManager = registry.get('session_manager');
const currentSession = sessionManager?.getCurrentSession();

if (currentSession) {
  const session = await sessionManager?.loadSession(currentSession);
  
  if (session?.active_plugins) {
    // Filter tools based on session's active plugins
    const activePluginNames = Object.keys(
      session.active_plugins
    ).filter(name => 
      session.active_plugins[name].mode === 'always' ||
      session.active_plugins[name].activated_at  // has been tagged
    );
    
    // Re-initialize agent with filtered tool set
    // This ensures LLM only sees active plugins
  }
}
```

---

## 10. SUMMARY TABLE: Files and Changes Required

| File | Current Lines | Integration Point | Changes | Priority |
|------|---------------|-------------------|---------|----------|
| `/src/types/index.ts` | 299-336 | Session interface | Add `active_plugins` field to Session | HIGH |
| `/src/services/SessionManager.ts` | 158-741 | Session state | Update methods to handle `active_plugins` | HIGH |
| `/src/plugins/PluginLoader.ts` | 43-1073 | Plugin config | Add `activation` field to PluginManifest | HIGH |
| `/src/tools/ToolManager.ts` | 53-363 | Tool filtering | Add `getToolsByActivation()` method | HIGH |
| `/src/agent/Agent.ts` | 369-520 | Message parsing | Add `parsePluginTags()` and `updateActivePlugins()` | HIGH |
| `/src/agent/commands/PluginCommand.ts` | 25-230+ | Plugin commands | Add activate/deactivate/active subcommands | HIGH |
| `/src/services/CompletionProvider.ts` | 111-400+ | Autocomplete | Add `getPluginCompletions()` method | MEDIUM |
| `/src/ui/components/InputPrompt.tsx` | 92-400+ | UI input | Handle # prefix for plugin completion | MEDIUM |
| `/src/plugins/ExecutableToolWrapper.ts` | N/A | Tool creation | Set `pluginActivationMode` property | MEDIUM |
| `/src/plugins/BackgroundToolWrapper.ts` | N/A | Tool creation | Set `pluginActivationMode` property | MEDIUM |
| `/src/cli.ts` | 535-562 | Initialization | Filter tools based on session plugins | MEDIUM |
| `/src/types/ActivityEventType.ts` | N/A | Events | Add PLUGIN_ACTIVATION_MODE_REQUEST | LOW |

---

## 11. IMPLEMENTATION GAPS & CHALLENGES

### Challenge 1: Message Parsing Context
**Issue**: Distinguishing between #hashtags and #plugin-names
**Solutions**:
- Require strict format: `#plugin-name` (alphanumeric, hyphens, underscores only)
- Validate against known plugin names during parsing
- Use different prefix if needed (e.g., `:plugin-name`)

### Challenge 2: LLM Model Context
**Issue**: If we filter tools dynamically, model won't know about them
**Solutions**:
- Always include tool definitions in system prompt comment explaining what's available
- OR inject reminder about tagging syntax: "Use #plugin-name to activate specialized tools"
- Keep full tool list in system prompt but filter function calling

### Challenge 3: Session Persistence Across Contexts
**Issue**: Plugin activation state tied to session, but what about CLI restarts?
**Solutions**:
- Always restore from session state on startup
- Option to save "always active" plugins to config
- Clear distinction: session-scoped vs app-scoped activation

### Challenge 4: Backward Compatibility
**Issue**: Existing plugins don't have `activation` mode defined
**Solutions**:
- Default to `mode: 'always'` if not specified
- Manifest validation should not fail if field missing
- Provide migration guide for plugin developers

### Challenge 5: Tag Activation Mid-Conversation
**Issue**: Activating #plugin during conversation changes what tools LLM can use
**Solutions**:
- Inject system message explaining activation: "Plugin X just became available"
- Include new tool definitions in next LLM request
- Track activation timing for audit trail

---

## 12. RECOMMENDED IMPLEMENTATION ORDER

### Phase 1: Foundation (Days 1-2)
1. Add `active_plugins` to Session interface
2. Update SessionManager to persist active plugins
3. Add `activation` mode to PluginManifest
4. Update PluginLoader validation

### Phase 2: Core Logic (Days 2-3)
1. Add plugin tag parsing to Agent.ts
2. Implement `getToolsByActivation()` in ToolManager
3. Add activation mode to ToolDefinition
4. Update Agent's getLLMResponse() to filter tools

### Phase 3: Commands & UI (Days 3-4)
1. Add `/plugin activate|deactivate|active` commands
2. Add # autocomplete to CompletionProvider
3. Update InputPrompt.tsx to show completions
4. Add CLI initialization to load session plugins

### Phase 4: Polish (Day 4-5)
1. Add configuration wizard for first-time setup
2. Add help and documentation
3. Test edge cases (tag validation, session restore)
4. Performance testing with many plugins

---

## 13. KEY CODE PATTERNS TO FOLLOW

### Pattern 1: Service Registry Usage (Established)
```typescript
const registry = ServiceRegistry.getInstance();
const sessionManager = registry.get('session_manager');
const toolManager = registry.get('tool_manager');
const pluginLoader = registry.get('plugin_loader');
```

### Pattern 2: Command Implementation (Established)
```typescript
// In AgentCommand.ts and PluginCommand.ts
async execute(args, messages, serviceRegistry): Promise<CommandResult> {
  const subcommand = args[0];
  switch (subcommand.toLowerCase()) {
    case 'action': return this.handleAction(serviceRegistry);
  }
}

private async handleAction(registry): Promise<CommandResult> {
  return this.createResponse('Success message');
  // or
  return this.createError('Error message');
  // or
  return this.emitActivityEvent(registry, EventType, data, id);
}
```

### Pattern 3: Session Management (Established)
```typescript
const sessionManager = registry.get('session_manager');
const currentSession = sessionManager.getCurrentSession();
const session = await sessionManager.loadSession(currentSession);
session.active_plugins = { /* ... */ };
await sessionManager.saveSessionData(currentSession, session);
```

### Pattern 4: Atomic Operations (Established)
```typescript
// Promise chaining pattern in SessionManager.ts
const existingWrite = this.writeQueue.get(sessionName);
const writePromise = (async () => {
  if (existingWrite) await existingWrite.catch(() => {});
  // Perform operation
})();
this.writeQueue.set(sessionName, writePromise);
await writePromise;
```

---

## 14. TESTING RECOMMENDATIONS

### Unit Tests
- Plugin tag parsing: valid/invalid formats
- Session persistence: save/load active plugins
- Tool filtering: correct tools included/excluded
- Command execution: activate/deactivate operations

### Integration Tests
- Full flow: parse tags → activate → filter tools → LLM sees new tools
- Session restore: restart CLI and verify plugins remain active
- Backward compat: old sessions without active_plugins

### End-to-End Tests
- User workflow: type message with #tag → plugin activates → model uses tool
- Persistence: activate plugin → exit → restart → plugin still active
- Cleanup: deactivate all plugins → tools removed from LLM context

---

## Conclusion

The codebase has strong foundational patterns for:
- Session persistence (atomic writes, auto-save)
- Plugin architecture (manifest validation, tool wrapping)
- Tool management (registration, function definitions)
- Command system (consistent subcommand patterns)
- UI/autocomplete (completion provider, context-aware suggestions)

The plugin tagging system fits naturally into these existing patterns. The main integration points are:
1. **Session storage** - track active plugins
2. **Plugin manifest** - define activation mode
3. **Tool filtering** - show only active tools to LLM
4. **Message parsing** - detect #tags in user input
5. **Commands** - activate/deactivate plugins
6. **Autocomplete** - suggest plugin tags

The implementation should be straightforward with careful attention to session restoration and backward compatibility.
