# Example Node.js Plugin

A minimal Node.js/TypeScript plugin demonstrating the tool protocol.

## Files

- `plugin.json` — Plugin manifest
- `reverse.ts` — Tool implementation
- `package.json` — Dependencies

## Setup

```bash
cd examples/plugins/example-node && npm install
cp -r examples/plugins/example-node ~/.ally/profiles/default/plugins/
ally
```

## Test

```bash
echo '{"text":"Hello World"}' | npx tsx reverse.ts
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
