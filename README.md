# Code Ally <sup style="color: #ffc800;">( ^)></sup>

<p align="center">
  <img src="docs/hero.png" alt="Code Ally terminal interface" width="700">
</p>

Terminal-based AI coding assistant that runs in your CLI. Built with TypeScript, React, and Ink. Heavily inspired by [Claude Code](https://github.com/anthropics/claude-code).

Code Ally gives you an AI that lives where you work—your terminal. It reads your code, runs your commands, and remembers your conversation across sessions. When the built-in tools aren't enough, write your own in Python or Node.js. When one agent isn't enough, create specialists that delegate to each other.

## Feature Spotlight

- **Expert delegation** — Delegate to specialized agents created by you or Ally
- **Agent skills** — Reusable workflows that load on-demand (open standard)
- **Todo list** — Ally can keep a todo list as it works to stay on track
- **Plugins** — Extend with custom tools and agents in Python or Node.js
- **Change tracking** — Full undo support for file modifications
- **Session persistence** — Resume conversations across restarts

## Recommended Models

Tested to work best with these models:

- `gpt-oss:20b` — Balanced performance and speed
- `gpt-oss:120b` — Best quality for complex tasks
- `glm-4.6:cloud` — Cloud-hosted option via Ollama

## Installation

```bash
npm install
npm run build
npm link  # Makes 'ally' command available globally
```

## Usage

```bash
ally                        # Start interactive session
ally --model llama3.2       # Use specific model
ally --once "explain this"  # Single message mode
ally --resume               # Resume previous session
ally --init                 # Initial setup
ally --profile work         # Use profile
```

## Commands

### Core

| Command | Description |
|---------|-------------|
| `/help [topic]` | Show help, optionally filtered by topic |
| `/config` | View configuration; `/config set key=value` to modify |
| `/model <name>` | Switch LLM model |
| `/compact [instructions]` | Summarize conversation to free context |
| `/undo` | Revert file changes (interactive selector) |
| `/rewind` | Go back to earlier message |
| `/resume [session]` | Resume previous session |
| `/clear` | Clear conversation history |
| `/init` | Run setup wizard |
| `/exit` | Exit the application |

### Agents

| Command | Description |
|---------|-------------|
| `/agent list` | List available agents |
| `/agent create` | Create new agent (wizard) |
| `/agent use <name> <task>` | Run task with specific agent |
| `/agent show <name>` | View agent details |
| `/agent delete <name>` | Delete an agent |
| `/agent active` | Show pooled agents |
| `/agent stats` | Pool statistics |
| `/agent clear [id]` | Clear agent(s) from pool |
| `/switch <agent>` | Switch to different agent |
| `/switch ally` | Return to main agent |

### Skills

| Command | Description |
|---------|-------------|
| `/skill list` | List available skills |
| `/skill show <name>` | View skill details |
| `/skill reload` | Reload skills from disk |

### Project

| Command | Description |
|---------|-------------|
| `/project init` | Initialize ALLY.md |
| `/project view` | View project context |
| `/project edit` | Edit ALLY.md |
| `/focus <path>` | Restrict operations to directory |
| `/defocus` | Clear focus restriction |
| `/add-dir <path>` | Add working directory |
| `/remove-dir <path>` | Remove working directory |
| `/list-dirs` | List working directories |

### Other

| Command | Description |
|---------|-------------|
| `/todo` | View todo list |
| `/todo add <task>` | Add task |
| `/prompt` | Browse saved prompts |
| `/prompt add` | Save new prompt |
| `/task list` | List background tasks |
| `/task kill <id>` | Kill background task |
| `/plugin list` | List plugins |
| `/plugin info <name>` | Plugin details |
| `/debug` | Debug tools (`enable`, `disable`, `calls`, `errors`, `dump`) |

## Input Modes

Special characters at the start of input:

| Prefix | Action |
|--------|--------|
| `!command` | Run bash command directly |
| `#note` | Save note to ALLY.md |
| `@path` | Mention file or directory |
| `+plugin` | Enable plugin for session |
| `-plugin` | Disable plugin for session |

## Tools

The agent has access to these built-in tools:

**File Operations**
- `read` — Read file contents (supports offset/limit for large files)
- `write` — Create new files
- `edit` — Find-and-replace text editing
- `line-edit` — Edit by line number (insert, delete, replace)

**Search & Discovery**
- `glob` — Find files by pattern (`*.ts`, `**/*.test.js`)
- `grep` — Search file contents with regex
- `ls` — List directory contents
- `tree` — Display directory structure

**Execution**
- `bash` — Run shell commands (with timeout, background support)
- `bash-output` — Read output from background processes
- `kill-shell` — Terminate background processes

**Planning**
- `todo-write` — Manage task list
- `explore` — Delegate exploration to specialized agent
- `plan` — Create implementation plans

## Agents

Agents are specialized assistants with focused capabilities.

**Using agents:**
```
"Delegate to explore: find all API endpoints"
"Have plan create an implementation plan for user auth"
```

**Creating agents:**
```
/agent create
```

Opens a wizard to define:
- Name and description
- System prompt
- Available tools
- Model and temperature

**Switching context:**
```
/switch explore     # Switch to explore agent
/switch ally        # Return to main agent
```

Agents persist in a pool. Use `/agent active` to see running agents, `/agent clear` to free memory.

See [docs/plugins.md](docs/plugins.md) for creating agents via plugins.

## Skills

Skills are reusable workflows that Ally loads on-demand. They follow an [open standard](https://agentskills.io) compatible with GitHub Copilot, Cursor, and other AI tools.

**Skill locations** (in priority order):
```
.github/skills/      # Project (standard)
.claude/skills/      # Project (legacy)
.ally/skills/        # Project (Ally-native)
~/.ally/skills/      # User (global)
```

**SKILL.md format:**
```markdown
---
name: code-review
description: Systematic code review workflow. Use when reviewing code or PRs.
---

# Code Review Skill

Follow this process when reviewing code...
```

**Commands:**
```
/skill list          # List available skills
/skill show <name>   # View skill details
/skill reload        # Reload from disk
```

Skills are automatically discovered and loaded when relevant. See [examples/skills/code-review](examples/skills/code-review) for a complete example.

## Focus Mode

Restrict file operations to a specific directory:

```
/focus src/components    # Only operate within src/components
/defocus                 # Remove restriction
```

Add directories beyond cwd:
```
/add-dir ../shared-lib   # Allow access to sibling directory
/list-dirs               # Show all allowed directories
/remove-dir ../shared-lib
```

## Sessions

Sessions auto-save to `./.ally-sessions/` and include:
- Conversation history
- Todo list
- Active plugins
- Project context

```bash
ally --resume            # Resume last session
/resume                  # Interactive session picker
```

## Configuration

Run `ally --init` for interactive setup, or edit `~/.ally/config.json`.

### Model Settings

| Option | Default | Description |
|--------|---------|-------------|
| `model` | (auto) | Primary model |
| `endpoint` | `http://localhost:11434` | Ollama endpoint |
| `context_size` | `16384` | Context window tokens |
| `temperature` | `0.3` | Generation temperature |
| `max_tokens` | `16384` | Max tokens per response |
| `reasoning_effort` | `low` | Reasoning level (low/medium/high) |
| `service_model` | (model) | Model for background services |
| `explore_model` | (model) | Model for explore agent |
| `plan_model` | (model) | Model for plan agent |

### Execution

| Option | Default | Description |
|--------|---------|-------------|
| `bash_timeout` | `30` | Command timeout (seconds) |
| `auto_confirm` | `false` | Skip permission prompts |
| `parallel_tools` | `true` | Enable parallel tool execution |
| `default_agent` | `ally` | Default agent at startup |

### UI

| Option | Default | Description |
|--------|---------|-------------|
| `theme` | `default` | UI theme |
| `compact_threshold` | `85` | Auto-compact at context % |
| `show_context_in_prompt` | `false` | Show context % in prompt |
| `show_thinking_in_chat` | `true` | Show model reasoning |
| `enable_idle_messages` | `true` | Auto idle status messages |

### Tool Behavior

| Option | Default | Description |
|--------|---------|-------------|
| `tool_call_retry_enabled` | `true` | Retry failed tool calls |
| `tool_call_max_retries` | `2` | Max retry attempts |
| `read_max_tokens` | `3000` | Max tokens per read |
| `diff_display_enabled` | `true` | Show file change previews |
| `diff_display_context_lines` | `3` | Context lines in diffs |

### CLI Overrides

```bash
ally --model llama3.2
ally --temperature 0.7
ally --endpoint http://remote:11434
ally --auto-confirm
ally --reasoning-effort high
```

### Management

```bash
ally --config-show              # Show all settings
ally --config-show model        # Show specific setting
ally --config-set model=llama3.2
ally --config-reset             # Reset to defaults
```

## Profiles

Profiles provide isolated environments for different contexts:

```bash
ally --profile-create work    # Create profile
ally --profile work           # Switch to profile
ally --profiles               # Show profile commands
```

Each profile has separate:
- Configuration (`~/.ally/profiles/<name>/config.json`)
- Plugins (`~/.ally/profiles/<name>/plugins/`)
- Agents (`~/.ally/profiles/<name>/agents/`)
- Prompts

## Plugin System

Plugins extend functionality through custom tools and agents.

```
~/.ally/profiles/<profile>/plugins/my-plugin/
├── plugin.json          # Manifest
├── tool.py              # Implementation
└── requirements.txt     # Dependencies (optional)
```

**Activation modes:**
- `always` — Auto-activated every session
- `tagged` — Activate with `+plugin-name` in message

See [docs/plugins.md](docs/plugins.md) for the full development guide.

## Architecture

Event-driven layered architecture:

```
CLI → Ink UI → ActivityStream (event bus) → Agent → LLM/Tools
```

**Core components:**
- **Agent** (`src/agent/`) — LLM orchestration, tool coordination, context management
- **Tools** (`src/tools/`) — File operations, shell commands, search utilities
- **Plugins** (`src/plugins/`) — Extensible tool system with activation management
- **UI** (`src/ui/`) — React/Ink terminal interface
- **Services** (`src/services/`) — Configuration, sessions, focus management

**Key patterns:**
- Dependency injection via ServiceRegistry
- Event bus for UI/agent communication
- Tool orchestration with permission gating
- Agent pooling for performance

## Development

```bash
npm test           # Run tests
npm run type-check # Type check
npm run dev        # Development mode
npm run build      # Build
```

**Project structure:**
```
src/
├── agent/      # Agent orchestration, commands
├── llm/        # LLM client implementation
├── tools/      # Built-in tools
├── plugins/    # Plugin system
├── ui/         # React/Ink terminal UI
├── services/   # Core services
└── cli.ts      # Entry point
```

**Stack:** TypeScript 5.3+, React 18, Ink 4, Vitest, Zod

## Requirements

- Node.js 18+
- Ollama running locally
- Terminal with Unicode support

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
