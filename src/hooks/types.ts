/**
 * Hook wire format.
 *
 * The stdin payload, the stdout JSON, and the exit code contract are the same
 * ones Claude Code implements, so a hook script written for either host runs
 * unmodified under the other. Ally-specific fields are additive and optional.
 */

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/** A single hook command. `timeout` is in seconds, as in Claude Code. */
export interface CommandHook {
  type: 'command';
  command: string;
  timeout?: number;
}

/** One matcher and the commands it selects. */
export interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

/** The shape of a `hooks` key in profile config, a plugin file, or --settings. */
export type HooksConfig = Partial<Record<HookEvent, HookGroup[]>>;

/**
 * True when the value could be a hooks config. Per-event and per-command
 * validation happens in the loader; this is the outer shape check config
 * validation needs without pulling the loader into the config module.
 */
export function isHooksConfigShape(value: unknown): value is HooksConfig {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A group after loading, tagged with where it came from. */
export interface ResolvedHookGroup extends HookGroup {
  /** 'profile' | 'plugin:<name>' | 'settings'. Diagnostics only. */
  source: string;
  /** Plugin install path, exported to the hook as CLAUDE_PLUGIN_ROOT. */
  pluginRoot?: string;
}

export type ResolvedHooksConfig = Partial<Record<HookEvent, ResolvedHookGroup[]>>;

/** Fields each event contributes to the stdin payload, beyond the base. */
export interface HookEventPayloads {
  SessionStart: { source: 'startup' | 'resume' };
  UserPromptSubmit: { prompt: string };
  PreToolUse: { tool_name: string; tool_input: Record<string, unknown> };
  PostToolUse: {
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_response: unknown;
  };
  Stop: { stop_hook_active: boolean };
  SessionEnd: { reason: string };
}

/** Fields present on every payload. */
export interface HookInputBase {
  session_id: string;
  cwd: string;
  hook_event_name: HookEvent;
  transcript_path?: string;
}

export type HookInput<E extends HookEvent = HookEvent> = HookInputBase & HookEventPayloads[E];

/** Parsed from a hook's stdout when the hook exits 0 and writes JSON. */
export interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  systemMessage?: string;
  decision?: 'approve' | 'block';
  reason?: string;
  hookSpecificOutput?: {
    hookEventName?: HookEvent;
    additionalContext?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

export type HookVerdict =
  | {
      kind: 'proceed';
      additionalContext: string[];
      systemMessages: string[];
      updatedInput?: Record<string, unknown>;
    }
  | { kind: 'block'; reason: string; source: string };

/** The verdict returned when an event has nothing to run. */
export const PROCEED: HookVerdict = Object.freeze({
  kind: 'proceed',
  additionalContext: Object.freeze([]) as unknown as string[],
  systemMessages: Object.freeze([]) as unknown as string[],
});

/**
 * The event map inside a hooks document.
 *
 * A plugin hooks file written for Claude Code nests its events under a `hooks`
 * key; a settings or profile block is already the event map. Both shapes are
 * accepted, so one file serves either host, and every reader resolves them
 * here rather than repeating the check.
 */
export function hookEventMap(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const nested = record.hooks;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : record;
}
