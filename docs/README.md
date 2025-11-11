# Code Ally Documentation

## Getting Started

- [Main README](../README.md) - Installation, usage, quick start
- [Configuration Reference](reference/configuration.md) - All configuration options

## Architecture

- [Overview](architecture/overview.md) - System architecture, data flows, design patterns
- [Plugin System](architecture/plugin-system.md) - Plugin architecture, activation, RPC communication

## Guides

- [Plugin Development](guides/plugin-development.md) - Creating custom tools for Code Ally

## Reference

- [Configuration](reference/configuration.md) - Configuration file options and CLI flags

## Source Documentation

In-depth technical documentation for each module:

- **Agent System:** `src/agent/` - Agent orchestration, interrupts, trust management
- **LLM Integration:** `src/llm/` - Ollama client, message handling, function calling
- **Tool System:** `src/tools/` - Built-in tools, BaseTool interface, ToolManager
- **Plugin System:** `src/plugins/` - Plugin loading, activation, background processes
- **Services:** `src/services/` - Dependency injection, configuration, sessions
- **UI Components:** `src/ui/` - React/Ink terminal interface, contexts, hooks

## Examples

- **Plugin Examples:** `examples/plugins/` - Executable and RPC plugin templates

## Legacy Documentation

The `docs/implementation_description/` directory contains detailed implementation notes from the development process. These docs are historical and may be outdated but provide deep technical context on specific features.

## Contributing

When modifying Code Ally:

1. Update relevant source README (`src/*/README.md`) for module changes
2. Update architecture docs for system-wide changes
3. Update configuration reference for new config options
4. Add examples for new features
5. Keep documentation concise and accurate

## Documentation Style

Code Ally documentation follows these principles:

- **Concise:** No unnecessary words or hyperbole
- **Accurate:** Based on actual code, not aspirations
- **Practical:** Focused on what developers need to know
- **Professional:** Straightforward technical writing

## Finding What You Need

**I want to...**

- **Understand the system:** Start with [Architecture Overview](architecture/overview.md)
- **Create a plugin:** Read [Plugin Development Guide](guides/plugin-development.md)
- **Configure Code Ally:** Check [Configuration Reference](reference/configuration.md)
- **Understand plugins:** Review [Plugin System Architecture](architecture/plugin-system.md)
- **Work on core code:** See source READMEs (`src/*/README.md`)
- **Add a new tool:** Check `src/tools/README.md`
- **Modify the agent:** Check `src/agent/` and architecture docs
- **Change the UI:** Check `src/ui/README.md`
