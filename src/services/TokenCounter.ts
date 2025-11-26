/**
 * TokenCounter - Centralized token counting using Anthropic's official tokenizer
 *
 * Replaces all char/3.5 and char/4 heuristics with accurate token counting.
 */

import { countTokens } from '@anthropic-ai/tokenizer';

export class TokenCounter {
  /**
   * Count tokens in text using Anthropic's official tokenizer
   */
  count(text: string): number {
    if (!text || text.length === 0) {
      return 0;
    }
    return countTokens(text);
  }
}

/**
 * Singleton instance for global use
 */
export const tokenCounter = new TokenCounter();
