/**
 * Which completed tool calls stay in the live region.
 *
 * Committed transcript lines are frozen in the terminal's scrollback, so a
 * tool call can only be expanded or collapsed while it is still drawn by the
 * live region. Completed calls that started after the last committed message
 * stay live while the assistant is working; they commit when the turn ends or
 * when a later message closes the sequence, which keeps the transcript in
 * chronological order. The window is bounded so the live region stays small.
 */

/** Completed tool calls kept interactive during a turn. */
export const MAX_LIVE_COMPLETED_TOOLS = 6;

export interface CompletedPartition<T> {
  /** Written to the transcript in this render. */
  committed: T[];
  /** Kept in the live region, oldest first. */
  live: T[];
}

export function partitionCompletedToolCalls<T extends { startTime: number }>(
  completed: readonly T[],
  lastCommittedTimestamp: number,
  turnActive: boolean,
  limit: number = MAX_LIVE_COMPLETED_TOOLS
): CompletedPartition<T> {
  if (!turnActive) {
    return { committed: [...completed], live: [] };
  }
  const live = new Set(completed.filter((call) => call.startTime > lastCommittedTimestamp).slice(-limit));
  return {
    committed: completed.filter((call) => !live.has(call)),
    live: [...live],
  };
}

/**
 * The newest tools whose estimated rows fit a budget, in their original order.
 * Older tools are dropped first, since the newest is what the user is watching.
 */
export function fitToolsToBudget<T>(tools: readonly T[], budgetRows: number, estimateRows: (tool: T) => number): T[] {
  const kept: T[] = [];
  let used = 0;
  for (let index = tools.length - 1; index >= 0; index--) {
    const tool = tools[index]!;
    const rows = estimateRows(tool);
    if (kept.length > 0 && used + rows > budgetRows) {
      break;
    }
    kept.unshift(tool);
    used += rows;
  }
  return kept;
}
