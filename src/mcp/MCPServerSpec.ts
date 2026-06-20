/**
 * MCPServerSpec - Single source of truth for authoring MCP server configs.
 *
 * Every path that turns user/plugin input into an {@link MCPServerConfig}
 * (the `/mcp add` command, the setup wizard, JSON import, plugin loading)
 * funnels through the pure functions here so parsing, normalization, and
 * validation behave identically everywhere.
 *
 * Nothing in this module performs I/O — it transforms values and reports
 * structured errors/warnings. Persistence and connection live in
 * {@link MCPServerManager}.
 */

import type { MCPServerConfig } from './MCPConfig.js';

/** Successful parse: a normalized config plus any non-fatal advisories. */
export interface ParseSuccess {
  ok: true;
  config: MCPServerConfig;
  warnings: string[];
}

/** Failed parse: one or more human-readable reasons. */
export interface ParseFailure {
  ok: false;
  errors: string[];
  warnings: string[];
}

export type ParseResult = ParseSuccess | ParseFailure;

/** Result of importing a payload that may contain multiple servers. */
export interface ImportResult {
  /** Successfully parsed servers, keyed by name. */
  servers: Record<string, MCPServerConfig>;
  /** Per-server failures, keyed by name. */
  errors: Record<string, string[]>;
  /** Per-server advisories, keyed by name. */
  warnings: Record<string, string[]>;
}

/**
 * Commands that are runtimes/launchers rather than the server itself: invoking
 * them with no arguments drops into a REPL (or does nothing) and never speaks
 * MCP, which manifests as a connection timeout. A stdio config using one of
 * these with empty args is treated as broken.
 */
const PACKAGE_RUNNERS = new Set([
  'npx', 'npx.cmd',
  'bunx', 'bun',
  'pnpx', 'pnpm', 'pnpm.cmd',
  'yarn',
  'uvx', 'uv',
  'node', 'node.exe',
  'deno',
  'python', 'python3', 'python.exe',
]);

/** Transports the spec layer understands. */
const KNOWN_TRANSPORTS = new Set(['stdio', 'sse', 'http']);

/**
 * Normalize the many spellings of a transport/type field down to our canonical
 * three. Returns undefined for an unrecognized value so callers can report it.
 */
function normalizeTransport(value: unknown): 'stdio' | 'sse' | 'http' | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  switch (v) {
    case 'stdio':
      return 'stdio';
    case 'sse':
      return 'sse';
    case 'http':
    case 'https':
    case 'streamable-http':
    case 'streamablehttp':
    case 'streamable_http':
      return 'http';
    default:
      return undefined;
  }
}

/** True when every entry of a record is a string. */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(v => typeof v === 'string');
}

/**
 * Parse a single server in the *universal* MCP JSON shape — the object every
 * server README and Claude Desktop config uses:
 *
 *   { "command": "npx", "args": ["-y", "pkg"], "env": { "K": "v" } }
 *   { "url": "https://host/mcp", "type": "http", "headers": { ... } }
 *
 * Aliases are normalized (`type` ↔ `transport`, http spellings), transport is
 * inferred from `url` vs `command` when absent, and the result is run through
 * {@link validateConfig}. Returns a normalized {@link MCPServerConfig} or the
 * list of reasons it could not be accepted.
 */
