/**
 * Run authorization policy - the single evaluator for "may this run call this
 * tool" decisions.
 *
 * One policy shape serves two callers with different defaults:
 *
 * - Scheduled task presets install it strictly: anything the policy does not
 *   name is denied, because an unattended run has nobody to ask.
 * - `--allowed-tools` / `--disallowed-tools` install it non-strictly: named
 *   tools are pre-approved, denied tools are refused, and everything else
 *   falls through to the ordinary trust machinery.
 *
 * The evaluator itself is pure and knows nothing about that difference. It
 * reports `allow`, `deny`, or `defer`, and the caller decides what `defer`
 * means for the run it is authorizing.
 */

import { matchesAnyToolGlob } from '../tools/toolNameAliases.js';

export type CommandRule = {
  /**
   * Only literal match kinds exist. There is deliberately no `regex` kind:
   * an allow-rule expressed as a regex is fail-open (`.*` grants everything),
   * and the matcher below treats any unrecognized kind as no match.
   */
  match: 'exact' | 'prefix';
  value: string;
};

export interface RunAuthorizationPolicy {
  /** Tool name globs pre-approved for this run. */
  allowed_tools?: string[];
  /** Tool name globs this run can never call. Checked first, always wins. */
  disallowed_tools?: string[];
  allowed_bash_commands?: CommandRule[];
  /** Regex denials are fail-closed (a broken/broad pattern only denies more). */
  denied_bash_patterns?: string[];
}

/** Why the evaluator reached its verdict. Stable, used as error reason codes. */
export type RunAuthorizationReason =
  | 'policy.disallowed_tools'
  | 'policy.denied_bash_patterns'
  | 'policy.allowed_bash_commands'
  | 'policy.allowed_tools';

export interface RunAuthorizationDecision {
  verdict: 'allow' | 'deny' | 'defer';
  reason: RunAuthorizationReason;
}

/**
 * Decide what a policy says about one tool call.
 *
 * Order matters and is deliberate: denials are evaluated before any grant, so
 * a policy can never be widened by adding an allow entry, and shell denials
 * outrank a blanket tool grant.
 *
 * @param policy - The installed policy.
 * @param toolName - Tool name in any accepted spelling.
 * @param command - Shell command for bash-style calls, empty otherwise.
 */
export function evaluateRunAuthorization(
  policy: RunAuthorizationPolicy,
  toolName: string,
  command: string
): RunAuthorizationDecision {
  if (matchesAnyToolGlob(toolName, policy.disallowed_tools ?? [])) {
    return { verdict: 'deny', reason: 'policy.disallowed_tools' };
  }

  if (command && matchesAnyPattern(command, policy.denied_bash_patterns ?? [])) {
    return { verdict: 'deny', reason: 'policy.denied_bash_patterns' };
  }

  if (command && matchesCommandRules(command, policy.allowed_bash_commands ?? [])) {
    return { verdict: 'allow', reason: 'policy.allowed_bash_commands' };
  }

  if (matchesAnyToolGlob(toolName, policy.allowed_tools ?? [])) {
    return { verdict: 'allow', reason: 'policy.allowed_tools' };
  }

  return {
    verdict: 'defer',
    reason: command ? 'policy.allowed_bash_commands' : 'policy.allowed_tools',
  };
}

/** The command-line surface that builds a non-strict policy. */
export interface RunAuthorizationFlags {
  scheduledTask?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

/**
 * Build the run policy from the command-line flags, or undefined when none
 * were given.
 *
 * A scheduled run derives its grants from a code-owned preset on every run, so
 * an edited store can never widen them. Accepting a caller-supplied list
 * alongside it would break that closed-set guarantee, so the combination is
 * rejected rather than merged.
 *
 * @throws Error when a scheduled task is combined with either list.
 */
export function policyFromFlags(flags: RunAuthorizationFlags): RunAuthorizationPolicy | undefined {
  const hasLists = Boolean(flags.allowedTools?.length || flags.disallowedTools?.length);
  if (flags.scheduledTask && hasLists) {
    throw new Error(
      '--scheduled-task cannot be combined with --allowed-tools or --disallowed-tools: a scheduled run is authorized by its policy preset alone'
    );
  }
  if (!hasLists) return undefined;
  return {
    allowed_tools: flags.allowedTools,
    disallowed_tools: flags.disallowedTools,
  };
}

/**
 * Allow-list matcher for shell commands. Exhaustive by design: only the two
 * literal match kinds grant anything, and every other value - an unknown kind,
 * a typo, a rule smuggled into a hand-edited store - returns false. There is
 * no regex branch, because a regex allow-rule fails open.
 */
export function matchesCommandRules(command: string, rules: readonly CommandRule[]): boolean {
  return rules.some((rule) => {
    switch (rule?.match) {
      case 'exact':
        return command === rule.value;
      case 'prefix':
        return command.startsWith(rule.value);
      default:
        return false;
    }
  });
}

/**
 * Deny-list matcher. Regex is safe in this direction: a broad or malformed
 * pattern can only deny more, never grant.
 */
export function matchesAnyPattern(command: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(command);
    } catch {
      return false;
    }
  });
}
