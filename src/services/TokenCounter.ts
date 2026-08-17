/**
 * TokenCounter - Centralized token counting using Anthropic's official tokenizer
 *
 * Replaces all char/3.5 and char/4 heuristics with accurate token counting.
 *
 * The upstream `countTokens()` convenience function constructs and frees the
 * complete tokenizer for every call. TokenManager intentionally counts message
 * fields separately so it can cache per-message totals; using that convenience
 * function turns a cold session restore into hundreds of tokenizer rebuilds.
 * TokenCounter therefore owns one lazily-created tokenizer for its lifetime.
 */

import { getTokenizer } from '@anthropic-ai/tokenizer';

type Tokenizer = ReturnType<typeof getTokenizer>;
type TokenizerFactory = () => Tokenizer;

export class TokenCounter {
  private tokenizer: Tokenizer | null = null;

  constructor(private readonly tokenizerFactory: TokenizerFactory = getTokenizer) {}

  private getOrCreateTokenizer(): Tokenizer {
    this.tokenizer ??= this.tokenizerFactory();
    return this.tokenizer;
  }

  /**
   * Count tokens in text using Anthropic's official tokenizer
   */
  count(text: string): number {
    if (!text || text.length === 0) {
      return 0;
    }
    return this.getOrCreateTokenizer().encode(text.normalize('NFKC'), 'all').length;
  }

  /**
   * Release the native/WASM tokenizer allocation. The counter remains usable:
   * a later count lazily creates a fresh instance. The process-wide singleton
   * normally lives until process exit; this hook makes lifecycle ownership
   * explicit for tests and embedders.
   */
  dispose(): void {
    this.tokenizer?.free();
    this.tokenizer = null;
  }
}

/**
 * Singleton instance for global use
 */
export const tokenCounter = new TokenCounter();