export function parseServerObject(raw: unknown): ParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['Server definition must be a JSON object'], warnings };
  }

  const obj = raw as Record<string, unknown>;

  // Resolve transport: explicit `transport`, then `type`, then inference.
  let transport: 'stdio' | 'sse' | 'http' | undefined;
  const transportField = obj.transport ?? obj.type;
  if (transportField !== undefined) {
    transport = normalizeTransport(transportField);
    if (!transport) {
      errors.push(`Unknown transport '${String(transportField)}' (expected stdio, sse, or http)`);
    }
  }
  if (!transport) {
    if (typeof obj.url === 'string') {
      // Remote server. Default to modern Streamable HTTP unless the URL path
      // clearly names an SSE endpoint.
      transport = /\/sse\b/i.test(obj.url) ? 'sse' : 'http';
    } else if (typeof obj.command === 'string') {
      transport = 'stdio';
    }
  }
  if (!transport) {
    // Could not determine; default to stdio so validation produces the
    // actionable "needs a command" message rather than a vague one.
    transport = 'stdio';
  }

  const config: MCPServerConfig = { transport };

  if (transport === 'stdio') {
    if (obj.command !== undefined) {
      if (typeof obj.command !== 'string') {
        errors.push('`command` must be a string');
      } else {
        config.command = obj.command;
      }
    }
    if (obj.args !== undefined) {
      if (!Array.isArray(obj.args) || !obj.args.every(a => typeof a === 'string')) {
        errors.push('`args` must be an array of strings');
      } else {
        config.args = obj.args as string[];
      }
    }
    if (obj.env !== undefined) {
      if (!isStringRecord(obj.env)) {
        errors.push('`env` must be an object of string values');
      } else {
        config.env = obj.env;
      }
    }
  } else {
    // sse | http
    if (obj.url !== undefined) {
      if (typeof obj.url !== 'string') {
        errors.push('`url` must be a string');
      } else {
        config.url = obj.url;
      }
    }
    if (obj.headers !== undefined) {
      if (!isStringRecord(obj.headers)) {
        errors.push('`headers` must be an object of string values');
      } else {
        config.headers = obj.headers;
      }
    }
  }

  // Optional booleans — accept real booleans or the strings "true"/"false".
  for (const key of ['enabled', 'autoStart', 'requiresConfirmation'] as const) {
    const value = obj[key];
    if (value === undefined) continue;
    if (typeof value === 'boolean') {
      config[key] = value;
    } else if (value === 'true' || value === 'false') {
      config[key] = value === 'true';
    } else {
      errors.push(`\`${key}\` must be true or false`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // Semantic validation (required fields, runner-with-no-args, URL validity).
  const semantic = validateConfig(config);
  warnings.push(...semantic.warnings);
  if (semantic.errors.length > 0) {
    return { ok: false, errors: semantic.errors, warnings };
  }

  return { ok: true, config, warnings };
}

/**
 * Parse an import payload that may carry several servers. Accepts the standard
 * Claude Desktop wrapper (`{ "mcpServers": { ... } }`), our native wrapper
 * (`{ "servers": { ... } }`), or a single bare server object (in which case
 * `fallbackName` supplies the key).
 */
export function parseImportPayload(raw: unknown, fallbackName?: string): ImportResult {
  const result: ImportResult = { servers: {}, errors: {}, warnings: {} };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    result.errors['_'] = ['Payload must be a JSON object'];
    return result;
  }

  const obj = raw as Record<string, unknown>;
  const wrapper = (obj.mcpServers ?? obj.servers) as unknown;

  let entries: Record<string, unknown>;
  if (wrapper !== undefined) {
    if (typeof wrapper !== 'object' || wrapper === null || Array.isArray(wrapper)) {
      result.errors['_'] = ['`mcpServers`/`servers` must be an object'];
      return result;
    }
    entries = wrapper as Record<string, unknown>;
  } else if (typeof obj.command === 'string' || typeof obj.url === 'string') {
    // A single bare server object — needs a name from the caller.
    const name = fallbackName?.trim();
    if (!name) {
      result.errors['_'] = ['A name is required for this server'];
      return result;
    }
    entries = { [name]: obj };
  } else {
    result.errors['_'] = [
      'Could not find any servers. Expected `{ "mcpServers": { ... } }` or a server with a `command`/`url`.',
    ];
    return result;
  }

  for (const [name, def] of Object.entries(entries)) {
    const parsed = parseServerObject(def);
    if (parsed.ok) {
      result.servers[name] = parsed.config;
      if (parsed.warnings.length > 0) result.warnings[name] = parsed.warnings;
    } else {
      result.errors[name] = parsed.errors;
      if (parsed.warnings.length > 0) result.warnings[name] = parsed.warnings;
    }
  }

  return result;
}

/**
 * Parse the `/mcp add` `key=value` token syntax into a config. Unlike a naive
 * switch, this supports every field — including `args`, `env`, and `headers` —
 * and reports unknown keys as errors instead of silently dropping them.
 *
 *   command=npx args=-y,chrome-devtools-mcp@latest autoStart=true
 *   env=GITHUB_TOKEN=ghp_xxx
 *   header=Authorization=Bearer xyz
 *
 * `args` accepts a comma-separated list and may be repeated (values append).
 * `env`/`header` take `NAME=VALUE` and may be repeated.
 */
export function parseKeyValuePairs(tokens: string[]): ParseResult {
  const raw: Record<string, unknown> = {};
  const args: string[] = [];
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const unknown: string[] = [];
  const malformed: string[] = [];
  let sawArgs = false;
  let sawEnv = false;
  let sawHeaders = false;

  for (const token of tokens) {
    const eqIdx = token.indexOf('=');
    if (eqIdx === -1) {
      malformed.push(token);
      continue;
    }
    const key = token.slice(0, eqIdx).trim();
    const value = token.slice(eqIdx + 1);

    switch (key) {
      case 'transport':
      case 'type':
      case 'command':
      case 'url':
        raw[key] = value;
        break;
      case 'args':
        sawArgs = true;
        args.push(...value.split(',').map(a => a.trim()).filter(a => a.length > 0));
        break;
      case 'env':
      case 'header':
      case 'headers': {
        const sep = value.indexOf('=');
        if (sep === -1) {
          malformed.push(token);
          break;
        }
        const name = value.slice(0, sep).trim();
        const val = value.slice(sep + 1);
        if (key === 'env') {
          sawEnv = true;
          env[name] = val;
        } else {
          sawHeaders = true;
          headers[name] = val;
        }
        break;
      }
      case 'autoStart':
      case 'requiresConfirmation':
      case 'enabled':
        raw[key] = value;
        break;
      default:
        unknown.push(key);
    }
  }

  const warnings: string[] = [];
  const errors: string[] = [];
  if (unknown.length > 0) {
    errors.push(`Unknown option(s): ${unknown.join(', ')}`);
  }
  if (malformed.length > 0) {
    errors.push(`Expected key=value but got: ${malformed.join(', ')}`);
  }
  if (sawArgs) raw.args = args;
  if (sawEnv) raw.env = env;
  if (sawHeaders) raw.headers = headers;

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  return parseServerObject(raw);
}

/**
 * Split a command line into argv, honoring single and double quotes so that
 * `npx -y "@scope/pkg" --flag "a b"` tokenizes correctly. Unterminated quotes
 * are tolerated (the trailing token is taken as-is).
 */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);

  return tokens;
}

