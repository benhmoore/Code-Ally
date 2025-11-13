# Code Ally

Terminal-based AI coding assistant that runs in your CLI. Built with TypeScript, React, and Ink.

## Installation

```bash
npm install
npm run build
npm link  # Makes 'ally' command available globally
```

## Usage

```bash
# Start interactive session
ally

# Run with specific model
ally --model llama3.2

# Single message mode
ally --once "explain this error: ..."

# Resume previous session
ally --resume

# Initial setup
ally --init
```

## What It Does

Code Ally is an AI pair programming assistant that can:

- Read, write, and edit files with undo support
- Execute shell commands and analyze output
- Search codebases with grep and glob patterns
- Maintain conversation context across sessions
- Create specialized agents for exploration and planning
- Extend functionality through plugins

**Safety features:**
- Permission prompts for file modifications
- Focus mode to restrict operations to specific directories
- Undo system with file diff tracking
- Path validation and sandboxing

## Architecture

Event-driven layered architecture:

```
CLI → Ink UI → ActivityStream (event bus) → Agent → LLM/Tools
```

**Core components:**
- **Agent** (src/agent/): LLM orchestration, tool coordination, context management
- **Tools** (src/tools/): File operations, shell commands, search utilities
- **Plugins** (src/plugins/): Extensible tool system with activation management
- **UI** (src/ui/): React/Ink terminal interface
- **Services** (src/services/): Configuration, sessions, focus management

**Key patterns:**
- Dependency injection via ServiceRegistry
- Event bus for UI/agent communication
- Tool orchestration with permission gating
- Agent pooling for performance

Sessions are stored in `./.ally-sessions/`

Configuration: `~/.ally/config.json`

```json
{
  "model": "llama3.2",
  "endpoint": "http://localhost:11434",
  "context_size": 16384,
  "temperature": 0.3,
  "bash_timeout": 30
}
```

Run `ally --init` for interactive setup.

## Plugin System

Plugins extend functionality through custom tools. Two types:

**Executable plugins:** Spawn per call, communicate via stdin/stdout JSON
**Background plugins:** Long-running daemons with JSON-RPC over Unix sockets

**Plugin structure:**
```
~/.ally/plugins/my-plugin/
├── plugin.json          # Manifest
├── tool.py             # Tool implementation
└── requirements.txt    # Dependencies (optional)
```

**Activation modes:**
- `always`: Auto-activated every session
- `tagged`: Activate with `+plugin-name` in message

See plugins in `~/.ally/plugins/` for examples.

## Sessions and Agents

**Sessions:**
- Auto-saved in `~/.ally/sessions/`
- Include conversation history, todos, active plugins
- Resume with `ally --resume`

**Specialized agents:**
- Create custom agents via `/agent` command or agent wizard
- Agents stored in `~/.ally/agents/`
- Useful for focused tasks (exploration, planning, domain-specific work)

**Slash commands:**
```
/compact    - Summarize conversation to free context
/undo       - Revert file changes
/rewind     - Go back to earlier message
/config     - Modify configuration
/model      - Switch LLM model
/focus      - Restrict operations to directory
```

## Development

```bash
# Run tests
npm test

# Type check
npm run type-check

# Development mode
npm run dev

# Build
npm run build
```

**Project structure:**
```
src/
├── agent/      # Agent orchestration, tool coordination
├── llm/        # LLM client implementation
├── tools/      # Built-in tools (Bash, Read, Write, Edit, etc.)
├── plugins/    # Plugin system and management
├── ui/         # React/Ink terminal UI
├── services/   # Core services (config, sessions, etc.)
└── cli.ts      # Entry point
```

**Stack:**
- TypeScript 5.3+ (strict mode)
- React 18 + Ink 4 (terminal UI)
- Vitest (testing)
- Zod (validation)

## Requirements

- Node.js 18+
- Ollama running locally
- Terminal with Unicode support

## License

MIT
