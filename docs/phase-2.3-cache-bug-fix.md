# Phase 2.3 Cache Consistency Bug Fix

## The Problem

The `ToolManager.getFunctionDefinitions()` cache didn't account for plugin activation state changes, causing a critical consistency bug where deactivated plugin tools would still be returned from cache.

### Bug Scenario

```typescript
// Initial state: Plugins A and B are active
const defs1 = toolManager.getFunctionDefinitions();
// Result: ['core_tool', 'plugin_a_tool', 'plugin_b_tool']
// Cache: Stores these 3 definitions

// Plugin A is deactivated
pluginActivationManager.deactivate('plugin-a');

// Second call
const defs2 = toolManager.getFunctionDefinitions();
// BUG: Still returns ['core_tool', 'plugin_a_tool', 'plugin_b_tool']
// Expected: ['core_tool', 'plugin_b_tool']
```

### Root Cause

The cache was stored as a single value (`FunctionDefinition[] | null`) and returned immediately on line 154 without checking plugin activation state:

```typescript
// OLD CODE (BUGGY)
getFunctionDefinitions(excludeTools?: string[]): FunctionDefinition[] {
  if (!excludeTools && this.functionDefinitionsCache) {
    return this.functionDefinitionsCache;  // Returns immediately, bypasses plugin filtering!
  }

  // Plugin filtering logic only runs when cache misses
  // ...
}
```

The plugin filtering logic only executed when the cache missed, so cached results included tools from deactivated plugins.

## The Solution

**Implemented: Option 1 - Cache Key with Plugin State**

Changed the cache from a single value to a `Map<string, FunctionDefinition[]>` where the key includes the current plugin activation state.

### Key Changes

#### 1. Changed Cache Data Structure

```typescript
// Before
private functionDefinitionsCache: FunctionDefinition[] | null = null;

// After
private functionDefinitionsCache: Map<string, FunctionDefinition[]> = new Map();
```

#### 2. Generate Activation-Aware Cache Key

```typescript
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

#### 3. Updated getFunctionDefinitions()

```typescript
getFunctionDefinitions(excludeTools?: string[]): FunctionDefinition[] {
  // Get current plugin activation state
  let activePlugins: Set<string> | null = null;
  try {
    const registry = ServiceRegistry.getInstance();
    const activationManager = registry.getPluginActivationManager();
    activePlugins = new Set(activationManager.getActivePlugins());
  } catch (error) {
    activePlugins = null;
  }

  // Generate cache key including plugin state
  const cacheKey = this.generateCacheKey(activePlugins, excludeTools);

  // Check cache with activation-aware key
  if (this.functionDefinitionsCache.has(cacheKey)) {
    return this.functionDefinitionsCache.get(cacheKey)!;
  }

  // Generate definitions...
  // ...

  // Cache with activation-aware key
  this.functionDefinitionsCache.set(cacheKey, functionDefs);
  return functionDefs;
}
```

#### 4. Updated Cache Invalidation

```typescript
registerTool(tool: BaseTool): void {
  // ...
  this.functionDefinitionsCache.clear(); // Clear all cached entries
  // ...
}

unregisterTool(toolName: string): void {
  // ...
  this.functionDefinitionsCache.clear(); // Clear all cached entries
  // ...
}
```

## Why This Solution Works

### Correctness
- **Plugin state is part of cache key**: Different activation states produce different cache keys
- **No stale data**: Each plugin activation state has its own cache entry
- **Automatic consistency**: When plugins change, the cache key changes, forcing regeneration

### Performance
- **Cache reuse**: When activation state is stable, cache still provides full benefit
- **Multiple states cached**: Switching between states reuses cached entries (e.g., A+B → B → A+B)
- **Minimal overhead**: Cache key generation is O(n) where n = number of active plugins (typically small)

### Example Cache Keys

```
Scenario 1: No plugins active
Key: "no-active-plugins"

Scenario 2: Plugins A and B active
Key: "plugins:plugin-a,plugin-b"

Scenario 3: Only plugin B active
Key: "plugins:plugin-b"

Scenario 4: Plugin A active, excluding tool X
Key: "plugins:plugin-a|exclude:tool-x"
```

## Test Coverage

Created comprehensive test suite in `ToolManager.plugin-cache.test.ts`:

- ✅ Cache returns different definitions when plugin activation changes
- ✅ Deactivated plugin tools are never returned from cache
- ✅ Cache stores entries separately for different activation states
- ✅ Core tools always included regardless of plugin state
- ✅ Exclusions work correctly with plugin activation changes
- ✅ Cache invalidated when tools are registered/unregistered
- ✅ Handles the exact bug scenario from issue description

## Verification

```bash
# All ToolManager tests pass
npm test -- src/tools/__tests__/ToolManager

# Output:
# ✓ src/tools/__tests__/ToolManager.plugin-cache.test.ts (7 tests)
# ✓ src/tools/__tests__/ToolManager.test.ts (13 tests)
# Test Files  2 passed (2)
# Tests  20 passed (20)

# All tool tests pass
npm test -- src/tools/__tests__/

# Output:
# Test Files  15 passed (15)
# Tests  261 passed (261)
```

## Impact

### Before Fix
- Plugin deactivation didn't work correctly
- Cached function definitions included deactivated plugins
- LLM could call tools from plugins user explicitly deactivated
- Inconsistent behavior based on cache state

### After Fix
- Plugin activation state immediately reflected in function definitions
- Cache maintains correctness across all activation state changes
- No performance regression (cache still effective)
- Predictable, consistent behavior

## Alternative Approaches Considered

### Option 2: Cache Invalidation on Plugin Changes
```typescript
// Would require PluginActivationManager to notify ToolManager
pluginActivationManager.onActivationChange(() => {
  toolManager.invalidateCache();
});
```
**Rejected**: Requires cross-service coordination, more complex, breaks separation of concerns.

### Option 3: Post-Cache Filtering
```typescript
const cached = this.functionDefinitionsCache;
return cached.filter(def => isToolAllowed(def));
```
**Rejected**: Reduces cache effectiveness, filtering overhead on every call.

## Files Modified

- **src/tools/ToolManager.ts**: Core fix implementation
- **src/tools/__tests__/ToolManager.plugin-cache.test.ts**: New comprehensive test suite

## Conclusion

The bug is completely fixed. The cache is now plugin-activation-aware, ensuring deactivated plugins' tools are never returned. Performance benefits of caching are maintained, and the solution is clean, maintainable, and thoroughly tested.
