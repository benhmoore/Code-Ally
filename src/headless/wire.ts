/**
 * Wire events for the headless JSON protocols.
 *
 * One JSON object per line on stdout. The mapping table below is the whole
 * schema: an activity event with no entry never reaches the wire.
 */

import { ActivityEventType, type ActivityEvent } from '../types/index.js';
import type { RunOutcome } from '../services/RunSupervisor.js';

export interface WireSystemInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  tools: string[];
  cwd: string;
}

export interface WireAssistant {
  type: 'assistant';
  session_id: string;
  message: { role: 'assistant'; content: Array<{ type: 'text'; text: string }> };
}

export interface WireToolUse {
  type: 'tool_use';
  session_id: string;
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface WireToolResult {
  type: 'tool_result';
  session_id: string;
  tool_use_id: string;
  is_error: boolean;
  content: string;
}

export type WireResultSubtype = 'success' | 'error_during_execution' | 'error';

export interface WireResult {
  type: 'result';
  subtype: WireResultSubtype;
  session_id: string;
  result: string;
  structured_output?: unknown;
  outcome: RunOutcome;
  duration_ms: number;
  num_turns: number;
  is_error: boolean;
}

export interface WireControlResponse {
  type: 'control_response';
  session_id: string;
  response: { subtype: 'success' | 'error'; request_id?: string; error?: string };
}

export type WireEvent =
  | WireSystemInit
  | WireAssistant
  | WireToolUse
  | WireToolResult
  | WireResult
  | WireControlResponse;

type WireMapper = (event: ActivityEvent, sessionId: string) => WireEvent | null;

/**
 * The single ActivityEventType to wire-event table.
 *
 * Group events carry `groupExecution` and describe a batch rather than a tool
 * call, so they are dropped: the wire reports the individual calls inside.
 */
export const WIRE_EVENT_MAP: Partial<Record<ActivityEventType, WireMapper>> = {
  [ActivityEventType.ASSISTANT_MESSAGE_COMPLETE]: (event, sessionId) => {
    const content = String(event.data.content ?? '');
    if (!content) return null;
    return {
      type: 'assistant',
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: content }] },
    };
  },

  [ActivityEventType.TOOL_CALL_START]: (event, sessionId) => {
    if (event.data.groupExecution) return null;
    const name = event.data.toolName;
    if (typeof name !== 'string') return null;
    return {
      type: 'tool_use',
      session_id: sessionId,
      id: event.id,
      name,
      input: (event.data.arguments as Record<string, unknown>) ?? {},
    };
  },

  [ActivityEventType.TOOL_CALL_END]: (event, sessionId) => {
    if (event.data.groupExecution) return null;
    const success = event.data.success === true;
    return {
      type: 'tool_result',
      session_id: sessionId,
      tool_use_id: event.id,
      is_error: !success,
      content: String(event.data.error ?? event.data.output ?? ''),
    };
  },
};

/** Map one activity event to its wire event, or null when it is not on the wire. */
export function mapActivityEvent(event: ActivityEvent, sessionId: string): WireEvent | null {
  return WIRE_EVENT_MAP[event.type]?.(event, sessionId) ?? null;
}

/** Result subtype for a finished turn. */
export function resultSubtype(outcome: RunOutcome, interrupted: boolean): WireResultSubtype {
  if (interrupted) return 'error_during_execution';
  return outcome.kind === 'completed' ? 'success' : 'error';
}
