# Configuration Reference

Code Ally configuration file: `~/.ally/config.json`

## Quick Setup

```bash
# Interactive setup
ally --init

# Show current config
ally --config-show

# Start with specific model
ally --model llama3.2

# Override temperature
ally --temperature 0.7
```

## Configuration File

**Location:** `~/.ally/config.json`

**Format:** JSON

**Example:**
```json
{
  "model": "llama3.2",
  "endpoint": "http://localhost:11434",
  "context_size": 16384,
  "temperature": 0.3,
  "bash_timeout": 30,
  "parallel_tools": true,
  "auto_compact": true,
  "compact_threshold": 0.8,
  "streaming": true,
  "default_focus": null,
  "confirm_destructive": true,
  "agent_pool_size": 10
}
```

## Configuration Options

### LLM Settings

#### `model`

**Type:** `string | null`

**Default:** `null` (auto-detect from Ollama)

**Description:** Ollama model name

**Examples:**
- `"llama3.2"`
- `"qwen2.5-coder:32b"`
- `"deepseek-coder-v2"`
- `null` (auto-detect first available model)

**Runtime override:**
```bash
ally --model llama3.2
```

**In-session:**
```
/model llama3.2
```

#### `endpoint`

**Type:** `string`

**Default:** `"http://localhost:11434"`

**Description:** Ollama API endpoint URL

**Examples:**
- `"http://localhost:11434"` (local)
- `"http://192.168.1.100:11434"` (remote)

#### `context_size`

**Type:** `number`

**Default:** `16384`

**Description:** Context window size in tokens

**Valid range:** `1024` to `1000000`

**Common values:**
- `16384` (16K - good balance)
- `32768` (32K - more context)
- `8192` (8K - faster, less memory)

**Notes:**
- Must match or be less than model's maximum
- Larger values use more memory
- Affects compaction behavior

#### `temperature`

**Type:** `number`

**Default:** `0.3`

**Description:** LLM sampling temperature

**Valid range:** `0.0` to `2.0`

**Guidelines:**
- `0.0` - `0.3`: Deterministic, focused (recommended for coding)
- `0.4` - `0.7`: Balanced creativity
- `0.8` - `2.0`: Creative, unpredictable

**Runtime override:**
```bash
ally --temperature 0.5
```

#### `streaming`

**Type:** `boolean`

**Default:** `true`

**Description:** Enable streaming responses from LLM

**Behavior:**
- `true`: Responses appear token-by-token
- `false`: Wait for complete response

**Recommendation:** Keep `true` for better UX

### Context Management

#### `auto_compact`

**Type:** `boolean`

**Default:** `true`

**Description:** Automatically compact conversation when context is full

**Behavior:**
- `true`: Summarizes conversation at threshold
- `false`: Stops when context full (requires manual /compact)

#### `compact_threshold`

**Type:** `number`

**Default:** `0.8` (80%)

**Description:** Context usage percentage that triggers auto-compaction

**Valid range:** `0.5` to `0.95`

**Examples:**
- `0.8`: Compact at 80% full (default)
- `0.9`: Compact at 90% full (more tolerance)
- `0.7`: Compact at 70% full (more aggressive)

### Tool Settings

#### `bash_timeout`

**Type:** `number`

**Default:** `30`

**Description:** Default timeout for bash commands in seconds

**Valid range:** `1` to `600` (10 minutes)

**Per-command override:**
```
Use bash to run "npm test" with timeout 60
```

#### `parallel_tools`

**Type:** `boolean`

**Default:** `true`

**Description:** Enable concurrent tool execution

**Behavior:**
- `true`: Run read-only tools in parallel (faster)
- `false`: Always run tools sequentially

**Notes:**
- Tools requiring confirmation always run sequentially
- Write operations always sequential even if `true`

### Security & Permissions

#### `confirm_destructive`

**Type:** `boolean`

**Default:** `true`

**Description:** Require confirmation for file modifications

**Behavior:**
- `true`: Prompts before write/edit/delete operations
- `false`: Auto-confirms all operations (dangerous!)

**Recommendation:** Keep `true` except in automated environments

#### `default_focus`

**Type:** `string | null`

**Default:** `null`

**Description:** Default focus directory (restricts file operations)

**Examples:**
- `null`: No restriction
- `"/home/user/project"`: Restrict to project dir
- `"~/code/myapp"`: Restrict to app dir (tilde expanded)

**Runtime override:**
```bash
ally --focus /path/to/project
```

**In-session:**
```
/focus /path/to/project
/focus clear
```

### Performance

#### `agent_pool_size`

**Type:** `number`

**Default:** `10`

**Description:** Maximum number of cached agent instances

**Valid range:** `1` to `100`

**Behavior:**
- Reuses agent instances for same configuration
- LRU eviction when pool is full
- Reduces initialization overhead for specialized agents

**Guidelines:**
- `5` - `10`: Good for most users
- `20` - `50`: Heavy agent usage
- `1`: Disable pooling (fresh agent every time)

### Session Management

#### `auto_save`

**Type:** `boolean`

**Default:** `true`

**Description:** Automatically save session after each message

**Behavior:**
- `true`: Session saved to `~/.ally/sessions/` automatically
- `false`: Manual save only

**Recommendation:** Keep `true` to prevent data loss

