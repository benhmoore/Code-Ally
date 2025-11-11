# Plugin Tagging System - Integration Test Plan

**Status**: Ready for Testing
**Date**: 2025-11-11
**Phases Completed**: 1, 2, 3

---

## Test Environment Setup

### Prerequisites
- Code Ally CLI built successfully (`npm run build`)
- At least 2 test plugins available:
  - One configured as "always" mode
  - One configured as "tagged" mode
- Clean test session (or ability to create new sessions)

### Test Data Requirements
- Test plugin manifests with `activationMode` field
- Existing session files for backward compatibility testing
- Multiple plugins installed for filtering tests

---

## Test Scenarios

### Scenario 1: Fresh Install - Always Mode Plugin

**Objective**: Verify always-mode plugins are automatically active in new sessions

**Steps**:
1. Install a plugin with `activationMode: 'always'` in manifest
2. Start new CLI session
3. Run `/plugin active`
4. Run `/plugin list`
5. Send a test message (no #tags)

**Expected Results**:
- ✓ Plugin appears in `/plugin active` list with `[always]` badge
- ✓ Plugin shows `●` (active) indicator in `/plugin list`
- ✓ Plugin tools are available to the LLM
- ✓ Cannot deactivate via `/plugin deactivate` (shows warning)
- ✓ Session persists active state on reload

**Pass Criteria**:
- [ ] Always-mode plugin is active without manual activation
- [ ] Plugin cannot be deactivated
- [ ] Tools are loaded in every conversation
- [ ] Status indicators display correctly

---

### Scenario 2: Tagged Mode Plugin Activation

**Objective**: Verify tagged-mode plugins activate only when tagged with #plugin-name

**Steps**:
1. Install a plugin with `activationMode: 'tagged'` in manifest
2. Start new CLI session
3. Run `/plugin active` (should not show the plugin)
4. Run `/plugin list` (should show `○` inactive)
5. Send message: `#test-plugin Please help me`
6. Run `/plugin active` again
7. Check system message about activation
8. Verify tools are now available

**Expected Results**:
- ✓ Plugin NOT active initially
- ✓ Plugin shows `○` (inactive) indicator before activation
- ✓ `#test-plugin` tag activates the plugin
- ✓ System message: `[System: Activated plugins: test-plugin. Tools from these plugins are now available.]`
- ✓ Plugin appears in `/plugin active` after activation
- ✓ Plugin shows `●` (active) indicator after activation
- ✓ Plugin tools now available to LLM

**Pass Criteria**:
- [ ] Plugin inactive until #tag used
- [ ] #tag correctly activates plugin
- [ ] System message appears
- [ ] Tools load after activation
- [ ] Status changes from ○ to ●

---

### Scenario 3: Session Persistence

**Objective**: Verify plugin activation state persists across CLI restarts

**Steps**:
1. Start CLI session
2. Activate tagged plugin: `#test-plugin hello`
3. Verify plugin is active: `/plugin active`
4. Exit CLI
5. Restart CLI and load same session
6. Check `/plugin active` again
7. Send message (no #tags)
8. Verify tools still available

**Expected Results**:
- ✓ Active plugins persist in session file (`active_plugins` array)
- ✓ After restart, plugin is still active
- ✓ Tools available without re-activation
- ✓ Session metadata shows `active_plugins: ["test-plugin"]`

**Pass Criteria**:
- [ ] Session saves `active_plugins` array
- [ ] Restart restores active plugins
- [ ] No need to re-activate
- [ ] Tools remain available

---

### Scenario 4: Autocomplete Functionality

**Objective**: Verify # prefix triggers plugin name autocomplete

**Steps**:
1. In message input, type `#`
2. Observe completion menu appears
3. Type `#test` (partial name)
4. Observe filtered results
5. Select a plugin from menu
6. Verify insertion format

**Expected Results**:
- ✓ Typing `#` shows completion menu
- ✓ List shows all installed plugins
- ✓ Status indicators visible:
  - `● plugin-name` for always-mode
  - `✓ plugin-name` for active tagged-mode
  - `○ plugin-name` for inactive tagged-mode
- ✓ Partial match filters list
- ✓ Selection inserts `#plugin-name ` (with trailing space)
- ✓ Sorted with inactive tagged plugins first

**Pass Criteria**:
- [ ] # triggers autocomplete
- [ ] Status indicators correct
- [ ] Filtering works
- [ ] Insertion format correct
- [ ] Sorting prioritizes inactive tagged plugins

---

### Scenario 5: Plugin Management Commands

**Objective**: Verify all plugin management commands work correctly

#### 5a. `/plugin list`
**Steps**:
1. Run `/plugin list`
2. Check output format

**Expected**:
- Shows all installed plugins
- `●` for active plugins, `○` for inactive
- `[always]` or `[tagged]` mode badges
- Footer hint about #plugin-name usage

#### 5b. `/plugin active`
**Steps**:
1. Activate some plugins
2. Run `/plugin active`

**Expected**:
- Lists only currently active plugins
- Shows mode badges
- Empty state message if none active

#### 5c. `/plugin activate <name>`
**Steps**:
1. Run `/plugin activate test-plugin`
2. Verify activation
3. Run `/plugin activate fake-plugin`

**Expected**:
- Valid plugin: Success message, plugin becomes active
- Invalid plugin: Error message

#### 5d. `/plugin deactivate <name>`
**Steps**:
1. Try `/plugin deactivate always-plugin`
2. Try `/plugin deactivate tagged-plugin`

**Expected**:
- Always-mode: Warning message, cannot deactivate
- Tagged-mode: Success message, plugin deactivates
- Tools removed after deactivation

#### 5e. `/plugin help` or `/plugin`
**Steps**:
1. Run `/plugin` with no args or `/plugin help`

**Expected**:
- Shows help text
- Lists all subcommands
- Includes activate/deactivate/active commands

**Pass Criteria**:
- [ ] All commands execute without errors
- [ ] Output format matches expectations
- [ ] Error handling works correctly
- [ ] Help text is comprehensive

---

### Scenario 6: Backward Compatibility

**Objective**: Verify old sessions/plugins work without new fields

#### 6a. Old Session (no `active_plugins` field)
**Steps**:
1. Load session created before this feature
2. Verify CLI starts normally
3. Check `/plugin active`
4. Verify always-mode plugins auto-activate

**Expected**:
- ✓ No errors loading old session
- ✓ `active_plugins` defaults to `[]`
- ✓ Always-mode plugins activate automatically
- ✓ Session continues working normally

#### 6b. Old Plugin (no `activationMode` field)
**Steps**:
1. Load plugin manifest without `activationMode`
2. Check plugin behavior
3. Verify tools load

**Expected**:
- ✓ No validation errors
- ✓ Defaults to `'always'` mode
- ✓ Plugin is always active
- ✓ Tools always available

**Pass Criteria**:
- [ ] Old sessions load successfully
- [ ] Old plugins work as always-mode
- [ ] No breaking changes
- [ ] Graceful defaults

---

### Scenario 7: Edge Cases

#### 7a. Non-existent Plugin Tag
**Steps**:
1. Send message: `#fake-plugin hello`

**Expected**:
- ✓ No error
- ✓ Tag silently ignored
- ✓ Conversation continues normally
- ✓ Debug log shows plugin not found

#### 7b. Multiple Tags in One Message
**Steps**:
1. Send message: `#plugin1 #plugin2 test`

**Expected**:
- ✓ Both plugins activate
- ✓ System message lists both: `[System: Activated plugins: plugin1, plugin2...]`
- ✓ Tools from both plugins available

#### 7c. Duplicate Tag (Already Active)
**Steps**:
1. Activate plugin: `#test-plugin first`
2. Tag again: `#test-plugin second`

**Expected**:
- ✓ No error
- ✓ No duplicate activation
- ✓ System message NOT shown second time (already active)
- ✓ Idempotent behavior

#### 7d. Plugin Uninstalled But Referenced in Session
**Steps**:
1. Activate plugin in session
2. Uninstall plugin
3. Restart CLI with same session

**Expected**:
- ✓ Warning logged (plugin not found)
- ✓ Plugin skipped during initialization
- ✓ CLI continues without error
- ✓ Other plugins still work

#### 7e. Case Sensitivity
**Steps**:
1. Install plugin: `test-plugin`
2. Try tag: `#Test-Plugin` (different case)

**Expected**:
- ✓ Case-sensitive matching (tag doesn't activate)
- ✓ Or: Case-insensitive matching if implemented
- ✓ Consistent behavior documented

#### 7f. Tag with Invalid Characters
**Steps**:
1. Send: `#plugin@name` or `#plugin.name`

**Expected**:
- ✓ Regex pattern `#([a-z0-9_-]+)` only matches valid chars
- ✓ Invalid chars stop matching
- ✓ No errors or unexpected behavior

**Pass Criteria**:
- [ ] All edge cases handled gracefully
- [ ] No errors or crashes
- [ ] Logging appropriate
- [ ] Behavior documented

---

## Performance Testing

### Test 1: Token Reduction

**Objective**: Measure context reduction with tagged plugins

**Setup**:
- Install 5 plugins total:
  - 2 always-mode (always loaded)
  - 3 tagged-mode (conditionally loaded)

**Measurements**:
1. Count tools loaded with all plugins active
2. Count tools loaded with only always-mode active
3. Calculate reduction percentage

**Expected Results**:
- 30-50% reduction in tool count for typical usage
- Corresponding reduction in token count
- Faster initial response time

**Pass Criteria**:
- [ ] Measurable reduction in tool context
- [ ] No performance regression
- [ ] Session save/load not significantly slower

### Test 2: Response Time

**Objective**: Measure latency improvement

**Measurements**:
1. Time-to-first-token with all plugins active
2. Time-to-first-token with filtered plugins
3. Compare to baseline (before feature)

**Expected**:
- 2-5 second improvement for models with high tool overhead
- No regression for users with few plugins

### Test 3: Session Performance

**Objective**: Verify session save/load not degraded

**Measurements**:
1. Time to save session with active_plugins
2. Time to load session and restore state
3. Memory usage

**Expected**:
- No significant increase in save/load time (<10ms overhead)
- Minimal memory impact

---

## Integration Checklist

### Data Flow
- [ ] Session creation initializes `active_plugins: []`
- [ ] PluginActivationManager loads from session on init
- [ ] Always-mode plugins auto-activate on init
- [ ] Tag parsing activates plugins
- [ ] ToolManager filters by active plugins
- [ ] Session updates persist activation state
- [ ] CLI restart restores activation state

### Service Integration
- [ ] PluginActivationManager registered in ServiceRegistry
- [ ] Agent.ts accesses via ServiceRegistry
- [ ] ToolManager accesses via ServiceRegistry
- [ ] PluginCommand accesses via ServiceRegistry
- [ ] CompletionProvider accesses via ServiceRegistry
- [ ] All error handling graceful if not registered

### User Experience
- [ ] Commands respond quickly
- [ ] Error messages clear and actionable
- [ ] Status indicators consistent across UI
- [ ] Help text comprehensive
- [ ] Autocomplete feels responsive
- [ ] No confusing behavior

### Logging
- [ ] Debug logs for plugin activation
- [ ] Debug logs for tag parsing
- [ ] Info logs for significant events
- [ ] Error logs for failures
- [ ] Performance logs if enabled

---

## Regression Testing

Ensure existing functionality still works:

- [ ] `/plugin list` (original functionality)
- [ ] `/plugin install <path>`
- [ ] `/plugin uninstall <name>`
- [ ] `/plugin config <name>`
- [ ] Agent tool execution
- [ ] Message handling
- [ ] Session save/load
- [ ] Conversation flow

---

## Known Limitations

Document any known limitations or future improvements:

1. **Case Sensitivity**: Plugin tags are case-sensitive (matching plugin name exactly)
2. **Tag Format**: Only `#[a-z0-9_-]+` pattern supported
3. **UI Indicators**: Limited to text symbols (●, ○, ✓) - no color in completions
4. **Activation Scope**: Plugin activation is session-scoped (not global)
5. **Mode Change**: Cannot change activation mode without reinstalling plugin

---

## Test Execution Log

### Environment
- OS: macOS Darwin 24.6.0
- Node Version: [To be filled]
- CLI Version: 0.1.0
- Date: 2025-11-11

### Test Results

| Scenario | Status | Notes |
|----------|--------|-------|
| 1. Fresh Install (Always) | ⏳ Pending | |
| 2. Tagged Activation | ⏳ Pending | |
| 3. Session Persistence | ⏳ Pending | |
| 4. Autocomplete | ⏳ Pending | |
| 5. Commands | ⏳ Pending | |
| 6. Backward Compat | ⏳ Pending | |
| 7. Edge Cases | ⏳ Pending | |
| Performance: Token Reduction | ⏳ Pending | |
| Performance: Response Time | ⏳ Pending | |
| Performance: Session Perf | ⏳ Pending | |

### Issues Found

| Issue # | Severity | Description | Status |
|---------|----------|-------------|--------|
| - | - | - | - |

### Final Assessment

- **Overall Status**: ⏳ Testing in Progress
- **Blocker Issues**: None identified yet
- **Recommendation**: [To be completed after testing]

---

## Next Steps

After completing integration testing:

1. ✅ Fix any critical issues found
2. ✅ Document any limitations or workarounds
3. ✅ Update user documentation
4. ✅ Create plugin developer guide for `activationMode`
5. ✅ Consider adding automated integration tests
6. ✅ Plan Phase 5: Polish & Performance Optimization (if needed)
