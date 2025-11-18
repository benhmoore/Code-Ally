# Profiles Reference

User profiles for isolated configurations, plugins, agents, and prompts.

## Quick Start

```bash
# List all profiles
ally --profile-list

# Create new profile
ally --profile-create work

# Clone existing profile
ally --profile-create work2 --profile-from work

# Launch with profile
ally --profile work

# Set as default
ally --profile work
# (Opens normally, becomes new default)

# View profile info
ally --profile-info work

# Delete profile
ally --profile-delete work
```

## Quick Reference

```bash
ally --profiles  # Show cheatsheet
```

## What Are Profiles?

Profiles provide isolated environments for different contexts (work, personal, projects). Each profile maintains separate:

- **Plugins:** Installed tools and extensions
- **Agents:** Custom agent definitions
- **Prompts:** Custom prompt libraries
- **Configuration:** Model settings, preferences
- **Cache:** Completion and metadata cache

**Profiles are stored in:** `~/.ally/profiles/<profile-name>/`

## Profile Structure

```
~/.ally/profiles/
├── default/              # Default profile (always exists)
│   ├── profile.json      # Profile metadata
│   ├── config.json       # Profile-specific config
│   ├── agents/           # Custom agents
│   ├── plugins/          # Installed plugins
│   ├── plugin-envs/      # Plugin virtual environments
│   ├── prompts/          # Custom prompts
│   └── cache/            # Profile cache
└── work/                 # Custom profile
    └── ...
```

## Profile Commands

### List Profiles

```bash
ally --profile-list
```

Shows all profiles with:
- Name and active status
- Description
- Creation date
- Plugin/agent/prompt counts

### Create Profile

```bash
# Create empty profile
ally --profile-create <name>

# Clone from existing profile
ally --profile-create <name> --profile-from <source>
```

**Cloning behavior:**
- Copies: `config.json`, `agents/`, `prompts/`
- Does NOT copy: `plugin-envs/` (avoids environment conflicts)

**Name validation:**
- 1-50 characters
- Alphanumeric, hyphens, underscores only
- Cannot start with `.`
- Reserved names: `global`, `.`, `..`

### Switch Profile

```bash
# Launch with specific profile
ally --profile <name>

# Opens interactive session with that profile
# Becomes the new default profile
```

**Active profile tracking:**
- Stored in `~/.ally/active_profile`
- Persists across sessions
- Defaults to `default` if not set

### Profile Info

```bash
ally --profile-info <name>
```

Shows detailed information:
- Description and tags
- Creation and update timestamps
- Statistics (plugins, agents, prompts, config overrides)
- Active status

### Delete Profile

```bash
# Delete empty profile
ally --profile-delete <name>

# Force delete profile with data
ally --profile-delete <name> --profile-delete-force
```

**Protection:**
- Cannot delete `default` profile
- Cannot delete active profile (switch first)
- Requires `--profile-delete-force` if profile has data
- Moves to quarantine: `~/.ally/profiles/.deleted/<name>-<timestamp>/`

## Use Cases

### Work vs Personal

```bash
# Work profile: company plugins, work-related prompts
ally --profile-create work
ally --profile work
/plugin install jira-integration
/plugin install slack-notifier

# Personal profile: hobby projects, different model
ally --profile-create personal
ally --profile personal
/config set model llama3.2
```

### Project-Specific Profiles

```bash
# Frontend project: web-focused tools
ally --profile-create frontend-project
ally --profile frontend-project
/plugin install npm-helper
/plugin install browser-testing

# Backend project: API-focused tools
ally --profile-create backend-project
ally --profile backend-project
/plugin install api-testing
/plugin install database-tools
```

### Testing New Plugins

```bash
# Test profile: experiment without affecting main setup
ally --profile-create test --profile-from default
ally --profile test
/plugin install experimental-tool

# If it works, install in default
ally --profile default
/plugin install experimental-tool

# Clean up test profile
ally --profile-delete test --profile-delete-force
```

### Model-Specific Profiles

```bash
# Fast model for quick tasks
ally --profile-create quick
ally --profile quick
/config set model llama3.2
/config set temperature 0.5

# Powerful model for complex work
ally --profile-create powerful
ally --profile powerful
/config set model qwen2.5-coder:32b
/config set context_size 32768
```

## Configuration Per Profile

Each profile has independent configuration:

**Profile config location:** `~/.ally/profiles/<profile-name>/config.json`

**Inheritance:**
- Profile config overrides base config (`~/.ally/config.json`)
- CLI flags override profile config
- Priority: CLI flags > Profile config > Base config > Defaults

**Example workflow:**
```bash
# Set base defaults
ally --profile default
/config set temperature 0.3

# Override in work profile
ally --profile work
/config set temperature 0.1  # More deterministic for production code
/config set model qwen2.5-coder:32b
```

