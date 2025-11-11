# Example Python Plugin

This is a simple example plugin demonstrating how to create an executable plugin using Python.

## Overview

The plugin provides a `reverse-string-py` tool that reverses text, with optional configuration for adding prefixes/suffixes.

## Files

- **plugin.json** - Plugin manifest defining the tool schema and configuration
- **reverse.py** - Python implementation with JSON stdin/stdout protocol
- **README.md** - This file

## Features

- JSON-based input/output via stdin/stdout
- Configuration support through environment variables
- Signal handling (SIGTERM/SIGINT) for graceful shutdown
- Type hints for better code clarity
- No build step required (runs directly with python3)

## Setup

1. **Copy to plugins directory:**
   ```bash
   cp -r examples/plugins/example-py ~/.ally/plugins/
   ```

2. **Restart Ally** - The plugin loads automatically!

Note: No dependencies to install - uses only Python standard library!

## Testing Manually

You can test the plugin directly from the command line:

```bash
# Basic usage
echo '{"text":"Hello World"}' | python3 reverse.py

# With preserve_case option
echo '{"text":"Hello World","preserve_case":false}' | python3 reverse.py
```

## Configuration

The plugin supports optional configuration parameters:

- **prefix** - Text to prepend to reversed strings
- **suffix** - Text to append to reversed strings
- **api_key** - Example secret (demonstrates encryption support)

Configuration is passed via environment variables:
```bash
PLUGIN_CONFIG_PREFIX="[" \
PLUGIN_CONFIG_SUFFIX="]" \
echo '{"text":"Hello"}' | python3 reverse.py
```

## Usage in Ally

Once installed, use it in conversation:

```
User: Use the reverse-string-py tool to reverse "Hello World"
```

## JSON Protocol

**Input (stdin):**
```json
{
  "text": "Hello World",
  "preserve_case": true
}
```

**Output (stdout):**
```json
{
  "success": true,
  "original": "Hello World",
  "reversed": "dlroW olleH",
  "length": 11,
  "preserved_case": true,
  "config_applied": {
    "prefix": null,
    "suffix": null,
    "api_key_present": false
  }
}
```

**Error output:**
```json
{
  "success": false,
  "error": "Missing required parameter: text",
  "error_type": "validation_error"
}
```

## Implementation Notes

- Uses stdin reading for proper stream handling
- Implements type hints for all function parameters
- Handles errors gracefully with appropriate error types
- Matches the Node.js example's functionality exactly
- No dependencies or build tooling - uses standard library only

## Comparison with Node.js Example

This plugin is functionally equivalent to the Node.js example (`examples/plugins/example-node/`):
- Same tool functionality (string reversal)
- Same configuration options
- Same JSON input/output format
- Same signal handling
- Same error handling patterns

The only differences are:
- Uses Python runtime instead of Node.js
- Tool name is `reverse-string-py` (vs `reverse-string-node`)
- Plugin name is `example-py-plugin` (vs `example-node-plugin`)
