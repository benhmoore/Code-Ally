/**
 * Tests for MCPServerSpec — the single source of truth for authoring configs.
 */

import { describe, it, expect } from 'vitest';
import {
  parseServerObject,
  parseImportPayload,
  parseKeyValuePairs,
  tokenizeCommand,
  validateConfig,
} from '@mcp/MCPServerSpec.js';

describe('parseServerObject', () => {
  it('parses a standard stdio server (command/args/env)', () => {
    const result = parseServerObject({
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest'],
      env: { TOKEN: 'x' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toBe('stdio');
    expect(result.config.command).toBe('npx');
    expect(result.config.args).toEqual(['-y', 'chrome-devtools-mcp@latest']);
    expect(result.config.env).toEqual({ TOKEN: 'x' });
  });

  it('infers http transport from a url', () => {
    const result = parseServerObject({ url: 'https://example.com/mcp' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toBe('http');
    expect(result.config.url).toBe('https://example.com/mcp');
  });

  it('infers sse transport from a /sse url', () => {
    const result = parseServerObject({ url: 'https://example.com/sse' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toBe('sse');
  });

  it('normalizes type aliases (streamable-http -> http)', () => {
    const result = parseServerObject({ type: 'streamable-http', url: 'https://x.test/mcp' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toBe('http');
  });

  it('honors an explicit type of sse even when url lacks /sse', () => {
    const result = parseServerObject({ type: 'sse', url: 'https://x.test/stream' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.transport).toBe('sse');
  });

  it('accepts string booleans from JSON-ish input', () => {
    const result = parseServerObject({ command: 'node', args: ['s.js'], autoStart: 'true', enabled: 'false' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.autoStart).toBe(true);
    expect(result.config.enabled).toBe(false);
  });

  it('rejects a launcher command with no args (the bare-npx bug)', () => {
    const result = parseServerObject({ command: 'npx' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/launcher and needs arguments/i);
  });

  it('allows a direct binary with no args', () => {
    const result = parseServerObject({ command: '/usr/local/bin/my-mcp-server' });
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown transport', () => {
    const result = parseServerObject({ type: 'carrier-pigeon', command: 'x' });
    expect(result.ok).toBe(false);
  });

  it('rejects malformed field types', () => {
    expect(parseServerObject({ command: 'node', args: 'not-an-array' }).ok).toBe(false);
    expect(parseServerObject({ command: 'node', args: ['s'], env: { K: 1 } }).ok).toBe(false);
  });

  it('rejects an invalid url for http transport', () => {
    const result = parseServerObject({ type: 'http', url: 'not a url' });
    expect(result.ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(parseServerObject('nope').ok).toBe(false);
    expect(parseServerObject(null).ok).toBe(false);
    expect(parseServerObject(['a']).ok).toBe(false);
  });
});

describe('parseKeyValuePairs', () => {
  it('parses args (comma list), env, and booleans — the case that used to drop args', () => {
    const result = parseKeyValuePairs([
      'command=npx',
      'args=-y,chrome-devtools-mcp@latest',
      'autoStart=true',
      'requiresConfirmation=false',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.command).toBe('npx');
    expect(result.config.args).toEqual(['-y', 'chrome-devtools-mcp@latest']);
    expect(result.config.autoStart).toBe(true);
    expect(result.config.requiresConfirmation).toBe(false);
  });

  it('parses env=NAME=VALUE and supports repetition', () => {
    const result = parseKeyValuePairs(['command=node', 'args=s.js', 'env=A=1', 'env=B=2']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.env).toEqual({ A: '1', B: '2' });
  });

  it('appends across repeated args tokens', () => {
    const result = parseKeyValuePairs(['command=node', 'args=a,b', 'args=c']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.args).toEqual(['a', 'b', 'c']);
  });

  it('reports unknown keys instead of silently dropping them', () => {
    const result = parseKeyValuePairs(['command=node', 'args=s.js', 'frobnicate=yes']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/unknown option/i);
    expect(result.errors.join(' ')).toMatch(/frobnicate/);
  });

  it('reports tokens missing an = sign', () => {
    const result = parseKeyValuePairs(['command=node', 'args=s.js', 'bareword']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/key=value/i);
  });
});

describe('tokenizeCommand', () => {
  it('splits on whitespace', () => {
    expect(tokenizeCommand('npx -y @scope/pkg')).toEqual(['npx', '-y', '@scope/pkg']);
  });

  it('preserves quoted segments with spaces', () => {
    expect(tokenizeCommand('npx -y "@scope/pkg" --flag "a b"')).toEqual([
      'npx', '-y', '@scope/pkg', '--flag', 'a b',
    ]);
  });

  it('handles single quotes', () => {
    expect(tokenizeCommand("node 'my server.js'")).toEqual(['node', 'my server.js']);
  });

  it('collapses extra whitespace', () => {
    expect(tokenizeCommand('  npx    -y   pkg ')).toEqual(['npx', '-y', 'pkg']);
  });
});

describe('parseImportPayload', () => {
  it('imports the standard mcpServers wrapper', () => {
    const result = parseImportPayload({
      mcpServers: {
        chrome: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
        remote: { url: 'https://x.test/mcp' },
      },
    });
    expect(Object.keys(result.servers).sort()).toEqual(['chrome', 'remote']);
    expect(result.servers.chrome!.transport).toBe('stdio');
    expect(result.servers.remote!.transport).toBe('http');
    expect(Object.keys(result.errors)).toHaveLength(0);
  });

  it('imports the native servers wrapper', () => {
    const result = parseImportPayload({
      servers: { x: { command: 'node', args: ['s.js'] } },
    });
    expect(Object.keys(result.servers)).toEqual(['x']);
  });

  it('imports a bare single server using the fallback name', () => {
    const result = parseImportPayload({ command: 'node', args: ['s.js'] }, 'myserver');
    expect(Object.keys(result.servers)).toEqual(['myserver']);
  });

  it('requires a name for a bare server when none is given', () => {
    const result = parseImportPayload({ command: 'node', args: ['s.js'] });
    expect(Object.keys(result.servers)).toHaveLength(0);
    expect(result.errors._).toBeDefined();
  });

  it('collects per-server errors while keeping valid servers', () => {
    const result = parseImportPayload({
      mcpServers: {
        good: { command: 'npx', args: ['-y', 'pkg'] },
        bad: { command: 'npx' },
      },
    });
    expect(Object.keys(result.servers)).toEqual(['good']);
    expect(result.errors.bad).toBeDefined();
  });
});

describe('validateConfig', () => {
  it('passes a sound stdio config', () => {
    expect(validateConfig({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] }).errors).toHaveLength(0);
  });

  it('flags stdio without a command', () => {
    expect(validateConfig({ transport: 'stdio' }).errors.length).toBeGreaterThan(0);
  });

  it('flags http without a url', () => {
    expect(validateConfig({ transport: 'http' }).errors.length).toBeGreaterThan(0);
  });

  it('warns when url is set on a stdio config', () => {
    const { warnings } = validateConfig({ transport: 'stdio', command: 'srv', url: 'https://x.test' });
    expect(warnings.length).toBeGreaterThan(0);
  });
});