/**
 * Semantic validation of an already-shaped config. This is the gate that
 * prevents broken servers from being persisted, and is invoked both by the
 * parsers above and at the {@link MCPServerManager} boundary.
 */
export function validateConfig(config: MCPServerConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!KNOWN_TRANSPORTS.has(config.transport)) {
    errors.push(`Unknown transport '${config.transport}' (expected stdio, sse, or http)`);
    return { errors, warnings };
  }

  if (config.transport === 'stdio') {
    const command = config.command?.trim();
    if (!command) {
      errors.push('stdio servers require a `command` to run');
    } else {
      const base = basename(command);
      const args = config.args ?? [];
      if (PACKAGE_RUNNERS.has(base) && args.length === 0) {
        errors.push(
          `'${command}' is a launcher and needs arguments (e.g. the server package to run); ` +
          `with no args it never starts the server. Add args, e.g. \`args=-y,<package>\`.`
        );
      }
    }
    if (config.url) {
      warnings.push('`url` is ignored for stdio transport');
    }
  } else {
    // sse | http
    const url = config.url?.trim();
    if (!url) {
      errors.push(`${config.transport} servers require a \`url\``);
    } else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push(`\`url\` must be http(s), got '${parsed.protocol}'`);
        }
      } catch {
        errors.push(`\`url\` is not a valid URL: '${url}'`);
      }
    }
    if (config.command) {
      warnings.push('`command` is ignored for non-stdio transport');
    }
  }

  return { errors, warnings };
}

/** Last path segment of a command, handling both / and \ separators. */
function basename(command: string): string {
  const normalized = command.replace(/\\/g, '/');
  const segment = normalized.slice(normalized.lastIndexOf('/') + 1);
  return segment;
}
