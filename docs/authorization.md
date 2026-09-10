# Run Authorization

Restrict which tools a run may call, without turning off permission prompts
for everything else.

## Flags

```bash
ally --allowed-tools "read,grep,mcp__github__*" --once "summarize open issues"
ally --disallowed-tools "bash,write" --once "review this branch"
```

Both take a comma-separated list of tool name globs. `*` is the only wildcard;
everything else in a pattern is literal.

- `--allowed-tools` pre-approves the named tools. They run without a
  permission prompt.
- `--disallowed-tools` forbids the named tools. They are refused if called,
  and their schemas are withheld from the model, so it never sees a tool it
  cannot use.

## Precedence

For each tool call, in order:

1. `--disallowed-tools` match: denied. This always wins, including over an
   allow entry for the same tool.
2. A denied shell pattern: denied.
3. An allowed shell command rule: allowed.
4. `--allowed-tools` match: allowed.
5. Otherwise: the ordinary permission flow decides, exactly as if no flags
   were given. Auto-confirm, auto-allow mode, session trust and the
   interactive prompt all still apply.

Step 5 has no prompt to fall back on in a headless run, so a tool that
requires confirmation and is not named by `--allowed-tools` is refused with
`Automatic run cannot request permission for <tool>`. Name every tool an
unattended run needs; a partial allow list reads as a working config and fails
at the first unnamed call.

Step 5 is what separates these flags from a scheduled task. A scheduled task
runs under a code-owned policy preset that denies anything it does not name,
because an unattended run has nobody to ask. Combining `--scheduled-task` with
either flag is rejected at startup, so that closed set stays closed.

## Tool names

Patterns and tool names are normalized before matching, so either spelling
works:

| Written | Matches |
|---|---|
| `Bash` | `bash` |
| `Read` | `read` |
| `Edit`, `MultiEdit` | `apply-patch` |
| `Task` | `agent` |
| `TodoWrite` | `todo-write` |
| `mcp__github__create_issue` | `mcp-github-create-issue` |
| `mcp__github__*` | every tool from the `github` MCP server |
| `mcp__plugin_gitea-mcp_gitea__gitea_clone` | `mcp-gitea-gitea-clone` |

A server a plugin provides is named `plugin_<plugin>_<server>` by Claude Code
and by its bare server key here, so only the last segment carries over. Each
part is then kebab-cased, matching how MCP tools are registered.

The same normalization applies to `required_tools_all` and
`required_tools_one_of` in agent requirements, so a list written either way
matches the tools an agent actually calls.
