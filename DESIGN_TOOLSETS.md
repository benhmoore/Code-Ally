# Toolsets & Interactive Plugin Configuration - Design Document

## Overview

This document outlines the architectural design for:
1. **Toolsets** - Multiple tools per plugin (default pattern)
2. **Interactive Plugin Configuration** - User-friendly credential/config management

---

## Part 1: Toolset Architecture

### Current Limitation
- One plugin directory → One tool
- Single tool name derived from plugin name
- No way to group related tools

### New Design: Toolsets as Default Pattern

**Every plugin is now a toolset**, even if it contains only one tool.

---

### Manifest Schema

#### New Structure (plugin.json)

```json
{
  "name": "dokuwiki",
  "version": "1.0.0",
  "description": "DokuWiki integration suite",
  "author": "Your Name",

  "tools": [
    {
      "name": "dokuwiki_search",
      "description": "Search DokuWiki pages by query",
      "command": "python3",
      "args": ["main.py", "search"],
      "requiresConfirmation": false,
      "timeout": 30000,
      "schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Search query"
          },
          "max_results": {
            "type": "number",
            "description": "Maximum number of results (default: 10)"
          }
        },
        "required": ["query"]
      }
    },
    {
      "name": "dokuwiki_read",
      "description": "Read a DokuWiki page's content",
      "command": "python3",
      "args": ["main.py", "read"],
      "requiresConfirmation": false,
      "timeout": 20000,
      "schema": {
        "type": "object",
        "properties": {
          "page_id": {
            "type": "string",
            "description": "Page ID or URL to read"
          }
        },
        "required": ["page_id"]
      }
    },
    {
      "name": "dokuwiki_navigate",
      "description": "Navigate to a DokuWiki page",
      "command": "python3",
      "args": ["main.py", "navigate"],
      "requiresConfirmation": false,
      "schema": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "Full or relative URL"
          }
        },
        "required": ["url"]
      }
    }
  ],

  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "wiki_url": {
          "type": "string",
          "description": "DokuWiki base URL",
          "required": true
        },
        "username": {
          "type": "string",
          "description": "DokuWiki username",
          "required": false
        },
        "password": {
          "type": "string",
          "description": "DokuWiki password",
          "secret": true,
          "required": false
        }
      }
    }
  }
}
```

---

### Backward Compatibility

**Old Format (Single Tool):**
```json
{
  "name": "reverse-string",
  "command": "python3",
  "args": ["reverse.py"],
  "schema": { /* ... */ }
}
```

**Auto-converted to:**
```json
{
  "name": "reverse-string",
  "tools": [
    {
      "name": "reverse_string",
      "command": "python3",
      "args": ["reverse.py"],
      "schema": { /* ... */ }
    }
  ]
}
```

---

### PluginManifest Interface Changes

**Before:**
```typescript
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  command: string;
  args?: string[];
  requiresConfirmation?: boolean;
  schema?: any;
  author?: string;
}
```

**After:**
```typescript
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;

  // Toolset definition
  tools: ToolDefinition[];

  // Plugin configuration (optional)
  config?: PluginConfigSchema;
}

export interface ToolDefinition {
  name: string;
  description: string;
  command: string;
  args?: string[];
  requiresConfirmation?: boolean;
  timeout?: number;  // Per-tool timeout override
  schema?: any;      // JSON Schema for tool parameters
}

export interface PluginConfigSchema {
  schema: {
    type: 'object';
    properties: Record<string, ConfigProperty>;
  };
}

export interface ConfigProperty {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
  secret?: boolean;     // Marks sensitive data (passwords, tokens)
  default?: any;
}
```

---

### PluginLoader Changes

**Current Flow:**
```
loadPlugins()
  → loadPlugin() → returns single BaseTool
    → tools.push(tool)
```

**New Flow:**
```
loadPlugins()
  → loadPlugin() → returns BaseTool[] (array of tools)
    → tools.push(...pluginTools)  // Spread array
```

**Key Changes:**

1. **loadPlugin() returns BaseTool[]** instead of BaseTool
2. Loop through `manifest.tools` array
3. Create one ExecutableToolWrapper per tool
4. Each tool gets its own name, command, args, schema
5. Share plugin directory (`pluginPath`) across all tools

