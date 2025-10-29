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

## Example: Executable Plugin (Python)

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
