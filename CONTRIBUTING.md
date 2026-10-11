# Contributing to Code Ally

Thanks for your interest in contributing to Code Ally! This document provides guidelines for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/CodeAlly.git`
3. Install dependencies: `npm install`
4. Create a branch: `git checkout -b feature/your-feature`

Node.js 22 or newer is required.

## Development

```bash
npm run dev        # Development mode with watch
npm run build      # Build the project
npm test           # Run tests
npm run type-check # TypeScript type checking
npm run lint       # ESLint, including React hook safety
npm run check      # Full local validation suite
```

## Code Style

- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Run `npm run check` before submitting

## Pull Requests

1. Keep PRs focused on a single change
2. Update tests if applicable
3. Ensure all tests pass
4. Write a clear PR description explaining the change

## Reporting Issues

When reporting bugs, please include:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version
- Operating system

## Plugin Development

See [docs/plugins.md](docs/plugins.md) for creating custom tools and agents.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

## Adding model providers and configuration settings

Provider names, labels, default endpoints, and transport mappings live in
`src/config/providers.ts`. A provider using an existing protocol needs one entry
there. Setup, CLI validation, config completion, and the model client factory use
that registry. A new protocol also needs a `ModelClient` implementation and a
transport mapping in `src/llm/createModelClient.ts`, plus discovery/capability
support in `src/llm/ProviderAdapter.ts`. Keep protocol-specific calls in that
adapter rather than adding them to commands, wizards, or tools.

`ConfigurableModelClient` keeps references stable across live connection changes,
including background services and compaction. Existing requests finish on their
original transport. Preserve the conversation identity guards when changing
provider, endpoint, or model.

Declare settings in `Config`, `DEFAULT_CONFIG`, and `CONFIG_TYPES`. Put finite
choices, descriptions, suggested values, categories, and secret classification
in `src/config/metadata.ts`; validation and completion share these definitions.
Route runtime effects through `RuntimeConfigSync` and agent configuration updates.
The provider configuration integration tests cover discovery, completion,
persistence, secret redaction, and live transport changes.
