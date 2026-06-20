/**
 * Tool result content has two distinct consumers: the model and the user.
 *
 * - The MODEL receives the serialized {@link ToolResult} (everything it needs to
 *   reason and make follow-up calls — including internal handles like shell ids).
 * - The USER sees a terminal-rendered view that should omit plumbing the model
 *   needs but a reader does not.
 *
 * These two channels diverge through exactly two gateways defined here, and only
 * here:
 *
 *   - {@link resolveDisplayContent} — the sole source of the user-facing string.
 *   - {@link stripDisplayOnlyFields} — strips display-only fields before the
 *     result is serialized for the model.
 *
 * A tool opts into a curated user view by setting `display_content`; if it does
 * not, the user simply sees the same `content` the model does. Every display
 * seam (live output chunk, tool-call history, persisted session payload, session
 * resume) resolves through {@link resolveDisplayContent}, and every model
 * serialization passes through {@link stripDisplayOnlyFields}, so the separation
 * is invariant rather than re-implemented per call site.
 */
import { ToolResult } from '../types/index.js';

/**
 * The single registry of {@link ToolResult} fields that exist purely for terminal
 * display and must never be serialized into the model-facing tool result. To add
 * a new display-only channel, add its key here — both gateways pick it up.
 */
export const DISPLAY_ONLY_RESULT_FIELDS = ['display_content'] as const;

/** Minimal shape the display gateway reads — keeps UI call sites free of the full ToolResult type. */
export interface DisplayableResult {
  content?: string;
  display_content?: string;
}

/**
 * Resolve the string shown to the USER for a tool result. Prefers a tool's
 * curated `display_content`, falling back to the model-facing `content`. This is
 * the only place that rule lives.
 */
export function resolveDisplayContent(result: DisplayableResult | null | undefined): string {
  if (!result) return '';
  return result.display_content ?? result.content ?? '';
}

/**
 * Return a shallow clone of a result with all display-only fields removed, ready
 * to serialize for the model. The only place display-only fields are stripped.
 */
export function stripDisplayOnlyFields<T extends Record<string, any>>(result: T): T {
  const clone: Record<string, any> = { ...result };
  for (const field of DISPLAY_ONLY_RESULT_FIELDS) {
    delete clone[field];
  }
  return clone as T;
}
