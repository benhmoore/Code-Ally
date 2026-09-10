import { createReadStream } from 'node:fs';

const REQUIRED_EFFECT_FIELDS = new Map<string, readonly string[]>([
  ['tool_prepared', ['callId', 'tool', 'effect']],
  ['tool_running', ['callId', 'tool', 'effect']],
  ['tool_unknown', ['callId', 'tool', 'effect']],
  ['tool_succeeded', ['callId', 'tool', 'effect']],
  ['tool_failed', ['callId', 'tool', 'effect']],
  ['tool_reconciled', ['callId', 'resolution', 'evidence']],
]);

export interface RunJournalEvent {
  sequence: number;
  timestamp: number;
  runId: string;
  type: string;
  data?: Record<string, unknown>;
}

/** Decode incrementally: recovery memory is bounded by a record, not run age. */
export async function* decodeRunJournal(
  chunks: AsyncIterable<Uint8Array>,
  runId: string
): AsyncGenerator<RunJournalEvent> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let sequence = 0;
  for await (const chunk of chunks) {
    pending += decoder.decode(chunk, { stream: true });
    let start = 0;
    let end: number;
    while ((end = pending.indexOf('\n', start)) !== -1) {
      const event: unknown = JSON.parse(pending.slice(start, end));
      validateRunJournalEvent(event, runId, sequence + 1);
      sequence = event.sequence;
      yield event;
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  pending += decoder.decode();
  if (pending || sequence === 0) throw new Error('Missing complete journal record boundary');
}

export function readRunJournal(filePath: string, runId: string): AsyncGenerator<RunJournalEvent> {
  return decodeRunJournal(createReadStream(filePath), runId);
}

export function validateRunJournalEvent(
  value: unknown,
  runId: string,
  sequence: number
): asserts value is RunJournalEvent {
  const event = value as RunJournalEvent | null;
  if (!event || Array.isArray(event) || event.runId !== runId
    || event.sequence !== sequence || !Number.isSafeInteger(event.sequence)
    || !Number.isFinite(event.timestamp)
    || typeof event.type !== 'string' || !event.type
    || (event.data !== undefined && (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)))) {
    throw new Error(`Invalid journal event at sequence ${sequence}`);
  }
  // These fields determine whether an external effect is safe to repeat. A
  // syntactically valid record without them is not trustworthy recovery evidence.
  const required = REQUIRED_EFFECT_FIELDS.get(event.type);
  for (const key of required ?? []) {
    if (typeof event.data?.[key] !== 'string' || !event.data[key]) {
      throw new Error(`Invalid ${event.type} ${key} at sequence ${sequence}`);
    }
  }
  if (required && event.type !== 'tool_reconciled'
    && !['read_only', 'idempotent', 'non_idempotent', 'reconcilable'].includes(event.data!.effect as string)) {
    throw new Error(`Invalid tool effect at sequence ${sequence}`);
  }
}
