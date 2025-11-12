# Phase 2.3 Bug Fix: Before & After Comparison

## The Bug in Action

### Before Fix (BROKEN)

```typescript
// Step 1: Plugins A and B are active
pluginActivationManager.activate('plugin-a');
pluginActivationManager.activate('plugin-b');

// Step 2: First call to getFunctionDefinitions
const defs1 = toolManager.getFunctionDefinitions();
console.log(defs1.map(d => d.function.name));
// Output: ['core_tool', 'plugin_a_tool', 'plugin_b_tool'] ✅ CORRECT
// Cache stored: ['core_tool', 'plugin_a_tool', 'plugin_b_tool']

// Step 3: Plugin A is deactivated
pluginActivationManager.deactivate('plugin-a');

// Step 4: Second call to getFunctionDefinitions
const defs2 = toolManager.getFunctionDefinitions();
console.log(defs2.map(d => d.function.name));
// Output: ['core_tool', 'plugin_a_tool', 'plugin_b_tool'] ❌ BUG!
// Expected: ['core_tool', 'plugin_b_tool']
```

**Problem**: The cache returns immediately without checking plugin activation state. The deactivated plugin's tool is still included.

### After Fix (CORRECT)

```typescript
// Step 1: Plugins A and B are active
pluginActivationManager.activate('plugin-a');
pluginActivationManager.activate('plugin-b');

// Step 2: First call to getFunctionDefinitions
const defs1 = toolManager.getFunctionDefinitions();
console.log(defs1.map(d => d.function.name));
// Output: ['core_tool', 'plugin_a_tool', 'plugin_b_tool'] ✅ CORRECT
// Cache stored:
//   Key "plugins:plugin-a,plugin-b" → ['core_tool', 'plugin_a_tool', 'plugin_b_tool']

// Step 3: Plugin A is deactivated
pluginActivationManager.deactivate('plugin-a');

// Step 4: Second call to getFunctionDefinitions
const defs2 = toolManager.getFunctionDefinitions();
console.log(defs2.map(d => d.function.name));
// Output: ['core_tool', 'plugin_b_tool'] ✅ CORRECT!
// Cache stored:
//   Key "plugins:plugin-a,plugin-b" → ['core_tool', 'plugin_a_tool', 'plugin_b_tool']
//   Key "plugins:plugin-b" → ['core_tool', 'plugin_b_tool']  ← NEW ENTRY
```

**Solution**: Cache key includes plugin activation state. Different states produce different cache keys, ensuring correct behavior.

## Code Changes

### Cache Data Structure

```diff
  export class ToolManager {
    private tools: Map<string, BaseTool>;
    private validator: ToolValidator;
    private duplicateDetector: DuplicateDetector;
    private readFiles: Map<string, number> = new Map();
-   private functionDefinitionsCache: FunctionDefinition[] | null = null;
+   private functionDefinitionsCache: Map<string, FunctionDefinition[]> = new Map();
```

### Cache Invalidation

```diff
  registerTool(tool: BaseTool): void {
    // ...
    this.tools.set(tool.name, tool);
-   this.functionDefinitionsCache = null;
+   this.functionDefinitionsCache.clear();
    // ...
  }

  unregisterTool(toolName: string): void {
    // ...
    this.tools.delete(toolName);
-   this.functionDefinitionsCache = null;
+   this.functionDefinitionsCache.clear();
    // ...
  }
```

### Main Logic (getFunctionDefinitions)

#### Before (Buggy)

```typescript
getFunctionDefinitions(excludeTools?: string[]): FunctionDefinition[] {
  // ❌ Cache check happens BEFORE getting plugin state
  if (!excludeTools && this.functionDefinitionsCache) {
    return this.functionDefinitionsCache;  // Returns stale cached data!
  }

  const functionDefs: FunctionDefinition[] = [];
  const excludeSet = new Set(excludeTools || []);

  // Plugin filtering only runs when cache misses
  let activePlugins: Set<string> | null = null;
  try {
    const registry = ServiceRegistry.getInstance();
    const activationManager = registry.getPluginActivationManager();
    activePlugins = new Set(activationManager.getActivePlugins());
  } catch (error) {
    activePlugins = null;
  }

  for (const tool of this.tools.values()) {
    if (excludeSet.has(tool.name)) continue;

    // This filtering logic is bypassed when cache hits!
    if (activePlugins !== null && tool.pluginName) {
      if (!activePlugins.has(tool.pluginName)) {
        continue;
      }
    }

    const functionDef = this.generateFunctionDefinition(tool);
    functionDefs.push(functionDef);
  }

  if (!excludeTools) {
    this.functionDefinitionsCache = functionDefs;
  }

  return functionDefs;
}
```

#### After (Fixed)

