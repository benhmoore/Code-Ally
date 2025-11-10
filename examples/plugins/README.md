# Ally Plugin Examples

This directory contains example plugins demonstrating how to extend Ally with executable plugins.

## Quick Start

To use these examples:

```bash
# Copy an example to your plugins directory
cp -r examples/plugins/example ~/.ally/plugins/reverse-string

# Restart Ally - plugins load automatically!
```

---

## Example 1: Executable Plugin (Python)

**Location:** `example/`

A string reversal plugin that demonstrates executable plugins (Python, shell scripts, etc.).

### Files:
- `plugin.json` - Plugin manifest with schema definition
- `reverse.py` - Python script with JSON I/O

### Features:
- Cross-language support (Python in this case)
- JSON-based input/output
- No Ally dependencies required
- Process isolation
- Can be any executable (Python, Ruby, Go, shell scripts, etc.)

### Usage in Ally:
```
User: Use the reverse_string tool to reverse "Hello World"
```

---

## Example 2: Background Plugin with Event Subscription

**Location:** `conversation-monitor/`

A conversation monitoring plugin that demonstrates background plugins with event subscription.

### Files:
- `plugin.json` - Plugin manifest with background daemon and event configuration
- `daemon.py` - Persistent daemon process with JSON-RPC server
- `requirements.txt` - Python dependencies (none needed for this example)

### Features:
- **Background daemon mode** - Runs persistently alongside Ally
- **Event subscription** - Receives read-only events from Ally (tool calls, agents, todos)
- **Stateful tracking** - Maintains conversation statistics across tool invocations
- **JSON-RPC communication** - Tools communicate via Unix socket instead of stdin/stdout
- **Real-time monitoring** - Tracks metrics as conversation progresses

### Event Types Subscribed:
- `TOOL_CALL_START` / `TOOL_CALL_END` - Track tool usage
- `AGENT_START` / `AGENT_END` - Monitor agent invocations
- `TODO_UPDATE` - Count todo list changes
- `CONTEXT_USAGE_UPDATE` - Track current context usage

### Tracked Metrics:
- Total tool calls (success/failed breakdown)
- Agent invocations (main agent vs subagents)
- Per-tool usage breakdown
- Todo update count
- Current context usage percentage
- Tool success rate

### Usage in Ally:
```
User: What are the current conversation statistics?
Assistant: [Uses get-conversation-stats tool]

User: How many tools have been called so far?
Assistant: [Uses get-conversation-stats to show tool breakdown]

User: Reset the statistics
Assistant: [Uses reset-conversation-stats tool]
```

### Installation:
```bash
# Copy to plugins directory
cp -r examples/plugins/conversation-monitor ~/.ally/plugins/

# Restart Ally - the daemon starts automatically!
```

---

## Plugin Development Guide

For complete documentation on creating plugins, see the full guide at:
`/Users/bhm128/code-ally/src/plugins/USAGE.md`

### Quick Reference

**Plugin Structure:**
```
my-plugin/
  ├── plugin.json        # Plugin manifest
  └── script.py          # JSON I/O via stdin/stdout
```

---

## Testing Your Plugin

```bash
# 1. Copy to plugins directory
cp -r my-plugin ~/.ally/plugins/

# 2. Restart Ally
ally

# 3. Test in conversation
User: Use my_tool to do something
```

---

## Need Help?

- Check `/Users/bhm128/code-ally/src/plugins/USAGE.md` for full documentation
- Review these examples
