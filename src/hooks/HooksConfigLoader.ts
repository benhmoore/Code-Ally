/**
 * HooksConfigLoader - the one place hook configuration is read.
 *
 * Three sources are concatenated per event, in the order profile config,
 * enabled plugins, then the --settings override. Nothing overrides anything:
 * a block from any source blocks. Every group carries the source it came from
 * so a denial can name the file that caused it.
 *
 * Malformed entries are dropped with a warning rather than failing the run.
 * A --settings file the caller named explicitly is the exception: an
 * unreadable or invalid file there throws, because silently ignoring it would
 * run the session without the policy the caller asked for.
 */

import { readFile } from 'fs/promises';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import type { ConfigManager } from '../services/ConfigManager.js';
import type { PluginManager } from '../marketplace/PluginManager.js';
import {
  isHookEvent,
  type CommandHook,
  type HookEvent,
  type ResolvedHookGroup,
  type ResolvedHooksConfig,
} from './types.js';

export interface LoadHooksConfigOptions {
  configManager?: Pick<ConfigManager, 'getValue'> | null;
  pluginManager?: Pick<PluginManager, 'getEnabledPlugins' | 'getPluginHooksConfig'> | null;
  settingsFile?: string;
}

export async function loadHooksConfig(
  options: LoadHooksConfigOptions,
): Promise<ResolvedHooksConfig> {
  const merged: ResolvedHooksConfig = {};

  const profile = options.configManager?.getValue('hooks');
  if (profile) mergeInto(merged, normalizeHooksConfig(profile, 'profile'));

  for (const plugin of options.pluginManager?.getEnabledPlugins() ?? []) {
    const config = await options.pluginManager?.getPluginHooksConfig(plugin.installPath);
    if (!config) continue;
    mergeInto(
      merged,
      normalizeHooksConfig(config, `plugin:${plugin.pluginName}`, plugin.installPath),
    );
  }

  if (options.settingsFile) {
    mergeInto(merged, normalizeHooksConfig(await readSettingsHooks(options.settingsFile), 'settings'));
  }

  return merged;
}

/** Read the `hooks` key of a --settings file. Throws if the file is unusable. */
async function readSettingsHooks(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    throw new Error(`Could not read settings file ${path}: ${formatError(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Settings file ${path} is not valid JSON: ${formatError(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Settings file ${path} must contain a JSON object`);
  }
  return (parsed as { hooks?: unknown }).hooks;
}

/**
 * Validate one source's hook config and tag every group with its origin.
 * Exported because the profile config validator and the tests need the same
 * definition of a well-formed entry.
 */
export function normalizeHooksConfig(
  raw: unknown,
  source: string,
  pluginRoot?: string,
): ResolvedHooksConfig {
  const result: ResolvedHooksConfig = {};
  if (raw === undefined || raw === null) return result;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn(`[HOOKS] Ignoring hooks from ${source}: expected an object keyed by hook event`);
    return result;
  }

  for (const [event, groups] of Object.entries(raw as Record<string, unknown>)) {
    if (!isHookEvent(event)) {
      logger.warn(`[HOOKS] Ignoring unknown hook event '${event}' from ${source}`);
      continue;
    }
    if (!Array.isArray(groups)) {
      logger.warn(`[HOOKS] Ignoring '${event}' from ${source}: expected an array of groups`);
      continue;
    }
    for (const group of groups) {
      const normalized = normalizeGroup(group, event, source, pluginRoot);
      if (normalized) (result[event] ??= []).push(normalized);
    }
  }

  return result;
}

function normalizeGroup(
  raw: unknown,
  event: HookEvent,
  source: string,
  pluginRoot?: string,
): ResolvedHookGroup | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn(`[HOOKS] Ignoring a '${event}' group from ${source}: expected an object`);
    return null;
  }
  const { matcher, hooks } = raw as { matcher?: unknown; hooks?: unknown };
  if (matcher !== undefined && typeof matcher !== 'string') {
    logger.warn(`[HOOKS] Ignoring a '${event}' group from ${source}: matcher must be a string`);
    return null;
  }
  if (!Array.isArray(hooks)) {
    logger.warn(`[HOOKS] Ignoring a '${event}' group from ${source}: hooks must be an array`);
    return null;
  }

  const commands: CommandHook[] = [];
  for (const hook of hooks) {
    const normalized = normalizeHook(hook, event, source);
    if (normalized) commands.push(normalized);
  }
  if (commands.length === 0) return null;

  return {
    ...(matcher === undefined ? {} : { matcher }),
    hooks: commands,
    source,
    ...(pluginRoot ? { pluginRoot } : {}),
  };
}

function normalizeHook(raw: unknown, event: HookEvent, source: string): CommandHook | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn(`[HOOKS] Ignoring a '${event}' hook from ${source}: expected an object`);
    return null;
  }
  const { type, command, timeout } = raw as {
    type?: unknown;
    command?: unknown;
    timeout?: unknown;
  };
  if (type !== 'command') {
    logger.warn(`[HOOKS] Ignoring a '${event}' hook from ${source}: only type 'command' is supported`);
    return null;
  }
  if (typeof command !== 'string' || !command.trim()) {
    logger.warn(`[HOOKS] Ignoring a '${event}' hook from ${source}: command must be a non-empty string`);
    return null;
  }
  if (timeout !== undefined && (typeof timeout !== 'number' || !(timeout > 0))) {
    logger.warn(`[HOOKS] Ignoring a '${event}' hook from ${source}: timeout must be a positive number of seconds`);
    return null;
  }
  return { type: 'command', command, ...(timeout === undefined ? {} : { timeout }) };
}

function mergeInto(target: ResolvedHooksConfig, addition: ResolvedHooksConfig): void {
  for (const [event, groups] of Object.entries(addition) as Array<[HookEvent, ResolvedHookGroup[]]>) {
    (target[event] ??= []).push(...groups);
  }
}
