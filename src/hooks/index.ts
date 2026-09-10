/**
 * Hook runtime: one wire format, one loader, one runner.
 */

export { HookRunner, DEFAULT_HOOK_TIMEOUT_MS, type HookRunnerEnv } from './HookRunner.js';
export {
  loadHooksConfig,
  normalizeHooksConfig,
  type LoadHooksConfigOptions,
} from './HooksConfigLoader.js';
export {
  HOOK_EVENTS,
  isHookEvent,
  isHooksConfigShape,
  PROCEED,
  type CommandHook,
  type HookEvent,
  type HookEventPayloads,
  type HookGroup,
  type HookInput,
  type HookInputBase,
  type HookOutput,
  type HookVerdict,
  type HooksConfig,
  type ResolvedHookGroup,
  type ResolvedHooksConfig,
} from './types.js';
