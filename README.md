# Code Ally

AI pair programming assistant with Ink-based terminal UI, ported from Python/Rich to TypeScript/React.

## Status

**Current Phase**: 4 of 10 (UI Foundation Complete)

- Service Layer: Complete (76/76 tests passing)
- LLM Integration: Complete (66/66 tests passing)
- Tool System: Foundation complete (43/48 tests passing)
- UI Components: Complete (Ink/React components)
- Build: Passing with TypeScript strict mode

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## Architecture

Code Ally uses a layered architecture with event-driven communication:

```
CLI Entry (cli.ts)
    |
    v
Ink UI (React Components)
    |
    v
Activity Stream (Event Bus)
    |
    v
Agent Orchestrator
    |
    +-- Tool Manager --> Tools (Bash, Read, Write, Edit, etc.)
    +-- LLM Client --> Ollama
    +-- Service Registry (DI Container)
```

### Key Components

**Service Layer** (`src/services/`)
- ServiceRegistry: Dependency injection container
- ConfigManager: Configuration management
- PathResolver: Focus-aware path resolution
- ActivityStream: Event-driven communication

**LLM Integration** (`src/llm/`)
- ModelClient: Abstract LLM interface
- OllamaClient: Ollama-specific implementation
- MessageHistory: Conversation state management
- FunctionCalling: Tool schema conversion

**Tool System** (`src/tools/`)
- BaseTool: Abstract base with event emission
- ToolManager: Registry and execution orchestration
- Concrete tools: BashTool, ReadTool (more coming)

**UI Components** (`src/ui/`)
- App: Root component with context providers
- ConversationView: Message list display
- ToolGroupMessage: Concurrent tool visualization
- InputPrompt: User input handling
- StatusLine: Context and model info

## Features

### Current Implementation

- Configuration management with JSON persistence
- Ollama integration with function calling support
- Event-driven tool execution
- Concurrent tool visualization (Gemini-CLI style)
- React-based terminal UI with Ink
- TypeScript strict mode throughout

### Planned Features

- Session persistence across conversations
- Custom agent creation and delegation
- Undo system for file operations
- Focus management (restrict to directory)
- Tab completion and command history
- Full tool suite (Write, Edit, Grep, Glob, Ls)

## Configuration

Configuration file: `~/.ally/config.json`

Key settings:
- `model`: Ollama model name (null for auto-detect)
- `endpoint`: Ollama API endpoint (default: http://localhost:11434)
- `context_size`: Context window in tokens (default: 16384)
- `temperature`: Generation temperature (default: 0.3)
- `bash_timeout`: Command timeout in seconds (default: 30)

## Development

### Project Structure

```
src/
├── services/       # Core infrastructure
├── llm/           # LLM client and message handling
├── tools/         # Tool system and implementations
├── ui/            # Ink/React components
├── types/         # TypeScript type definitions
└── cli.ts         # Entry point

docs/
├── implementation_description/  # Architecture docs
├── INK_ARCHITECTURE_DESIGN.md  # UI design
├── PHASE_4_COMPLETE.md         # Current status
└── TEST_RESULTS_FINAL.md       # Test coverage
```

### Testing

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- src/services/__tests__/
npm test -- src/llm/__tests__/
npm test -- src/tests/tools/

# Type checking
npm run type-check

# Build
npm run build
```

### Agent-Based Development

This project uses specialized agents for parallel implementation:
- Service layer agent
- LLM integration agent
- Tool system agent
- UI component agents

See `docs/IMPLEMENTATION_STATUS.md` for details.

## Requirements

- Node.js 18+
- Ollama running locally (for LLM features)
- Terminal with Unicode support

## Dependencies

**Runtime**:
- ink: React for terminals (4.4.1)
- react: Component framework (18.2.0)
- zod: Schema validation (3.22.4)

**Development**:
- typescript: Type safety (5.3.3)
- vitest: Testing framework (1.2.0)
- tsx: TypeScript execution (4.7.0)
- eslint: Linting (8.56.0)
- prettier: Code formatting (3.2.4)

## Documentation

- `docs/INK_ARCHITECTURE_DESIGN.md` - Complete UI architecture
- `docs/implementation_description/` - Detailed component docs
- `docs/PHASE_4_COMPLETE.md` - Current implementation status
- `docs/TEST_RESULTS_FINAL.md` - Test coverage report

## License

MIT

## Contributing

This is currently in active development. The codebase uses:
- TypeScript strict mode
- ES modules with .js extensions
- React/Ink for UI
- Vitest for testing
- Agent-based parallel development

Contributions welcome after Phase 6 (Agent Orchestration) is complete.
