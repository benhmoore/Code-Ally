# Contributing to Code Ally

Thanks for your interest in contributing to Code Ally! This document provides guidelines for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/CodeAlly.git`
3. Install dependencies: `npm install`
4. Create a branch: `git checkout -b feature/your-feature`

## Development

```bash
npm run dev        # Development mode with watch
npm run build      # Build the project
npm test           # Run tests
npm run type-check # TypeScript type checking
```

## Code Style

- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Run type checking before submitting: `npm run type-check`

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
