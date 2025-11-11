# Example Node.js Plugin

This is a simple example plugin demonstrating how to create an executable plugin using TypeScript and Node.js.

## Overview

The plugin provides a `reverse-string-node` tool that reverses text, with optional configuration for adding prefixes/suffixes.

## Files

- **plugin.json** - Plugin manifest defining the tool schema and configuration
- **package.json** - Node.js dependencies (minimal: just TypeScript and tsx)
- **reverse.ts** - TypeScript implementation with JSON stdin/stdout protocol
- **README.md** - This file

## Features

- JSON-based input/output via stdin/stdout
- Configuration support through environment variables
- Signal handling (SIGTERM/SIGINT) for graceful shutdown
- TypeScript with strict typing
- No build step required (uses tsx for execution)

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Copy to plugins directory:**
   ```bash
   cp -r examples/plugins/example-node ~/.ally/plugins/
   ```

3. **Restart Ally** - The plugin loads automatically!

## Testing Manually

You can test the plugin directly from the command line:

```bash
# Basic usage
echo '{"text":"Hello World"}' | npx tsx reverse.ts

# With preserve_case option
echo '{"text":"Hello World","preserve_case":false}' | npx tsx reverse.ts
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
echo '{"text":"Hello"}' | npx tsx reverse.ts
```

## Usage in Ally

Once installed, use it in conversation:

```
User: Use the reverse-string-node tool to reverse "Hello World"
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

- Uses async stdin reading for proper stream handling
- Implements proper TypeScript types for all data structures
- Handles errors gracefully with appropriate error types
- Matches the Python example's functionality exactly
- No build tooling - uses `tsx` to run TypeScript directly

## Comparison with Python Example

This plugin is functionally equivalent to the Python example (`examples/plugins/example-py/`):
- Same tool functionality (string reversal)
- Same configuration options
- Same JSON input/output format
- Same signal handling
- Same error handling patterns

The only differences are:
- Uses Node.js runtime instead of Python
- Tool name is `reverse-string-node` (vs `reverse-string-py`)
- Plugin name is `example-node-plugin` (vs `example-py-plugin`)
