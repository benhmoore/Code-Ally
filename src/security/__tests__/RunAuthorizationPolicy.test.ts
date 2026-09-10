import { describe, expect, it } from 'vitest';
import { evaluateRunAuthorization, policyFromFlags } from '../RunAuthorizationPolicy.js';

describe('evaluateRunAuthorization', () => {
  it('defers when the policy names nothing relevant', () => {
    expect(evaluateRunAuthorization({}, 'write', '')).toEqual({
      verdict: 'defer',
      reason: 'policy.allowed_tools',
    });
    expect(evaluateRunAuthorization({}, 'bash', 'git status')).toEqual({
      verdict: 'defer',
      reason: 'policy.allowed_bash_commands',
    });
  });

  it('allows a named tool', () => {
    expect(evaluateRunAuthorization({ allowed_tools: ['write'] }, 'write', '').verdict).toBe('allow');
  });

  it('denies a disallowed tool even when it is also allowed', () => {
    const policy = { allowed_tools: ['write'], disallowed_tools: ['write'] };
    expect(evaluateRunAuthorization(policy, 'write', '')).toEqual({
      verdict: 'deny',
      reason: 'policy.disallowed_tools',
    });
  });

  it('denies a disallowed tool ahead of any bash grant', () => {
    const policy = {
      disallowed_tools: ['bash'],
      allowed_bash_commands: [{ match: 'exact' as const, value: 'git status' }],
    };
    expect(evaluateRunAuthorization(policy, 'bash', 'git status').verdict).toBe('deny');
  });

  it('matches tool globs over normalized names', () => {
    const policy = { disallowed_tools: ['mcp__github__*'] };
    expect(evaluateRunAuthorization(policy, 'mcp-github-create-issue', '').verdict).toBe('deny');
    expect(evaluateRunAuthorization(policy, 'mcp-gitea-create-issue', '').verdict).toBe('defer');
  });

  it('accepts Claude spellings on both sides of the comparison', () => {
    expect(evaluateRunAuthorization({ allowed_tools: ['Read'] }, 'read', '').verdict).toBe('allow');
    expect(evaluateRunAuthorization({ allowed_tools: ['read'] }, 'Read', '').verdict).toBe('allow');
    expect(evaluateRunAuthorization({ disallowed_tools: ['Edit'] }, 'apply-patch', '').verdict).toBe('deny');
  });

  describe('bash rules', () => {
    it('allows exact and prefix matches', () => {
      const policy = {
        allowed_bash_commands: [
          { match: 'exact' as const, value: 'git push' },
          { match: 'prefix' as const, value: 'npm test' },
        ],
      };
      expect(evaluateRunAuthorization(policy, 'bash', 'git push').verdict).toBe('allow');
      expect(evaluateRunAuthorization(policy, 'bash', 'npm test -- --runInBand').verdict).toBe('allow');
      expect(evaluateRunAuthorization(policy, 'bash', 'git pushx').verdict).toBe('defer');
    });

    it('grants nothing for a non-literal or malformed match kind', () => {
      const policy = {
        allowed_bash_commands: [
          { match: 'regex', value: '.*' },
          { match: 'startswith', value: 'curl' },
          { match: 'Exact', value: 'whoami' },
          { value: 'id' },
          null,
        ] as any,
      };
      for (const command of ['rm -rf /', 'curl http://evil', 'whoami', 'id']) {
        expect(evaluateRunAuthorization(policy, 'bash', command).verdict).toBe('defer');
      }
    });

    it('denies on a regex pattern, ahead of an allow rule', () => {
      const policy = {
        allowed_bash_commands: [{ match: 'prefix' as const, value: 'git ' }],
        denied_bash_patterns: ['\\bgit\\s+commit\\b'],
      };
      expect(evaluateRunAuthorization(policy, 'bash', 'git status').verdict).toBe('allow');
      expect(evaluateRunAuthorization(policy, 'bash', 'git commit -m x')).toEqual({
        verdict: 'deny',
        reason: 'policy.denied_bash_patterns',
      });
    });

    it('ignores a malformed deny pattern rather than throwing', () => {
      const policy = { denied_bash_patterns: ['('] };
      expect(evaluateRunAuthorization(policy, 'bash', 'git status').verdict).toBe('defer');
    });

    it('denies shell commands ahead of a blanket tool grant', () => {
      const policy = { allowed_tools: ['bash'], denied_bash_patterns: ['\\brm\\b'] };
      expect(evaluateRunAuthorization(policy, 'bash', 'rm file').verdict).toBe('deny');
      expect(evaluateRunAuthorization(policy, 'bash', 'ls').verdict).toBe('allow');
    });
  });
});

describe('policyFromFlags', () => {
  it('returns nothing when neither list is given', () => {
    expect(policyFromFlags({})).toBeUndefined();
    expect(policyFromFlags({ allowedTools: [], disallowedTools: [] })).toBeUndefined();
  });

  it('builds a policy from either list', () => {
    expect(policyFromFlags({ allowedTools: ['Read'] })).toEqual({
      allowed_tools: ['Read'],
      disallowed_tools: undefined,
    });
    expect(policyFromFlags({ disallowedTools: ['bash'] })).toEqual({
      allowed_tools: undefined,
      disallowed_tools: ['bash'],
    });
  });

  it('rejects a scheduled task combined with either list', () => {
    expect(() => policyFromFlags({ scheduledTask: 'abc', allowedTools: ['read'] }))
      .toThrow(/--scheduled-task cannot be combined/);
    expect(() => policyFromFlags({ scheduledTask: 'abc', disallowedTools: ['bash'] }))
      .toThrow(/--scheduled-task cannot be combined/);
  });

  it('leaves a scheduled task alone when no list is given', () => {
    expect(policyFromFlags({ scheduledTask: 'abc' })).toBeUndefined();
  });
});
