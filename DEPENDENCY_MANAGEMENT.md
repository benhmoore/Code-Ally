# Automatic Plugin Dependency Management

## Overview

Code Ally now automatically manages plugin dependencies with isolated virtual environments. Plugins simply declare their dependencies in the manifest, and Code Ally handles the rest.

## Implementation

### Architecture

```
~/.ally/
├── plugins/                    # Plugin source code
│   └── dokuwiki-plugin/
│       ├── plugin.json         # Declares runtime & dependencies
│       ├── requirements.txt    # Python dependencies
│       └── main.py
└── plugin-envs/               # Isolated environments
    └── dokuwiki-plugin/
        ├── bin/python3        # Virtual environment
        ├── lib/
        └── .installed        # Installation marker
```

### Key Components

**1. PluginEnvironmentManager** (`src/plugins/PluginEnvironmentManager.ts`)
- Creates isolated virtual environments per plugin
- Installs dependencies on first load
- Caches installations for instant subsequent use
- Currently supports Python (venv + pip)

**2. Updated PluginManifest Interface**
```typescript
interface PluginManifest {
  runtime?: string;              // 'python3', 'node', etc.
  dependencies?: {
    file: string;                // 'requirements.txt', 'package.json'
    install_command?: string;    // Optional custom command
  };
}
```

**3. Updated ExecutableToolWrapper**
- Automatically detects plugin runtime
- Injects venv Python interpreter for Python plugins
- Transparent to plugin code

**4. Updated PluginLoader**
- Calls `ensureDependencies()` before loading tools
- Shows progress during installation
- Blocks loading if dependencies fail

### Example Plugin Manifest

```json
{
  "name": "dokuwiki-plugin",
  "version": "1.0.0",
  "runtime": "python3",
  "dependencies": {
    "file": "requirements.txt"
  },
  "tools": [
    {
      "name": "dokuwiki_search",
      "command": "python3",
      "args": ["main.py", "search"]
    }
  ]
}
```

**No wrapper scripts needed!** Code Ally automatically:
1. Creates venv at `~/.ally/plugin-envs/dokuwiki-plugin/`
2. Installs from `requirements.txt`
3. Uses venv Python when executing tools

## User Experience

### First Load (with dependencies)
```
[PluginLoader] Scanning plugins directory: /Users/user/.ally/plugins
[PluginLoader] Found 2 potential plugin(s)
[PluginEnvironmentManager] Installing dependencies for 'dokuwiki-plugin'...
[PluginEnvironmentManager]   → Creating virtual environment
[PluginEnvironmentManager]   → Installing packages from requirements.txt
[PluginEnvironmentManager] ✓ Dependencies installed for 'dokuwiki-plugin'
[PluginLoader] Successfully loaded plugin with 4 tool(s): dokuwiki_search, ...
```

Takes ~10-15 seconds on first load. Subsequent loads are instant.

### Subsequent Loads
```
[PluginLoader] Scanning plugins directory: /Users/user/.ally/plugins
[PluginLoader] Found 2 potential plugin(s)
[PluginLoader] Successfully loaded plugin with 4 tool(s): dokuwiki_search, ...
```

Instant - dependencies already installed.

## Migration Guide

### Old Approach (Wrapper Script)
```json
{
  "tools": [{
    "command": "./run.sh",
    "args": ["search"]
  }]
}
```

Required `run.sh`:
```bash
#!/bin/bash
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -d "$PLUGIN_DIR/venv" ]; then
    python3 -m venv "$PLUGIN_DIR/venv"
    "$PLUGIN_DIR/venv/bin/pip" install -r "$PLUGIN_DIR/requirements.txt"
fi
exec "$PLUGIN_DIR/venv/bin/python3" "$PLUGIN_DIR/main.py" "$@"
```

### New Approach (Automatic)
```json
{
  "runtime": "python3",
  "dependencies": {
    "file": "requirements.txt"
  },
  "tools": [{
    "command": "python3",
    "args": ["main.py", "search"]
  }]
}
```

**No wrapper script needed!** Just declare runtime and dependencies.

## Benefits

1. **Simple** - Plugin authors just declare dependencies
2. **Isolated** - Each plugin gets its own environment
3. **Automatic** - No manual setup or wrapper scripts
4. **Cached** - Installations persist across restarts
5. **Transparent** - Plugin code doesn't change
6. **Scalable** - Easy to add support for Node.js, Ruby, etc.

## Future Enhancements

### Phase 3 (Future)
- **Node.js runtime** support (`npm install`)
- **Dependency caching** - Share common packages
- **Update management** - `/plugin update <name>` command
- **Health checks** - Validate dependencies periodically
- **Offline bundles** - Pre-packaged plugin + dependencies

## Files Changed

### New Files
- `src/plugins/PluginEnvironmentManager.ts` - Core dependency management
- `src/config/paths.ts` - Added `PLUGIN_ENVS_DIR`

### Modified Files
- `src/plugins/PluginLoader.ts` - Auto-install on load
- `src/plugins/ExecutableToolWrapper.ts` - Venv injection
- Plugin manifests - Added `runtime` and `dependencies`

### Removed Files
- Wrapper scripts (`run.sh`) - No longer needed
- Per-plugin venvs - Now managed centrally

## Testing

### Verify Installation
```bash
# Check that plugin-envs directory exists
ls ~/.ally/plugin-envs/

# Check specific plugin venv
ls ~/.ally/plugin-envs/dokuwiki-plugin/bin/python3

# Verify packages installed
~/.ally/plugin-envs/dokuwiki-plugin/bin/pip list
```

### Test Plugin Load
1. Remove existing plugin env: `rm -rf ~/.ally/plugin-envs/dokuwiki-plugin/`
2. Start Code Ally
3. Watch logs for dependency installation
4. Use plugin tool
5. Restart Code Ally - should be instant (cached)

## Troubleshooting

### Dependencies not installing
Check logs for:
- Python not found: Install Python 3.8+
- Network errors: Check internet connection
- Permission errors: Check `~/.ally/plugin-envs/` permissions

### Plugin not loading
- Verify `plugin.json` has `runtime` and `dependencies`
- Check `requirements.txt` exists and is valid
- Look for errors in Code Ally logs

### Force reinstall
```bash
rm -rf ~/.ally/plugin-envs/dokuwiki-plugin/
# Restart Code Ally to trigger reinstall
```

## Summary

Code Ally's automatic dependency management provides a clean, scalable solution for plugins with external dependencies. Plugin authors declare what they need, and Code Ally handles the rest - creating isolated environments, installing dependencies, and injecting the correct interpreters automatically.

**No wrapper scripts. No manual setup. Just declare and go.**
