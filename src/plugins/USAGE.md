# PluginLoader Usage Guide

## Overview

The `PluginLoader` class provides a dynamic plugin loading system for the Ally code assistant. It enables extending Ally's functionality through custom tools without modifying the core codebase.

## Quick Start

```typescript
import { PluginLoader } from './plugins/PluginLoader.js';
import { ActivityStream } from './services/ActivityStream.js';
import { PLUGINS_DIR } from './config/paths.js';

// Create activity stream
const activityStream = new ActivityStream();

// Initialize plugin loader
const loader = new PluginLoader(activityStream);

// Load all plugins
const pluginTools = await loader.loadPlugins(PLUGINS_DIR);

// Register with tool orchestrator
for (const tool of pluginTools) {
  toolOrchestrator.registerTool(tool);
}
```

## Architecture

### Plugin Discovery

The loader follows this process:

1. **Scan Directory**: Read all subdirectories in the plugins folder
2. **Find Manifests**: Look for `plugin.json` in each directory
3. **Validate**: Check required fields and plugin type
4. **Load**: Load the executable plugin
5. **Instantiate**: Create tool instances
6. **Return**: Provide array of loaded tools

### Error Handling

The loader is designed for resilience:

- **Non-blocking**: One broken plugin won't prevent others from loading
- **Comprehensive Logging**: All errors are logged with context
- **Graceful Degradation**: Invalid plugins are skipped with warnings
- **Type Safety**: Full TypeScript validation

## API Reference

### PluginLoader

```typescript
class PluginLoader {
  constructor(activityStream: ActivityStream)

  async loadPlugins(pluginDir: string): Promise<BaseTool[]>
}
```

#### Constructor

- **activityStream**: `ActivityStream` - Event stream for tool communication

#### Methods

##### `loadPlugins(pluginDir: string): Promise<BaseTool[]>`

Loads all plugins from the specified directory.

**Parameters:**
- `pluginDir`: Path to plugins directory (created if doesn't exist)

**Returns:**
- Array of loaded `BaseTool` instances

**Behavior:**
- Creates plugin directory if missing
- Scans for plugin subdirectories
- Loads each valid plugin
- Logs all errors and successes
- Never throws (returns empty array on total failure)

### PluginManifest Interface

```typescript
interface PluginManifest {
  name: string;                    // Required: Unique identifier
  version: string;                 // Required: Semantic version
  description: string;             // Required: LLM-facing description
  type: 'executable';              // Required: Plugin type
  command?: string;                // Required: Command to run
  args?: string[];                 // Optional: Command arguments
  requiresConfirmation?: boolean;  // Optional: Require user approval
  schema?: any;                    // Optional: JSON Schema for params
  author?: string;                 // Optional: Author info
}
```

## Plugin Development

### Executable Plugin Example

**Directory Structure:**
```
plugins/
  python-tool/
    plugin.json
    script.py
```

**plugin.json:**
```json
{
  "name": "python-tool",
  "version": "1.0.0",
  "description": "Python-based tool",
  "type": "executable",
  "command": "python3",
  "args": ["script.py"]
}
```

**script.py:**
```python
import json
import sys

# Read request
request = json.loads(sys.stdin.read())

# Process
result = process(request)

# Write response
response = {
    'success': True,
    'error': '',
    'result': result
}
print(json.dumps(response))
```

## Integration

### With ToolOrchestrator

```typescript
import { ToolOrchestrator } from './services/ToolOrchestrator.js';

const orchestrator = new ToolOrchestrator(/* ... */);

// Load and register plugins
const pluginTools = await loader.loadPlugins(PLUGINS_DIR);
for (const tool of pluginTools) {
  orchestrator.registerTool(tool);
}
```

### With ServiceRegistry

```typescript
import { ServiceRegistry } from './services/ServiceRegistry.js';

const registry = ServiceRegistry.getInstance();

// Register loader as a service
registry.register('plugin_loader', loader, {
  lifecycle: ServiceLifecycle.SINGLETON
});
```

## Logging

The loader uses the standard Logger service:

```typescript
import { logger } from './services/Logger.js';

// Log levels used:
// - info: Successful loads, directory scanning
// - warn: Skipped plugins, non-fatal errors
// - error: Failed loads, invalid manifests
// - debug: Detailed troubleshooting info
```

Enable verbose logging:
```bash
ally --verbose  # Shows info + warn + error
ally --debug    # Shows all messages
```

## Security Considerations

### Executable Plugins
- Run as separate processes
- Limited to stdio communication
- Still have filesystem access
- Consider containerization for untrusted plugins

### Best Practices
1. Review plugin source code before loading
2. Use `requiresConfirmation: true` for destructive operations
3. Validate all input parameters
4. Handle errors gracefully
5. Log security-relevant operations

## Troubleshooting

### Plugin Not Loading

1. **Check manifest exists**: `ls plugins/my-tool/plugin.json`
2. **Validate JSON syntax**: `cat plugins/my-tool/plugin.json | jq`
3. **Check required fields**: name, version, description, type
4. **Enable debug logging**: `ally --debug`

### Executable Plugin Not Working

1. **Test command**: Run command manually to verify it works
2. **Check permissions**: `chmod +x script.py`
3. **Verify PATH**: Ensure command is in system PATH
4. **Test stdio**: Ensure script reads stdin and writes stdout

## Examples

See `/Users/bhm128/code-ally/examples/plugins/` for complete examples:

- **example**: Plugin example (Python)
- **README.md**: Comprehensive plugin development guide

## Future Enhancements

Potential improvements:

1. **Hot Reloading**: Reload plugins without restarting Ally
2. **Plugin Dependencies**: Allow plugins to depend on each other
3. **Plugin Marketplace**: Central registry for sharing plugins
4. **Enhanced Sandboxing**: Additional isolation for untrusted plugins
5. **Version Compatibility**: Check plugin compatibility with Ally version
6. **Plugin API Versioning**: Support multiple API versions

## Support

For issues or questions:
- Check logs with `--debug` flag
- Review examples in `/examples/plugins/`
- Submit issues to project repository
