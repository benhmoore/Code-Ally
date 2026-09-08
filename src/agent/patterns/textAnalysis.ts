/** Shared text analysis for conservative generation-loop detection. */

/**
 * Find an uninterrupted run of unchanged prose. Keep short or structured items
 * as barriers: dropping them would join repetitions separated by real progress.
 * Preserve numbers, short words, punctuation, and word order as meaningful data.
 */
export function findRepeatedProse(
  items: string[],
  threshold: number,
  isEligible: (text: string) => boolean
): { text: string; count: number } | null {
  let previous = '';
  let count = 0;
  for (const item of items) {
    const normalized = item.trim().replace(/\s+/g, ' ').toLowerCase();
    // Titles and labels alone are insufficient evidence for aborting a stream.
    if ((normalized.match(/\p{L}+/gu)?.length ?? 0) < 6 || !isEligible(item.trim())) {
      previous = '';
      count = 0;
      continue;
    }
    count = normalized === previous ? count + 1 : 1;
    previous = normalized;
    if (count >= threshold) return { text: item.trim(), count };
  }
  return null;
}

/**
 * Truncate text for display
 *
 * Adds ellipsis if text exceeds maxLength.
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum length (including ellipsis)
 * @returns Truncated text with ellipsis if needed
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + '...';
}