#### `session_keep_days`

**Type:** `number | null`

**Default:** `null` (keep forever)

**Description:** Days to keep old sessions before cleanup

**Examples:**
- `null`: Never delete
- `30`: Delete sessions older than 30 days
- `7`: Delete sessions older than 7 days

### UI Settings

#### `show_token_usage`

**Type:** `boolean`

**Default:** `true`

**Description:** Display context usage in status bar

#### `show_todos`

**Type:** `boolean`

**Default:** `true`

**Description:** Display active todos in status bar

#### `syntax_highlighting`

**Type:** `boolean`

**Default:** `true`

**Description:** Enable syntax highlighting for code blocks

## Runtime Configuration

### Command-line Overrides

Override config for single session:

```bash
ally --model llama3.2 --temperature 0.5 --focus ~/project
```

### In-session Commands

Modify configuration during session:

```
/config set temperature 0.7
/config set model qwen2.5-coder:32b
/config show
/config reset
```

**Persistence:** In-session changes are saved to config file immediately

## Advanced Configuration

### Custom Model Settings

Some models need specific settings:

**DeepSeek Coder:**
```json
{
  "model": "deepseek-coder-v2",
  "context_size": 32768,
  "temperature": 0.2
}
```

**Qwen 2.5 Coder:**
```json
{
  "model": "qwen2.5-coder:32b",
  "context_size": 32768,
  "temperature": 0.3
}
```

**Llama 3.2:**
```json
{
  "model": "llama3.2",
  "context_size": 8192,
  "temperature": 0.4
}
```

### Development Settings

For development/testing:

```json
{
  "model": "llama3.2",
  "auto_compact": false,
  "confirm_destructive": false,
  "bash_timeout": 300,
  "agent_pool_size": 1
}
```

### Performance Tuning

For faster responses:

```json
{
  "context_size": 8192,
  "compact_threshold": 0.7,
  "parallel_tools": true,
  "agent_pool_size": 20
}
```

For maximum context:

```json
{
  "context_size": 32768,
  "compact_threshold": 0.9,
  "auto_compact": true
}
```

## Plugin Configuration

Plugin settings stored separately in config file:

```json
{
  "plugins": {
    "my-plugin": {
      "api_key": "encrypted:...",
      "endpoint": "https://api.example.com",
      "timeout": 30
    }
  }
}
```

**Configure plugin:**
```
/plugin configure my-plugin
```

**Encrypted fields:** Fields marked as encrypted in plugin manifest are encrypted at rest

## Environment Variables

Override config with environment variables:

```bash
export ALLY_MODEL=llama3.2
export ALLY_TEMPERATURE=0.7
export ALLY_ENDPOINT=http://localhost:11434
ally
```

**Priority:** CLI args > Environment vars > Config file > Defaults

## Configuration Validation

Code Ally validates configuration on startup:

**Type checking:**
- `temperature` must be number in 0.0-2.0
- `context_size` must be number in 1024-1000000
- `model` must be string or null

**Coercion:**
- Strings converted to numbers where appropriate
- Invalid values fall back to defaults

**Warnings:**
- Unknown config keys logged but ignored
- Invalid values reset to defaults

## Migration

### From Python Version

Config format mostly compatible:

**Rename:**
- `model_name` → `model`
- `api_endpoint` → `endpoint`

**Remove (no longer used):**
- `log_level` (use `--debug` flag)
- `ui_theme` (not applicable to terminal)

**Update script:**
```python
import json

with open('~/.ally/config.json') as f:
    config = json.load(f)

# Rename fields
if 'model_name' in config:
    config['model'] = config.pop('model_name')
if 'api_endpoint' in config:
    config['endpoint'] = config.pop('api_endpoint')

# Remove old fields
for old_key in ['log_level', 'ui_theme']:
    config.pop(old_key, None)

with open('~/.ally/config.json', 'w') as f:
    json.dump(config, f, indent=2)
```

## Troubleshooting

### Config not loading

```bash
# Check file exists
ls ~/.ally/config.json

# Validate JSON
cat ~/.ally/config.json | jq

# Reset to defaults
ally --init
```

### Model not found

```bash
# List available models
ollama list

# Pull model
ollama pull llama3.2

# Check endpoint
curl http://localhost:11434/api/tags
```

### Invalid values

Code Ally auto-corrects most invalid values:

```
[WARN] Invalid temperature 5.0, using default 0.3
[WARN] Unknown config key 'foo', ignoring
```

Check logs for validation warnings:
```bash
ally --debug
```

## Defaults

Full default configuration:

```json
{
  "model": null,
  "endpoint": "http://localhost:11434",
  "context_size": 16384,
  "temperature": 0.3,
  "bash_timeout": 30,
  "parallel_tools": true,
  "auto_compact": true,
  "compact_threshold": 0.8,
  "streaming": true,
  "default_focus": null,
  "confirm_destructive": true,
  "agent_pool_size": 10,
  "auto_save": true,
  "session_keep_days": null,
  "show_token_usage": true,
  "show_todos": true,
  "syntax_highlighting": true
}
```

## Further Reading

- [Architecture Overview](../architecture/overview.md)
- [Plugin Development](../guides/plugin-development.md)
- Source: `src/config/defaults.ts`