**Code Structure:**
```typescript
private async loadPlugin(pluginPath: string): Promise<BaseTool[]> {
  const manifest = await this.readManifest(pluginPath);

  // Backward compatibility: convert old format
  if (!manifest.tools && manifest.command) {
    manifest.tools = [{
      name: manifest.name.replace(/-/g, '_'),
      description: manifest.description,
      command: manifest.command,
      args: manifest.args,
      requiresConfirmation: manifest.requiresConfirmation,
      schema: manifest.schema
    }];
  }

  const tools: BaseTool[] = [];

  for (const toolDef of manifest.tools) {
    const tool = await this.loadToolFromDefinition(
      toolDef,
      pluginPath,
      manifest
    );
    tools.push(tool);
  }

  return tools;
}

private async loadToolFromDefinition(
  toolDef: ToolDefinition,
  pluginPath: string,
  manifest: PluginManifest
): Promise<BaseTool> {
  const { ExecutableToolWrapper } = await import('./ExecutableToolWrapper.js');

  // Create wrapper with tool-specific configuration
  return new ExecutableToolWrapper(
    toolDef,
    pluginPath,
    this.activityStream,
    toolDef.timeout
  );
}
```

---

### ExecutableToolWrapper Changes

**Constructor signature update:**

**Before:**
```typescript
constructor(
  manifest: PluginManifest,
  pluginPath: string,
  activityStream: ActivityStream,
  timeout?: number
)
```

**After:**
```typescript
constructor(
  toolDef: ToolDefinition,
  pluginPath: string,
  activityStream: ActivityStream,
  timeout?: number
)
```

**Changes:**
- Accept `ToolDefinition` instead of full `PluginManifest`
- Extract name, description, command, args, schema from toolDef
- Simpler, focused interface

---

## Part 2: Interactive Plugin Configuration

### Architecture Pattern (based on SetupWizard)

#### Flow:

```
1. Plugin loads → checks for config
2. If missing/incomplete → emits PLUGIN_CONFIG_REQUEST event
3. App.tsx listens → shows PluginConfigView modal
4. User fills form → submits
5. Emits PLUGIN_CONFIG_COMPLETE event
6. PluginConfigManager saves to ~/.ally/plugins/{name}/config.json
7. Plugin can now access config
```

---

### Configuration Storage

**Location:** `~/.ally/plugins/{plugin-name}/config.json`

**Example:**
```json
{
  "wiki_url": "https://wiki.example.com",
  "username": "admin",
  "password": "encrypted:abc123..."
}
```

**Security:**
- Passwords/tokens marked with `"secret": true` in schema
- Encrypted using Node.js crypto module
- Never logged or displayed

---

### Activity Stream Events

**New Event Types:**
```typescript
export enum ActivityEventType {
  // ... existing events
  PLUGIN_CONFIG_REQUEST = 'plugin_config_request',
  PLUGIN_CONFIG_COMPLETE = 'plugin_config_complete',
  PLUGIN_CONFIG_CANCEL = 'plugin_config_cancel',
}
```

**Event Payloads:**

```typescript
// Request event (emitted by plugin or PluginLoader)
{
  id: 'plugin_config_request_123',
  type: ActivityEventType.PLUGIN_CONFIG_REQUEST,
  timestamp: Date.now(),
  data: {
    pluginName: 'dokuwiki',
    configSchema: manifest.config.schema,
    existingConfig: { /* partial config */ },
    reason: 'Missing required configuration: wiki_url, username'
  }
}

// Complete event (emitted by UI)
{
  id: 'plugin_config_complete_123',
  type: ActivityEventType.PLUGIN_CONFIG_COMPLETE,
  timestamp: Date.now(),
  data: {
    pluginName: 'dokuwiki',
    config: {
      wiki_url: 'https://wiki.example.com',
      username: 'admin',
      password: 'secret123'
    }
  }
}
```

---

### PluginConfigManager Service

**Responsibilities:**
1. Save/load plugin configurations
2. Encrypt/decrypt sensitive fields
3. Validate against schema
4. Handle missing config detection

**API:**
```typescript
export class PluginConfigManager {
  async saveConfig(pluginName: string, config: any): Promise<void>
  async loadConfig(pluginName: string): Promise<any | null>
  async deleteConfig(pluginName: string): Promise<void>

  // Check if config is complete
  isConfigComplete(
    pluginName: string,
    schema: PluginConfigSchema
  ): Promise<boolean>

  // Encrypt sensitive fields
  private encryptSecrets(config: any, schema: PluginConfigSchema): any
  private decryptSecrets(config: any, schema: PluginConfigSchema): any
}
```

