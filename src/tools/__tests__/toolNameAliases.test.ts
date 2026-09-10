import { describe, expect, it } from 'vitest';
import { compileToolGlob, matchesAnyToolGlob, normalizeToolName } from '../toolNameAliases.js';

describe('normalizeToolName', () => {
  it('passes Ally names through unchanged', () => {
    expect(normalizeToolName('apply-patch')).toBe('apply-patch');
    expect(normalizeToolName('mcp-infra-infra_apps')).toBe('mcp-infra-infra_apps');
  });

  it('maps Claude built-in names onto their Ally counterparts', () => {
    expect(normalizeToolName('Bash')).toBe('bash');
    expect(normalizeToolName('Edit')).toBe('apply-patch');
    expect(normalizeToolName('Task')).toBe('agent');
    expect(normalizeToolName('TodoWrite')).toBe('todo-write');
  });

  it('rewrites Claude MCP names the way MCPTool names them', () => {
    expect(normalizeToolName('mcp__infra__infra_apps')).toBe('mcp-infra-infra-apps');
    expect(normalizeToolName('mcp__plugin_infra-mcp_infra__infra_apps')).toBe('mcp-infra-infra-apps');
    expect(normalizeToolName('mcp__plugin_gitea-mcp_gitea__gitea_clone')).toBe('mcp-gitea-gitea-clone');
  });

  it('lower-cases unknown names rather than inventing aliases', () => {
    expect(normalizeToolName('SomethingElse')).toBe('somethingelse');
  });
});

describe('compileToolGlob', () => {
  it('matches exact names in either spelling', () => {
    const isBash = compileToolGlob('Bash');
    expect(isBash('bash')).toBe(true);
    expect(isBash('read')).toBe(false);
  });

  it('expands * and nothing else', () => {
    const infra = compileToolGlob('mcp__plugin_infra-mcp_infra__*');
    expect(infra('mcp-infra-infra-apps')).toBe(true);
    expect(infra('mcp-gitea-gitea-clone')).toBe(false);
    expect(compileToolGlob('a.b')('axb')).toBe(false);
  });

  it('matchesAnyToolGlob checks a list', () => {
    expect(matchesAnyToolGlob('mcp-rt-rt-get-ticket', ['Bash', 'mcp__plugin_rt-mcp_rt__*'])).toBe(true);
    expect(matchesAnyToolGlob('write', ['Bash', 'Read'])).toBe(false);
  });
});
