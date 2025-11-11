# Plugin Tagging System - Implementation Plan

**Status**: Ready for Implementation
**Last Updated**: 2025-11-11
**Complexity**: Medium-High (4-5 days)

---

## Executive Summary

Implement a plugin tagging system to reduce tool pollution by allowing selective plugin activation. Users can configure plugins as "always enabled" or "only when tagged" (#PluginName syntax). Core tools remain always loaded.

### Key Requirements
- Binary activation modes: "always" vs "tagged" (set during plugin install)
- Tag syntax: `#plugin-name` to activate plugins in messages
- Once activated, plugins stay active for entire conversation
- Commands: `/plugin active`, `/plugin activate <name>`, `/plugin deactivate <name>`
- Core tools always loaded regardless of plugin state
- Session persistence of active plugins

### Success Criteria
- ✅ Reduces initial tool context by only loading relevant plugin tools
- ✅ Preserves backward compatibility (defaults to "always" mode)
- ✅ Seamless UX with autocomplete and feedback
- ✅ Session persistence works correctly

---

## Phase 1: Foundation - Data Model Changes

### 1.1 Update Session Type (SessionManager.ts)

**File**: `src/agent/SessionManager.ts`
**Lines**: 30-42 (Session interface)

**Changes**:
```typescript
export interface Session {
  id: string;
  title: string;
  messages: Message[];
  tags: string[];
  active_plugins: string[];  // NEW: Track active plugin names per session
  created: Date;
  updated: Date;
  model?: string;
}
```

**Integration Points**:
- Add `active_plugins: []` to default session creation (line 158)
- Update `save()` method to persist active_plugins (line 223)
- Update `load()` method to restore active_plugins (line 265)
- Ensure atomic writes via promise chaining (existing pattern, lines 223-241)

**Testing**:
- Verify session saves with active_plugins
- Verify session loads with active_plugins
- Verify backward compat (old sessions without field)

---

### 1.2 Update Plugin Manifest (PluginLoader.ts)

**File**: `src/plugins/PluginLoader.ts`
**Lines**: 43-114 (PluginManifest interface)

**Changes**:
```typescript
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  activationMode?: 'always' | 'tagged';  // NEW: Default to 'always' if not specified
  // ... existing fields
}
```

**Integration Points**:
- Update manifest validation (lines 115-272)
- Add default `activationMode: 'always'` if not specified (backward compat)
- Update plugin installation wizard to ask about activation mode (lines 375-511)

**Wizard Addition** (around line 430):
```typescript
// After description is collected
const activationResponse = await configRequest({
  type: 'choice',
  message: 'When should this plugin be active?',
  choices: [
    {
      label: 'Always (load tools in every conversation)',
      value: 'always'
    },
    {
      label: 'Only when tagged (use #plugin-name to activate)',
      value: 'tagged'
    }
  ]
});

manifest.activationMode = activationResponse.value as 'always' | 'tagged';
```

**Testing**:
- Install new plugin with "always" mode
- Install new plugin with "tagged" mode
- Reinstall existing plugin (should preserve existing mode)
- Load plugin without activationMode field (should default to "always")

---

### 1.3 Create PluginActivationManager (New Service)

**File**: `src/plugins/PluginActivationManager.ts` (NEW)

**Purpose**: Centralized service to manage plugin activation state

**Implementation**:
```typescript
export class PluginActivationManager {
  private activePlugins: Set<string> = new Set();
  private pluginManifests: Map<string, PluginManifest> = new Map();

  constructor(
    private pluginLoader: PluginLoader,
    private sessionManager: SessionManager
  ) {}

  /**
   * Initialize from session state
   */
  async initialize(): Promise<void> {
    const session = this.sessionManager.getCurrentSession();
    if (session?.active_plugins) {
      session.active_plugins.forEach(name => this.activePlugins.add(name));
    }

    // Load all plugin manifests
    const plugins = this.pluginLoader.getLoadedPlugins();
    plugins.forEach(plugin => {
      this.pluginManifests.set(plugin.name, plugin.manifest);
    });

    // Auto-activate "always" mode plugins
    this.pluginManifests.forEach((manifest, name) => {
      if (manifest.activationMode === 'always' || !manifest.activationMode) {
        this.activePlugins.add(name);
      }
    });
  }

  /**
   * Activate plugin by name
   */
  activate(pluginName: string): boolean {
    if (!this.pluginManifests.has(pluginName)) {
      return false; // Plugin not installed
    }

    this.activePlugins.add(pluginName);
    this.saveToSession();
    return true;
  }

  /**
   * Deactivate plugin by name (only if in "tagged" mode)
   */
  deactivate(pluginName: string): boolean {
    const manifest = this.pluginManifests.get(pluginName);
    if (manifest?.activationMode === 'always') {
      return false; // Cannot deactivate "always" plugins
    }

    this.activePlugins.delete(pluginName);
    this.saveToSession();
    return true;
  }

  /**
   * Check if plugin is active
   */
  isActive(pluginName: string): boolean {
    return this.activePlugins.has(pluginName);
  }

  /**
   * Get list of active plugins
   */
  getActivePlugins(): string[] {
    return Array.from(this.activePlugins);
  }

  /**
   * Get list of installed plugin names
   */
  getInstalledPlugins(): string[] {
    return Array.from(this.pluginManifests.keys());
  }

  /**
   * Get activation mode for plugin
   */
  getActivationMode(pluginName: string): 'always' | 'tagged' | undefined {
    return this.pluginManifests.get(pluginName)?.activationMode;
  }

  /**
   * Parse plugin tags from message (e.g., "#doku-wiki #github")
   * Returns array of activated plugin names
   */
  parseAndActivateTags(message: string): string[] {
    const tagPattern = /#([a-z0-9_-]+)/gi;
    const matches = message.matchAll(tagPattern);
    const activated: string[] = [];

    for (const match of matches) {
      const pluginName = match[1];
      if (this.activate(pluginName)) {
        activated.push(pluginName);
      }
    }

    return activated;
  }

  /**
   * Save current state to session
   */
  private saveToSession(): void {
    const session = this.sessionManager.getCurrentSession();
    if (session) {
      session.active_plugins = this.getActivePlugins();
      this.sessionManager.save(); // Non-blocking auto-save
    }
  }
}
```

**Registration** (ServiceRegistry.ts):
```typescript
export class ServiceRegistry {
  // ... existing services
  private pluginActivationManager?: PluginActivationManager;

  setPluginActivationManager(manager: PluginActivationManager): void {
    this.pluginActivationManager = manager;
  }

  getPluginActivationManager(): PluginActivationManager {
    if (!this.pluginActivationManager) {
      throw new Error('PluginActivationManager not registered');
    }
    return this.pluginActivationManager;
  }
}
```

**Testing**:
- Unit test: activate/deactivate logic
- Unit test: "always" mode cannot be deactivated
- Unit test: tag parsing
- Unit test: session persistence

---

## Phase 2: Core Activation Logic

### 2.1 Add Tag Parsing to Agent (Agent.ts)

**File**: `src/agent/Agent.ts`
**Lines**: 393-520 (handleUserMessage method)

**Changes**:
```typescript
async handleUserMessage(message: string, toolName?: string, toolArgs?: any): Promise<void> {
  this.userPromptTimestamp = Date.now();
  logger.info('[PERF_USER_PROMPT]', this.instanceId, 'User prompt received at', this.userPromptTimestamp);

  // NEW: Parse and activate plugin tags
  const activationManager = this.serviceRegistry.getPluginActivationManager();
  const activatedPlugins = activationManager.parseAndActivateTags(message);

  // NEW: If plugins were activated, add system message hint
  if (activatedPlugins.length > 0) {
    const pluginNames = activatedPlugins.join(', ');
    this.messages.push({
      role: 'system',
      content: `[System: Activated plugins: ${pluginNames}. Tools from these plugins are now available.]`
    });
  }

  // Add user message (existing code)
  this.messages.push({
    role: 'user',
    content: message,
  });

  // ... rest of existing code
}
```

**Testing**:
- Send message with `#plugin-name` tag
- Verify plugin is activated
- Verify system message is added
- Verify session state is updated

---

### 2.2 Update Tool Loading (ToolManager.ts)

**File**: `src/tools/ToolManager.ts`
**Lines**: 144-159 (getFunctionDefinitions method)

**Changes**:
```typescript
getFunctionDefinitions(excludeTools?: string[]): AnthropicTool[] {
  const activationManager = this.serviceRegistry.getPluginActivationManager();
  const activePlugins = new Set(activationManager.getActivePlugins());

  return this.tools
    .filter(tool => {
      // Exclude explicitly excluded tools
      if (excludeTools && excludeTools.includes(tool.name)) {
        return false;
      }

      // NEW: Filter by plugin activation state
      if (tool.pluginName) {
        // Plugin tool: only include if plugin is active
        return activePlugins.has(tool.pluginName);
      }

      // Core tool: always include
      return true;
    })
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
}
```

**Testing**:
- Load tools with plugin inactive (should be excluded)
- Activate plugin and load tools (should be included)
- Verify core tools always included
- Verify excludeTools parameter still works

---

### 2.3 Update CLI Initialization (cli.ts)

**File**: `src/cli.ts`
**Lines**: 535-562 (main initialization)

**Changes**:
```typescript
// After SessionManager is created (line 549)
const sessionManager = await SessionManager.initialize(...);

// After PluginLoader loads plugins (line 556)
const loadedPlugins = await pluginLoader.loadAllPlugins(...);

// NEW: Create and initialize PluginActivationManager
const pluginActivationManager = new PluginActivationManager(
  pluginLoader,
  sessionManager
);
await pluginActivationManager.initialize();

// Register with service registry
serviceRegistry.setPluginActivationManager(pluginActivationManager);

// Continue with ToolManager creation (existing code, line 559)
const toolManager = new ToolManager(...);
```

**Testing**:
- Start CLI with no session (should load "always" plugins)
- Start CLI with existing session (should restore active_plugins)
- Verify core tools always loaded

---

## Phase 3: UX Layer

### 3.1 Add Plugin Commands (PluginCommand.ts)

**File**: `src/commands/PluginCommand.ts`
**Lines**: 25-66 (execute method)

**Changes**:
```typescript
async execute(args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case 'list':
      await this.listPlugins();
      break;
    case 'install':
      await this.installPlugin(args.slice(1));
      break;
    case 'uninstall':
      await this.uninstallPlugin(args.slice(1));
      break;
    case 'update':
      await this.updatePlugin(args.slice(1));
      break;
    // NEW SUBCOMMANDS
    case 'active':
      await this.listActivePlugins();
      break;
    case 'activate':
      await this.activatePlugin(args.slice(1));
      break;
    case 'deactivate':
      await this.deactivatePlugin(args.slice(1));
      break;
    default:
      this.printHelp();
  }
}

private async listActivePlugins(): Promise<void> {
  const activationManager = this.serviceRegistry.getPluginActivationManager();
  const activePlugins = activationManager.getActivePlugins();

  if (activePlugins.length === 0) {
    console.log(chalk.yellow('No plugins currently active in this session.'));
    return;
  }

  console.log(chalk.bold('\nActive Plugins:'));
  activePlugins.forEach(name => {
    const mode = activationManager.getActivationMode(name);
    const modeStr = mode === 'always' ? chalk.green('[always]') : chalk.blue('[tagged]');
    console.log(`  ${chalk.cyan(name)} ${modeStr}`);
  });
  console.log();
}

private async activatePlugin(args: string[]): Promise<void> {
  const pluginName = args[0];

  if (!pluginName) {
    console.log(chalk.red('Error: Plugin name required'));
    console.log('Usage: /plugin activate <plugin-name>');
    return;
  }

  const activationManager = this.serviceRegistry.getPluginActivationManager();
  const success = activationManager.activate(pluginName);

  if (success) {
    console.log(chalk.green(`✓ Activated plugin: ${pluginName}`));
  } else {
    console.log(chalk.red(`✗ Plugin not found: ${pluginName}`));
    console.log('Use /plugin list to see installed plugins.');
  }
}

private async deactivatePlugin(args: string[]): Promise<void> {
  const pluginName = args[0];

  if (!pluginName) {
    console.log(chalk.red('Error: Plugin name required'));
    console.log('Usage: /plugin deactivate <plugin-name>');
    return;
  }

  const activationManager = this.serviceRegistry.getPluginActivationManager();
  const mode = activationManager.getActivationMode(pluginName);

  if (mode === 'always') {
    console.log(chalk.yellow(`⚠ Cannot deactivate "${pluginName}" - it is set to "always" mode`));
    console.log('Reinstall the plugin to change its activation mode.');
    return;
  }

  const success = activationManager.deactivate(pluginName);

  if (success) {
    console.log(chalk.green(`✓ Deactivated plugin: ${pluginName}`));
  } else {
    console.log(chalk.red(`✗ Plugin not found: ${pluginName}`));
  }
}

private printHelp(): void {
  // Update existing help text
  console.log(`
${chalk.bold('Plugin Management Commands:')}

  ${chalk.cyan('/plugin list')}                    List all installed plugins
  ${chalk.cyan('/plugin install <path|url>')}     Install a plugin
  ${chalk.cyan('/plugin uninstall <name>')}       Uninstall a plugin
  ${chalk.cyan('/plugin update <name>')}          Update a plugin
  ${chalk.cyan('/plugin active')}                 List active plugins in this session
  ${chalk.cyan('/plugin activate <name>')}        Activate a plugin
  ${chalk.cyan('/plugin deactivate <name>')}      Deactivate a plugin

${chalk.dim('Use #plugin-name in messages to activate tagged plugins')}
  `);
}
```

**Testing**:
- `/plugin active` with no active plugins
- `/plugin active` with multiple active plugins
- `/plugin activate valid-plugin`
- `/plugin activate invalid-plugin`
- `/plugin deactivate always-plugin` (should fail)
- `/plugin deactivate tagged-plugin` (should succeed)

---

### 3.2 Add # Autocomplete (CompletionProvider.ts)

**File**: `src/ui/CompletionProvider.ts`
**Lines**: 111+ (getCompletions method)

**Changes**:
```typescript
getCompletions(input: string, cursorPos: number): CompletionItem[] {
  const beforeCursor = input.slice(0, cursorPos);

  // Existing @ filepath completion
  const atMatch = beforeCursor.match(/@([^\s]*)$/);
  if (atMatch) {
    return this.getFileCompletions(atMatch[1]);
  }

  // NEW: # plugin completion
  const hashMatch = beforeCursor.match(/#([a-z0-9_-]*)$/i);
  if (hashMatch) {
    return this.getPluginCompletions(hashMatch[1]);
  }

  return [];
}

private getPluginCompletions(partial: string): CompletionItem[] {
  const activationManager = this.serviceRegistry.getPluginActivationManager();
  const plugins = activationManager.getInstalledPlugins();

  // Filter plugins by partial match
  const matches = plugins.filter(name =>
    name.toLowerCase().includes(partial.toLowerCase())
  );

  // Sort: inactive tagged plugins first, then others
  const sorted = matches.sort((a, b) => {
    const aMode = activationManager.getActivationMode(a);
    const bMode = activationManager.getActivationMode(b);
    const aActive = activationManager.isActive(a);
    const bActive = activationManager.isActive(b);

    // Prioritize inactive tagged plugins (most likely to want to activate)
    if (!aActive && aMode === 'tagged' && (bActive || bMode === 'always')) return -1;
    if (!bActive && bMode === 'tagged' && (aActive || aMode === 'always')) return 1;

    return a.localeCompare(b);
  });

  return sorted.map(name => {
    const mode = activationManager.getActivationMode(name);
    const active = activationManager.isActive(name);
    const status = active ? '✓' : (mode === 'always' ? '●' : '○');

    return {
      label: `${status} ${name}`,
      value: name,
      description: mode === 'always' ? 'always active' : 'tagged mode'
    };
  });
}
```

**Integration with InputPrompt.tsx**:
```typescript
// In InputPrompt.tsx, update handleKeyPress to handle # prefix
if (key === '#' && !this.completionMenu) {
  // Trigger completion on # prefix
  this.showCompletions();
}
```

**Testing**:
- Type `#` and verify plugin list appears
- Type `#dok` and verify filtering works
- Verify status indicators (✓ active, ● always, ○ tagged)
- Verify selection inserts plugin name

---

### 3.3 Update /plugin list Display

**File**: `src/commands/PluginCommand.ts`
**Lines**: 68-89 (listPlugins method)

**Changes**:
```typescript
private async listPlugins(): Promise<void> {
  const plugins = this.pluginLoader.getLoadedPlugins();

  if (plugins.length === 0) {
    console.log(chalk.yellow('No plugins installed.'));
    return;
  }

  console.log(chalk.bold('\nInstalled Plugins:\n'));

  const activationManager = this.serviceRegistry.getPluginActivationManager();

  plugins.forEach(plugin => {
    const { name, version, description } = plugin.manifest;
    const mode = activationManager.getActivationMode(name) || 'always';
    const active = activationManager.isActive(name);

    // Status indicator
    const status = active ? chalk.green('●') : chalk.dim('○');

    // Mode badge
    const modeBadge = mode === 'always'
      ? chalk.green('[always]')
      : chalk.blue('[tagged]');

    console.log(`${status} ${chalk.cyan(name)} ${chalk.dim(`v${version}`)} ${modeBadge}`);
    console.log(`  ${description}`);
    console.log();
  });

  console.log(chalk.dim('Use /plugin active to see active plugins in this session'));
  console.log(chalk.dim('Use #plugin-name in messages to activate tagged plugins'));
  console.log();
}
```

**Testing**:
- `/plugin list` with mix of always/tagged plugins
- Verify status indicators
- Verify mode badges

---

## Phase 4: Integration & Testing

### 4.1 Integration Checklist

- [ ] PluginActivationManager registered in ServiceRegistry
- [ ] PluginActivationManager initialized in cli.ts
- [ ] Session type updated with active_plugins field
- [ ] SessionManager persists/restores active_plugins
- [ ] PluginManifest updated with activationMode field
- [ ] Plugin installation wizard asks about activation mode
- [ ] Agent parses # tags and activates plugins
- [ ] ToolManager filters tools by activation state
- [ ] Commands: /plugin active, activate, deactivate
- [ ] Autocomplete for # prefix
- [ ] Help text updated

### 4.2 Test Scenarios

**Scenario 1: Fresh Install**
1. Install plugin with "always" mode
2. Start new session
3. Verify tools are loaded
4. Verify `/plugin active` shows plugin
5. Try `/plugin deactivate` (should fail)

**Scenario 2: Tagged Plugin**
1. Install plugin with "tagged" mode
2. Start new session
3. Verify tools are NOT loaded initially
4. Type `#plugin-name` in message
5. Verify tools are loaded
6. Verify `/plugin active` shows plugin
7. Try `/plugin deactivate` (should succeed)
8. Verify tools are removed

**Scenario 3: Session Persistence**
1. Activate tagged plugin with `#plugin-name`
2. Send a few messages
3. Exit and restart CLI
4. Load same session
5. Verify plugin still active
6. Verify tools still loaded

**Scenario 4: Autocomplete**
1. Type `#` in input
2. Verify completion menu appears
3. Type partial name `#dok`
4. Verify filtering works
5. Select plugin
6. Verify `#doku-wiki` inserted

**Scenario 5: Commands**
1. `/plugin list` - verify mode badges and status
2. `/plugin active` - verify active plugins shown
3. `/plugin activate test-plugin` - verify activation
4. `/plugin deactivate test-plugin` - verify deactivation

**Scenario 6: Backward Compatibility**
1. Load old session without active_plugins field
2. Verify no errors
3. Verify defaults to empty array
4. Load old plugin without activationMode field
5. Verify defaults to "always"

**Scenario 7: Edge Cases**
1. Tag non-existent plugin: `#fake-plugin`
2. Verify no error, just ignored
3. Tag already-active plugin: `#plugin-name` twice
4. Verify idempotent (no duplicate activation)
5. Multiple tags in one message: `#plugin1 #plugin2`
6. Verify both activated

### 4.3 Performance Testing

- [ ] Measure token reduction with 5 plugins (3 tagged, 2 always)
- [ ] Measure response time improvement
- [ ] Verify no performance regression on session save/load
- [ ] Test with 10+ plugins installed

---

## Risk Mitigation

### Risk 1: Breaking Existing Sessions
**Mitigation**: Default `active_plugins: []` if undefined, auto-populate with "always" plugins on load

### Risk 2: Breaking Existing Plugins
**Mitigation**: Default `activationMode: 'always'` if undefined

### Risk 3: Tag Parsing False Positives
**Mitigation**: Strict regex `#([a-z0-9_-]+)`, only match exact plugin names

### Risk 4: Tool Context Mid-Conversation
**Mitigation**: Add system message when activating plugins to inform model

### Risk 5: Session State Race Conditions
**Mitigation**: Use existing atomic write pattern from SessionManager

---

## Success Metrics

- [ ] Initial tool context reduced by 30-50% for typical user (3-5 tagged plugins)
- [ ] Response time improved by 2-5 seconds (depending on context reduction)
- [ ] Zero regression bugs in existing plugin functionality
- [ ] All test scenarios pass
- [ ] User feedback positive on reduced clutter

---

## Implementation Order

1. **Day 1**: Phase 1 (Foundation)
   - Update Session type
   - Update PluginManifest
   - Create PluginActivationManager
   - Register in ServiceRegistry

2. **Day 2**: Phase 2 (Core Logic)
   - Tag parsing in Agent.ts
   - Tool filtering in ToolManager.ts
   - CLI initialization

3. **Day 3**: Phase 3 (UX)
   - Plugin commands
   - Autocomplete
   - Help text updates

4. **Day 4**: Phase 4 (Integration)
   - Integration testing
   - Edge case handling
   - Performance testing

5. **Day 5**: Polish & Documentation
   - User documentation
   - Code comments
   - Final testing

---

## Open Questions

1. Should we show plugin activation status in the prompt/status bar?
2. Should we log plugin activation events for debugging?
3. Should we limit the number of tagged plugins that can be active simultaneously?
4. Should we support plugin aliases (shorter names for tagging)?

---

## Appendix: File Change Summary

| File | Lines Changed | Type | Priority |
|------|---------------|------|----------|
| SessionManager.ts | ~20 | Modify | HIGH |
| PluginLoader.ts | ~50 | Modify | HIGH |
| PluginActivationManager.ts | ~200 | New | HIGH |
| ServiceRegistry.ts | ~15 | Modify | HIGH |
| Agent.ts | ~20 | Modify | HIGH |
| ToolManager.ts | ~30 | Modify | HIGH |
| cli.ts | ~10 | Modify | HIGH |
| PluginCommand.ts | ~150 | Modify | MEDIUM |
| CompletionProvider.ts | ~40 | Modify | MEDIUM |
| InputPrompt.tsx | ~10 | Modify | MEDIUM |

**Total Estimated Changes**: ~545 lines across 10 files
**Estimated Complexity**: Medium-High (requires careful integration with existing patterns)
**Estimated Timeline**: 4-5 days with testing