**Storage Path:**
```
~/.ally/plugins/
  ├── dokuwiki/
  │   ├── plugin.json
  │   ├── config.json       # User configuration (encrypted secrets)
  │   ├── main.py
  │   └── ...
  └── other-plugin/
      └── ...
```

---

### Plugin Access to Configuration

#### Option A: Environment Variables (RECOMMENDED)

**ExecutableToolWrapper injects config as environment:**

```typescript
const child = spawn(this.command, this.commandArgs, {
  cwd: this.workingDir,
  env: {
    ...process.env,
    PLUGIN_CONFIG_PATH: join(this.workingDir, 'config.json'),
    // Or inject directly:
    DOKUWIKI_URL: config.wiki_url,
    DOKUWIKI_USER: config.username,
    DOKUWIKI_PASS: config.password
  },
  stdio: ['pipe', 'pipe', 'pipe']
});
```

**Plugin reads from environment:**
```python
import os

wiki_url = os.getenv('DOKUWIKI_URL')
username = os.getenv('DOKUWIKI_USER')
password = os.getenv('DOKUWIKI_PASS')

if not wiki_url:
    # Emit error indicating config needed
    print(json.dumps({
        'success': False,
        'error': 'Configuration required',
        'error_type': 'config_required',
        'config_needed': ['wiki_url', 'username', 'password']
    }))
    sys.exit(1)
```

#### Option B: Config File Path

**ExecutableToolWrapper passes path to config:**
```typescript
this.commandArgs = [
  ...toolDef.args,
  '--config', join(this.workingDir, 'config.json')
];
```

**Plugin loads config:**
```python
import json
import sys

with open(sys.argv[-1]) as f:  # Last arg is config path
    config = json.load(f)

wiki_url = config['wiki_url']
```

---

### UI: PluginConfigView Component

**Similar to SetupWizardView, but dynamic based on schema:**

```tsx
interface PluginConfigViewProps {
  pluginName: string;
  configSchema: PluginConfigSchema;
  existingConfig?: any;
  onComplete: (config: any) => void;
  onCancel: () => void;
}

export const PluginConfigView: React.FC<PluginConfigViewProps> = ({
  pluginName,
  configSchema,
  existingConfig,
  onComplete,
  onCancel
}) => {
  const [formData, setFormData] = useState(existingConfig || {});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Dynamically render form fields based on schema
  const renderField = (key: string, prop: ConfigProperty) => {
    if (prop.secret) {
      return <PasswordInput key={key} /* ... */ />;
    } else if (prop.type === 'boolean') {
      return <Checkbox key={key} /* ... */ />;
    } else if (prop.type === 'number') {
      return <NumberInput key={key} /* ... */ />;
    } else {
      return <TextInput key={key} /* ... */ />;
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Configure {pluginName}</Text>
      <Text dimColor>Please provide the following configuration:</Text>

      <Box flexDirection="column" marginTop={1}>
        {Object.entries(configSchema.schema.properties).map(([key, prop]) =>
          renderField(key, prop)
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="green">Save (Enter)</Text>
        <Text dimColor> | </Text>
        <Text color="red">Cancel (Esc)</Text>
      </Box>
    </Box>
  );
};
```

---

### Integration in PluginLoader

**When loading a plugin:**

```typescript
async loadPlugins(pluginDir: string): Promise<BaseTool[]> {
  // ... existing loading logic

  for (const pluginPath of pluginDirs) {
    const manifest = await this.readManifest(pluginPath);

    // Check if plugin requires configuration
    if (manifest.config) {
      const configManager = ServiceRegistry.getInstance().get('plugin_config_manager');
      const isComplete = await configManager.isConfigComplete(
        manifest.name,
        manifest.config
      );

      if (!isComplete) {
        // Emit request for configuration
        this.activityStream.emit({
          id: `plugin_config_${manifest.name}_${Date.now()}`,
          type: ActivityEventType.PLUGIN_CONFIG_REQUEST,
          timestamp: Date.now(),
          data: {
            pluginName: manifest.name,
            configSchema: manifest.config,
            reason: 'Missing required configuration'
          }
        });

        // Skip loading this plugin for now
        // It will be loaded after config is provided
        continue;
      }
    }

    // Load tools normally
    const tools = await this.loadPlugin(pluginPath, manifest);
    allTools.push(...tools);
  }

  return allTools;
}
```

