/**
 * ThinkingClock - decides what "Thought for Ns" actually measures.
 *
 * Two different instants get reported by the stream, and conflating them is a
 * lie on slow backends: the agent emits a synthetic "Thinking..." marker when it
 * hands the request to the model client, and the model emits its first reasoning
 * token some time later. The gap between them is prefill - dead air where
 * nothing has been produced - and it can run to tens of seconds locally, which
 * turned a few seconds of reasoning into a reported 44s of "thought".
 *
 * So the clock starts at the first reasoning token, and falls back to the
 * request time only when no reasoning ever streamed (some backends return it in
 * one piece), where the request time is the sole instant available.
 *
 * Entries are keyed by parentId ('root' for the main agent) and bounded, since
 * interrupted sub-agents never emit the completion event that clears them.
 */

const MAX_TRACKED_KEYS = 1000;

export class ThinkingClock {
  private firstTokenAt = new Map<string, number>();
  private requestSentAt = new Map<string, number>();

  /** The agent's pre-request "Thinking..." marker. Fallback start only. */
  markRequestSent(key: string, timestamp: number): void {
    this.record(this.requestSentAt, key, timestamp);
  }

  /** A real reasoning token arrived. The first one per key starts the clock. */
  markReasoningToken(key: string, timestamp: number): void {
    this.record(this.firstTokenAt, key, timestamp);
  }

  /** Start instant to report for this key, or undefined if nothing was tracked. */
  resolveStart(key: string): number | undefined {
    return this.firstTokenAt.get(key) ?? this.requestSentAt.get(key);
  }

  clear(key: string): void {
    this.firstTokenAt.delete(key);
    this.requestSentAt.delete(key);
  }

  clearAll(): void {
    this.firstTokenAt.clear();
    this.requestSentAt.clear();
  }

  private record(map: Map<string, number>, key: string, timestamp: number): void {
    // First write wins: later tokens must not push the start forward.
    if (map.has(key)) return;
    map.set(key, timestamp);
    if (map.size > MAX_TRACKED_KEYS) {
      map.delete(map.keys().next().value!);
    }
  }
}
