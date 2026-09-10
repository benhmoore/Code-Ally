/**
 * HookRunner - runs configured hook commands for one event and reduces their
 * results to a single verdict.
 *
 * Contract, identical to Claude Code:
 * - The payload is one JSON object on the hook's stdin.
 * - Exit 0 proceeds. Stdout is parsed as JSON when it is JSON; for
 *   SessionStart and UserPromptSubmit plain stdout is taken as added context.
 * - Exit 2 blocks, with stderr as the reason.
 * - Any other exit code is a non-blocking hook failure: logged, then ignored.
 * - Stdout `hookSpecificOutput.permissionDecision: 'deny'`, `decision: 'block'`
 *   and `continue: false` also block.
 *
 * Hooks in one event run concurrently and any block wins, so a policy hook
 * cannot be outvoted by a slower advisory one.
 */

import { spawn } from 'child_process';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { normalizeToolName } from '../tools/toolNameAliases.js';
import {
  PROCEED,
  type CommandHook,
  type HookEvent,
  type HookEventPayloads,
  type HookOutput,
  type HookVerdict,
  type ResolvedHookGroup,
  type ResolvedHooksConfig,
} from './types.js';

/** Hook timeout when the hook does not declare one, in milliseconds. */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

export interface HookRunnerEnv {
  /** Read at call time: the session id changes during a run. */
  sessionId: () => string | null;
  cwd: string;
  projectDir: string;
}

/** Events whose plain-text stdout is taken as added context, as Claude Code does. */
const PLAIN_STDOUT_CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set([
  'SessionStart',
  'UserPromptSubmit',
]);

type HookOutcome =
  | { kind: 'proceed'; output?: HookOutput; plainStdout?: string }
  | { kind: 'block'; reason: string; source: string }
  | { kind: 'failed' };

export class HookRunner {
  constructor(
    private readonly config: ResolvedHooksConfig,
    private readonly env: HookRunnerEnv,
  ) {}

  /** Cheap guard so call sites can skip building a payload they will not use. */
  hasHooks(event: HookEvent): boolean {
    return (this.config[event]?.length ?? 0) > 0;
  }

  /**
   * Run every hook configured for `event` whose matcher selects `matchKey`.
   *
   * @param matchKey Normalized against the tool alias table before matching.
   *   Omitted for events that carry no tool, where every group matches.
   */
  async run<E extends HookEvent>(
    event: E,
    payload: HookEventPayloads[E],
    matchKey?: string,
  ): Promise<HookVerdict> {
    const selected: Array<{ group: ResolvedHookGroup; hook: CommandHook }> = [];
    for (const group of this.config[event] ?? []) {
      if (!this.matches(group, matchKey)) continue;
      for (const hook of group.hooks) selected.push({ group, hook });
    }
    if (selected.length === 0) return PROCEED;

    const input = JSON.stringify({
      session_id: this.env.sessionId() ?? '',
      cwd: this.env.cwd,
      hook_event_name: event,
      ...payload,
    });

    const outcomes = await Promise.all(
      selected.map(({ group, hook }) => this.execute(event, group, hook, input)),
    );

    const additionalContext: string[] = [];
    const systemMessages: string[] = [];
    let updatedInput: Record<string, unknown> | undefined;

    for (const outcome of outcomes) {
      if (outcome.kind === 'block') {
        return { kind: 'block', reason: outcome.reason, source: outcome.source };
      }
      if (outcome.kind === 'failed') continue;
      const specific = outcome.output?.hookSpecificOutput;
      if (specific?.additionalContext) additionalContext.push(specific.additionalContext);
      else if (outcome.plainStdout) additionalContext.push(outcome.plainStdout);
      if (outcome.output?.systemMessage) systemMessages.push(outcome.output.systemMessage);
      if (specific?.updatedInput) updatedInput = { ...updatedInput, ...specific.updatedInput };
    }

    return updatedInput
      ? { kind: 'proceed', additionalContext, systemMessages, updatedInput }
      : { kind: 'proceed', additionalContext, systemMessages };
  }

  /**
   * A missing matcher, or `*`, selects every call. Otherwise the matcher is a
   * case-insensitive regex over the normalized tool name; a matcher that is
   * itself a tool name in either spelling also matches by alias.
   */
  private matches(group: ResolvedHookGroup, matchKey?: string): boolean {
    const matcher = group.matcher?.trim();
    if (!matcher || matcher === '*') return true;
    if (matchKey === undefined) return true;

    const name = normalizeToolName(matchKey);
    if (normalizeToolName(matcher) === name) return true;
    try {
      return new RegExp(matcher, 'i').test(name);
    } catch (error) {
      logger.warn(`[HOOKS] Invalid matcher '${matcher}' from ${group.source}: ${formatError(error)}`);
      return false;
    }
  }

  private async execute(
    event: HookEvent,
    group: ResolvedHookGroup,
    hook: CommandHook,
    input: string,
  ): Promise<HookOutcome> {
    const timeoutMs =
      typeof hook.timeout === 'number' && hook.timeout > 0
        ? hook.timeout * 1000
        : DEFAULT_HOOK_TIMEOUT_MS;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_PROJECT_DIR: this.env.projectDir,
      ALLY_PROJECT_DIR: this.env.projectDir,
    };
    if (group.pluginRoot) env.CLAUDE_PLUGIN_ROOT = group.pluginRoot;

    const label = `${event} hook from ${group.source}`;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn('/bin/sh', ['-c', hook.command], {
        cwd: this.env.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        stderr += formatError(error);
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });

      child.stdin.on('error', () => {
        // A hook that exits without reading stdin closes the pipe first. That
        // is a normal way to write a hook, not a failure of this run.
      });
      child.stdin.end(input);
    });

    if (timedOut) {
      logger.warn(`[HOOKS] ${label} timed out after ${timeoutMs}ms and was killed: ${hook.command}`);
      return { kind: 'failed' };
    }

    if (exitCode === 2) {
      const reason = stderr.trim() || `${label} blocked the call without a reason`;
      logger.info(`[HOOKS] ${label} blocked the call: ${reason}`);
      return { kind: 'block', reason, source: group.source };
    }

    if (exitCode !== 0) {
      logger.warn(
        `[HOOKS] ${label} exited ${exitCode ?? 'without a code'}: ${stderr.trim() || hook.command}`,
      );
      return { kind: 'failed' };
    }

    return this.readStdout(event, label, stdout, group.source);
  }

  private readStdout(
    event: HookEvent,
    label: string,
    stdout: string,
    source: string,
  ): HookOutcome {
    const trimmed = stdout.trim();
    if (!trimmed) return { kind: 'proceed' };

    let output: HookOutput | undefined;
    if (trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') output = parsed as HookOutput;
      } catch (error) {
        logger.warn(`[HOOKS] ${label} wrote unparseable JSON to stdout: ${formatError(error)}`);
      }
    }

    if (!output) {
      return PLAIN_STDOUT_CONTEXT_EVENTS.has(event)
        ? { kind: 'proceed', plainStdout: trimmed }
        : { kind: 'proceed' };
    }

    const specific = output.hookSpecificOutput;
    if (specific?.permissionDecision === 'deny') {
      return {
        kind: 'block',
        reason: specific.permissionDecisionReason?.trim() || `${label} denied the call`,
        source,
      };
    }
    if (output.decision === 'block') {
      return { kind: 'block', reason: output.reason?.trim() || `${label} blocked the call`, source };
    }
    if (output.continue === false) {
      return { kind: 'block', reason: output.stopReason?.trim() || `${label} stopped the run`, source };
    }

    return { kind: 'proceed', output };
  }
}
