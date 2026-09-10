# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Hooks: external commands run at fixed points in a session. `SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` and `SessionEnd`,
  configured from the profile config, a plugin's `hooks/hooks.json`, or
  `--settings <file>`. A hook decides policy before any permission prompt.
  The payload and exit code contract matches Claude Code, so a hook script
  written for either host runs unmodified. See `docs/plugins.md`.
- Headless protocol: `--output-format text|json|stream-json` and
  `--input-format text|stream-json`. Stream mode writes one JSON event per
  line, accepts user turns and a `control_request` interrupt on stdin, and
  ends every turn with a typed `result`. `--session-id` names the run's
  session. See `docs/headless.md`.
- Run authorization: `--allowed-tools` and `--disallowed-tools` take tool name
  globs. Disallowed tools are refused and their schemas withheld from the
  model; unnamed tools still go through the ordinary permission flow. Claude
  tool spellings are accepted everywhere names are matched. See
  `docs/authorization.md`.
- Structured output: `--json-schema` registers a required `structured-output`
  tool for the run and reports the validated payload on the `result` event.

### Changed
- `ToolValidator` validates nested objects, array items, enums and
  `additionalProperties`, and names the failing JSON path.
- Scheduled task presets now run through the shared run authorization
  evaluator. Their deny-by-default behavior is unchanged.
- The test runner no longer collects agent worktree checkouts.

## [0.1.0] - 2025-11-25

### Added
- Initial release
- Terminal-based AI coding assistant with Ollama integration
- Built-in tools: file operations, search, shell commands, planning
- Plugin system for custom tools and agents in Python or Node.js
- Agent system with delegation and pooling
- Session persistence and resume
- Focus mode for directory restrictions
- Profile support for isolated environments
- Interactive setup wizard