```typescript
getFunctionDefinitions(excludeTools?: string[]): FunctionDefinition[] {
  // ✅ Get plugin state FIRST
  let activePlugins: Set<string> | null = null;
  try {
    const registry = ServiceRegistry.getInstance();
    const activationManager = registry.getPluginActivationManager();
    activePlugins = new Set(activationManager.getActivePlugins());
  } catch (error) {
    activePlugins = null;
  }

  // ✅ Generate cache key that includes plugin state
  const cacheKey = this.generateCacheKey(activePlugins, excludeTools);

  // ✅ Check cache with activation-aware key
  if (this.functionDefinitionsCache.has(cacheKey)) {
    return this.functionDefinitionsCache.get(cacheKey)!;
  }

  const functionDefs: FunctionDefinition[] = [];
  const excludeSet = new Set(excludeTools || []);

  for (const tool of this.tools.values()) {
    if (excludeSet.has(tool.name)) continue;

    // Plugin filtering always runs (when cache misses)
    if (activePlugins !== null && tool.pluginName) {
      if (!activePlugins.has(tool.pluginName)) {
        continue;
      }
    }

    const functionDef = this.generateFunctionDefinition(tool);
    functionDefs.push(functionDef);
  }

  // ✅ Cache with activation-aware key
  this.functionDefinitionsCache.set(cacheKey, functionDefs);

  return functionDefs;
}
```

### New Helper Method

```typescript
/**
 * Generate a cache key based on active plugins and excluded tools
 */
private generateCacheKey(activePlugins: Set<string> | null, excludeTools?: string[]): string {
  const parts: string[] = [];

  // Include active plugins in key (sorted for consistency)
  if (activePlugins === null) {
    parts.push('no-plugin-manager');
  } else if (activePlugins.size === 0) {
    parts.push('no-active-plugins');
  } else {
    parts.push(`plugins:${Array.from(activePlugins).sort().join(',')}`);
  }

  // Include exclusions in key if present
  if (excludeTools && excludeTools.length > 0) {
    parts.push(`exclude:${excludeTools.sort().join(',')}`);
  }

  return parts.join('|');
}
```

## Cache Behavior Comparison

### Scenario: Toggling Plugin A

| Step | Action | Active Plugins | Before Fix (Cache Key) | After Fix (Cache Keys) |
|------|--------|----------------|----------------------|----------------------|
| 1 | Activate A | [A] | `null` (single cache) | `"plugins:plugin-a"` |
| 2 | Get defs | [A] | Returns cached | Returns cached ✅ |
| 3 | Deactivate A | [] | Returns cached ❌ | Cache miss, generates new |
| 4 | Get defs | [] | Still returns [A] ❌ | Returns [] ✅ |
| 5 | Activate A | [A] | Still returns [A] ⚠️ | Returns [A] from cache ✅ |

### Scenario: Switching Between Plugins

| Step | Active Plugins | Before Fix Result | After Fix Result | After Fix Cache Key |
|------|---------------|------------------|------------------|-------------------|
| 1 | [A, B] | [core, A, B] ✅ | [core, A, B] ✅ | `"plugins:plugin-a,plugin-b"` |
| 2 | [B] | [core, A, B] ❌ | [core, B] ✅ | `"plugins:plugin-b"` |
| 3 | [A] | [core, A, B] ❌ | [core, A] ✅ | `"plugins:plugin-a"` |
| 4 | [A, B] | [core, A, B] ⚠️ | [core, A, B] ✅ | `"plugins:plugin-a,plugin-b"` (cached) |

## Test Results

### New Tests (All Pass)

```
✓ should return different definitions when plugin activation changes
✓ should not return cached definitions with deactivated plugins
✓ should cache separately for different activation states
✓ should always include core tools regardless of plugin state
✓ should handle excludeTools with plugin activation changes
✓ should invalidate cache when tools are registered/unregistered
✓ should handle activation state changes between multiple plugin combinations
```

### Existing Tests (All Still Pass)

```
✓ src/tools/__tests__/ToolManager.test.ts (13 tests)
✓ All tool tests (261 tests)
```

## Impact Summary

| Aspect | Before Fix | After Fix |
|--------|-----------|-----------|
| **Correctness** | ❌ Returns deactivated plugins | ✅ Always correct |
| **Cache Efficiency** | ✅ Fast (when stable) | ✅ Fast (when stable) |
| **Memory Usage** | Low (1 cache entry) | Low (few cache entries) |
| **Performance** | ⚠️ Fast but wrong | ✅ Fast and correct |
| **Complexity** | Low | Low |
| **Maintainability** | ❌ Bug-prone | ✅ Clear intent |

## Conclusion

The fix is complete, correct, and maintains excellent performance characteristics while ensuring cache consistency across all plugin activation state changes.
