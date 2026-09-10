/**
 * Tool name normalization shared by hook matchers, allow and deny lists, and
 * requirement lists.
 *
 * Ally names tools in kebab-case (`bash`, `apply-patch`) and MCP tools as
 * `mcp-<server>-<tool>`. Configuration written for Claude Code uses `Bash`,
 * `Edit`, and `mcp__<server>__<tool>`. Both spellings resolve to the Ally
 * name here so one config file works under either host.
 */

const CLAUDE_BUILTIN_ALIASES: Readonly<Record<string, string>> = {
  bash: 'bash',
  read: 'read',
  edit: 'apply-patch',
  multiedit: 'apply-patch',
  write: 'write',
  glob: 'glob',
  grep: 'grep',
  ls: 'ls',
  agent: 'agent',
  task: 'agent',
  todowrite: 'todo-write',
  webfetch: 'web-fetch',
  websearch: 'web-search',
  skill: 'skill',
};

const MCP_CLAUDE_PATTERN = /^mcp__(.+?)__(.+)$/;

/** Resolve any accepted spelling of a tool name to its Ally name. */
export function normalizeToolName(name: string): string {
  const trimmed = name.trim();
  const mcp = MCP_CLAUDE_PATTERN.exec(trimmed);
  if (mcp) return `mcp-${mcp[1]}-${mcp[2]}`;
  const lower = trimmed.toLowerCase();
  return CLAUDE_BUILTIN_ALIASES[lower] ?? lower;
}

/**
 * Compile a tool name glob into a matcher over normalized names. Only `*` is
 * special; it matches any run of characters. Everything else is literal, so a
 * pattern can only widen through `*` and never through regex syntax.
 */
export function compileToolGlob(pattern: string): (toolName: string) => boolean {
  const normalized = normalizeToolName(pattern);
  if (!normalized.includes('*')) return (toolName) => normalizeToolName(toolName) === normalized;
  const source = normalized.split('*').map(escapeRegExp).join('.*');
  const regex = new RegExp(`^${source}$`);
  return (toolName) => regex.test(normalizeToolName(toolName));
}

/** True when any pattern in the list matches the tool. */
export function matchesAnyToolGlob(toolName: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => compileToolGlob(pattern)(toolName));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