## Plugin Isolation

Plugins are installed per-profile:

```bash
# Work profile: business tools
ally --profile work
/plugin install jira-api
/plugin list  # Shows: jira-api

# Personal profile: different tools
ally --profile personal
/plugin list  # Shows: (empty or different plugins)
```

**Plugin virtual environments:**
- Each profile has separate `plugin-envs/` directory
- Python dependencies isolated per profile
- No conflicts between profile plugin versions

## Default Profile

The `default` profile:
- Always exists (created on first run)
- Cannot be deleted
- Used when no `--profile` specified (first time)
- No special privileges otherwise

**To reset everything:**
```bash
# Delete and recreate default profile (NOT SUPPORTED)
# Instead: reset config and remove plugins manually
ally --profile default
/config reset
/plugin list  # Remove plugins one by one
```

## Switching Profiles

**Method 1: CLI flag**
```bash
ally --profile work     # Opens session with work profile
ally --profile personal # Opens session with personal profile
```

**Method 2: Set as default**
```bash
# Launch any profile once to make it default
ally --profile work
# Future sessions use 'work' profile automatically
ally
```

**Check active profile:**
```bash
ally --profile-list  # Active profile marked with (active)
cat ~/.ally/active_profile  # Shows profile name
```

## Profile Metadata

`profile.json` structure:

```json
{
  "name": "work",
  "description": "Work profile with production tools",
  "created_at": "2025-01-15T10:30:00Z",
  "updated_at": "2025-01-16T14:22:00Z",
  "tags": ["work", "production"],
  "metadata": {}
}
```

**Metadata fields:**
- `name`: Profile identifier (immutable)
- `description`: Optional description
- `created_at`: ISO timestamp
- `updated_at`: Auto-updated on changes
- `tags`: Optional tags for organization
- `metadata`: Reserved for future use

## Migration

### Upgrading from Non-Profile Setup

Old setup (pre-profiles):
```
~/.ally/
├── config.json
├── plugins/
├── agents/
└── ...
```

**Migration:** Not needed. Old configs become base config, profiles work independently.

### Moving Data Between Profiles

```bash
# Export profile data (manual)
cp -r ~/.ally/profiles/work/agents/ /tmp/work-agents/
cp ~/.ally/profiles/work/config.json /tmp/work-config.json

# Import to new profile
ally --profile-create new
cp -r /tmp/work-agents/* ~/.ally/profiles/new/agents/
cp /tmp/work-config.json ~/.ally/profiles/new/config.json
```

**Or clone profile:**
```bash
ally --profile-create new --profile-from work
```

## Troubleshooting

### Profile not found

```bash
# Check available profiles
ally --profile-list

# Create if missing
ally --profile-create <name>
```

### Active profile deleted

System auto-falls back to `default` profile. Warning logged:
```
[WARN] Active profile 'work' not found, falling back to 'default'
```

### Profile corruption

```bash
# Check profile metadata
cat ~/.ally/profiles/<name>/profile.json

# If corrupted, recreate
ally --profile-delete <name> --profile-delete-force
ally --profile-create <name>
```

### Cannot delete profile

**Error:** `Cannot delete active profile`
```bash
# Switch to another profile first
ally --profile default
ally --profile-delete old-profile
```

**Error:** `Profile contains data`
```bash
# Force delete
ally --profile-delete <name> --profile-delete-force
```

## Advanced Usage

### Temporary Profile

```bash
# Create, use, delete
ally --profile-create temp
ally --profile temp
# ... do work ...
# Exit session
ally --profile-delete temp --profile-delete-force
```

### Profile for Each Client/Project

```bash
for project in client-a client-b client-c; do
  ally --profile-create "$project"
done

# Launch project profile
ally --profile client-a
```

### Automated Profile Setup

```bash
#!/bin/bash
# setup-profile.sh

PROFILE_NAME="$1"
ally --profile-create "$PROFILE_NAME"

# Configure via CLI
ally --profile "$PROFILE_NAME" --once "/config set model llama3.2"
ally --profile "$PROFILE_NAME" --once "/config set temperature 0.3"
```

## Storage and Performance

**Disk usage:**
- Base profile: ~1-5 MB
- With plugins: +10-50 MB per plugin
- With cache: +10-100 MB depending on usage

**Performance:**
- Profile switching: instant (next launch)
- No runtime overhead per profile
- Plugin loading: same as non-profile setup

**Cleanup:**
```bash
# Remove old profiles
ally --profile-list  # Review
ally --profile-delete old-profile --profile-delete-force

# Clear profile caches
rm -rf ~/.ally/profiles/*/cache/
```

## Further Reading

- [Configuration Reference](configuration.md) - Config options per profile
- [Plugin Development](../guides/plugin-development.md) - Creating profile plugins
- Source: `src/services/ProfileManager.ts`