---

### User Experience Flow

#### First-Time Plugin Use:

```
1. User installs dokuwiki plugin in ~/.ally/plugins/dokuwiki/
2. User restarts Ally
3. PluginLoader detects plugin needs config
4. Emits PLUGIN_CONFIG_REQUEST
5. UI shows modal: "Configure dokuwiki"
   - Wiki URL: [input]
   - Username: [input]
   - Password: [password input]
   - [Save] [Cancel]
6. User fills form, clicks Save
7. PluginConfigManager encrypts password, saves config.json
8. Emits PLUGIN_CONFIG_COMPLETE
9. PluginLoader reloads plugin, now passes config via env vars
10. Tools are now available: dokuwiki_search, dokuwiki_read, etc.
```

#### Subsequent Uses:

```
1. User restarts Ally
2. PluginLoader checks for config → found!
3. Loads plugin normally with config
4. Tools immediately available
```

#### Reconfiguration:

```
User can run: /plugin config dokuwiki
  → Shows config modal again
  → Updates config.json
  → Reloads plugin
```

---

## Part 3: DokuWiki Plugin Implementation

With this architecture, the DokuWiki plugin structure becomes:

```
~/.ally/plugins/dokuwiki/
├── plugin.json              # Toolset manifest
├── config.json              # User config (auto-created)
├── main.py                  # Entry point router
├── requirements.txt
├── browser_manager.py       # Selenium driver management
├── operations/
│   ├── __init__.py
│   ├── search.py           # Search implementation
│   ├── read.py             # Read implementation
│   ├── navigate.py         # Navigate implementation
│   └── get_links.py        # Get links implementation
└── utils/
    ├── config_loader.py    # Loads config from env
    └── selenium_helpers.py # Shared Selenium utilities
```

**main.py:**
```python
#!/usr/bin/env python3
import sys
import json
from utils.config_loader import load_config
from operations import search, read, navigate, get_links

def main():
    # Load configuration from environment
    config = load_config()

    # Check if configured
    if not config.get('wiki_url'):
        print(json.dumps({
            'success': False,
            'error': 'Plugin not configured',
            'error_type': 'config_required',
            'config_needed': ['wiki_url']
        }))
        sys.exit(1)

    # Read input from stdin
    input_data = json.loads(sys.stdin.read())

    # Route to operation (based on command line arg)
    operation = sys.argv[1] if len(sys.argv) > 1 else 'search'

    try:
        if operation == 'search':
            result = search.execute(config, input_data)
        elif operation == 'read':
            result = read.execute(config, input_data)
        elif operation == 'navigate':
            result = navigate.execute(config, input_data)
        elif operation == 'get_links':
            result = get_links.execute(config, input_data)
        else:
            result = {
                'success': False,
                'error': f'Unknown operation: {operation}'
            }
    except Exception as e:
        result = {
            'success': False,
            'error': str(e),
            'error_type': 'execution_error'
        }

    print(json.dumps(result))

if __name__ == '__main__':
    main()
```

---

## Implementation Plan

### Phase 1: Toolset Support
1. Update PluginManifest interface
2. Update PluginLoader to return BaseTool[]
3. Update ExecutableToolWrapper to accept ToolDefinition
4. Add backward compatibility for old format
5. Update examples and documentation

### Phase 2: Plugin Configuration
1. Add PluginConfigManager service
2. Add PLUGIN_CONFIG_* event types
3. Create PluginConfigView UI component
4. Integrate config checking in PluginLoader
5. Add /plugin config command

### Phase 3: DokuWiki Plugin
1. Port dokuwiki-crawler code to plugin structure
2. Implement all four operations (search, read, navigate, get_links)
3. Add auto-retry logic
4. Test end-to-end

---

## Questions for Approval

1. **Toolset Manifest**: Do you approve the new `tools` array structure?

2. **Backward Compatibility**: Should we auto-convert old single-tool format?

3. **Config Injection**: Prefer environment variables or config file path?

4. **Config Storage**: Is `~/.ally/plugins/{name}/config.json` acceptable?

5. **Secret Encryption**: Should we use Node.js crypto or a library like `keytar`?

6. **First-Time Flow**: Should config request happen on plugin load or on first tool use?

Ready to proceed once you approve the design!
