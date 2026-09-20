# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Diffs are laid out side by side, old file on the left and new on the right,
  when the terminal is at least 120 columns wide. `diff_display_layout`
  forces `unified` or `side-by-side`.
- Tool calls in the live region open and close: click a call's row, or press
  ctrl+o to open or close all of them. Completed calls stay in the live
  region until the turn ends or a later message closes the sequence, and are
  written to the transcript in whichever state they were left.
- Mouse clicks. Option rows in permission prompts, selectors and the agent
  fleet answer to a click exactly as they do to Enter. `mouse_support`
  chooses when the terminal reports clicks: `dialogs` (default) only while
  such a surface is open, because tracking also takes the scroll wheel away
  from the terminal; `always`; or `off`.
- File names in tool rows, diff headers and markdown links are clickable in
  terminals that render OSC 8 hyperlinks. `enable_terminal_hyperlinks` turns
  this off; `FORCE_HYPERLINK=1` enables it where the terminal cannot be
  detected, such as through tmux or ssh.
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
- Requires Node.js 22 or newer.
- The terminal UI renders through Ink 7 on React 19.
- An error raised while handling another error now carries the original as
  its `cause`.
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
