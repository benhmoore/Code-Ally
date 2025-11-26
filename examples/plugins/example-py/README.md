# Example Python Plugin

A minimal Python plugin demonstrating the tool protocol.

## Files

- `plugin.json` — Plugin manifest
- `reverse.py` — Tool implementation

## Setup

```bash
cp -r examples/plugins/example-py ~/.ally/profiles/default/plugins/
ally
```

## Test

```bash
echo '{"text":"Hello World"}' | python3 reverse.py
```

## Protocol

**Input (stdin):**
```json
{"text": "Hello World", "preserve_case": true}
```

**Output (stdout):**
```json
{"success": true, "result": "dlroW olleH"}
```

See [docs/plugins.md](../../../docs/plugins.md) for the full development guide.
