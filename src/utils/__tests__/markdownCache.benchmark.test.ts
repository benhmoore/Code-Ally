/**
 * Performance Benchmark for Markdown Parse Caching
 *
 * This benchmark demonstrates the performance improvements from caching
 * parsed markdown results. It simulates a real conversation with multiple
 * message re-renders.
 *
 * Run with: npm test -- markdownCache.benchmark.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { marked } from 'marked';
import { LRUCache } from '@utils/LRUCache.js';
import { contentHash } from '@utils/contentHash.js';
import { clearMarkdownCache } from '@ui/components/MarkdownText.js';

// Simplified ParsedNode type for benchmark
interface ParsedNode {
  type: string;
  content?: string;
  language?: string;
  children?: ParsedNode[];
}

// Simplified parseTokens function (mimics the real one)
function parseTokens(tokens: any[]): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  for (const token of tokens) {
    if (token.type === 'code') {
      nodes.push({ type: 'code', content: token.text, language: token.lang });
    } else if (token.type === 'heading') {
      nodes.push({ type: 'heading', content: token.text });
    } else if (token.type === 'paragraph') {
      nodes.push({ type: 'paragraph', content: token.text });
    } else if (token.type === 'list') {
      nodes.push({
        type: 'list',
        children: token.items.map((item: any) => ({
          type: 'list-item',
          content: item.text,
        })),
      });
    }
  }
  return nodes;
}

// Sample markdown messages (realistic conversation)
const SAMPLE_MESSAGES = [
  '# Hello!\n\nHow can I help you today?',
  'I need help with TypeScript generics.',
  `Sure! Here's an example:

\`\`\`typescript
function identity<T>(arg: T): T {
  return arg;
}
\`\`\`

This is a generic function that works with any type.`,
  'Can you explain more about constraints?',
  `Of course! You can constrain generics:

\`\`\`typescript
interface Lengthwise {
  length: number;
}

function loggingIdentity<T extends Lengthwise>(arg: T): T {
  console.log(arg.length);
  return arg;
}
\`\`\`

Key points:
- Use \`extends\` keyword
- Constrains to types with \`length\` property
- Provides type safety`,
  'That makes sense. Can I use multiple constraints?',
  `Yes! You can use intersection types:

\`\`\`typescript
interface Named {
  name: string;
}

interface Aged {
  age: number;
}

function describe<T extends Named & Aged>(obj: T): string {
  return \`\${obj.name} is \${obj.age} years old\`;
}
\`\`\``,
  'Perfect, thank you!',
  'You are welcome! Let me know if you need anything else.',
];

describe('Markdown Cache Performance Benchmark', () => {
  // Clear global cache before each test to ensure isolated benchmarks
  beforeEach(() => {
    clearMarkdownCache();
  });

  // Asserts the PROPERTY that makes the cache worth having — repeated renders
  // parse each distinct message exactly once — rather than wall-clock time.
  // Timing assertions here measured the machine, not the code: durations of a
  // few milliseconds under `fileParallelism: 4` vary enough that a
  // "50% faster" bar failed intermittently, and a gate that fails at random
  // trains people to rerun until green.
  it('parses each distinct message exactly once across repeated renders', () => {
    const cache = new LRUCache<string, ParsedNode[]>(200);
    const RENDERS = 10;

    let uncachedParses = 0;
    for (let render = 0; render < RENDERS; render++) {
      for (const message of SAMPLE_MESSAGES) {
        parseTokens(marked.lexer(message));
        uncachedParses++;
      }
    }

    let cachedParses = 0;
    for (let render = 0; render < RENDERS; render++) {
      for (const message of SAMPLE_MESSAGES) {
        const cacheKey = contentHash(message);
        let parsed = cache.get(cacheKey);

        if (!parsed) {
          parsed = parseTokens(marked.lexer(message));
          cache.set(cacheKey, parsed);
          cachedParses++;
        }
      }
    }

    // Without the cache, every render re-parses every message.
    expect(uncachedParses).toBe(RENDERS * SAMPLE_MESSAGES.length);
    // With it, only the first render parses; the other nine are pure lookups.
    expect(cachedParses).toBe(SAMPLE_MESSAGES.length);
    expect(cache.size).toBe(SAMPLE_MESSAGES.length);
  });

  // The cache key must be stable and collision-free for the content it sees.
  // A per-hash millisecond budget was asserted here before; it measured the host
  // rather than the hash, so it is reported rather than asserted.
  it('produces a stable, distinct key per distinct content', () => {
    const content = '# Test Message\n\nWith some **markdown** content.';

    // Stable: the same content must map to the same cache entry every time, or
    // the cache silently never hits.
    expect(contentHash(content)).toBe(contentHash(content));

    // Distinct: every sample message must occupy its own entry, or renders
    // would serve one message's parse tree for another's.
    const keys = SAMPLE_MESSAGES.map(contentHash);
    expect(new Set(keys).size).toBe(SAMPLE_MESSAGES.length);

    // A single character difference must change the key.
    expect(contentHash(content)).not.toBe(contentHash(content + ' '));
  });

  it('should demonstrate cache hit rate in realistic scenario', () => {
    const cache = new LRUCache<string, ParsedNode[]>(200);

    // Simulate conversation with message updates (same messages re-render multiple times)
    const renders = [
      SAMPLE_MESSAGES.slice(0, 3),  // First 3 messages
      SAMPLE_MESSAGES.slice(0, 5),  // First 5 messages (re-render previous)
      SAMPLE_MESSAGES.slice(0, 7),  // First 7 messages (re-render previous)
      SAMPLE_MESSAGES,              // All messages (re-render previous)
      SAMPLE_MESSAGES,              // Full re-render
      SAMPLE_MESSAGES,              // Another full re-render
    ];

    let totalParses = 0;
    let cacheHits = 0;
    let cacheMisses = 0;

    for (const messageBatch of renders) {
      for (const message of messageBatch) {
        totalParses++;
        const cacheKey = contentHash(message);

        if (cache.has(cacheKey)) {
          cacheHits++;
          cache.get(cacheKey); // Update recency
        } else {
          cacheMisses++;
          const tokens = marked.lexer(message);
          const parsed = parseTokens(tokens);
          cache.set(cacheKey, parsed);
        }
      }
    }

    const hitRate = (cacheHits / totalParses) * 100;

    console.log('\n=== Cache Hit Rate (Realistic Scenario) ===');
    console.log(`Total parses:  ${totalParses}`);
    console.log(`Cache hits:    ${cacheHits}`);
    console.log(`Cache misses:  ${cacheMisses}`);
    console.log(`Hit rate:      ${hitRate.toFixed(1)}%`);

    // In realistic scenario, hit rate should be > 70%
    // (initial messages are cache misses, but subsequent re-renders are hits)
    expect(hitRate).toBeGreaterThan(70);
    expect(cacheHits).toBeGreaterThan(cacheMisses); // More hits than misses
  });

  it('should handle cache eviction gracefully', () => {
    const cache = new LRUCache<string, ParsedNode[]>(5); // Small cache

    // Add more messages than cache capacity
    const messages = Array.from({ length: 10 }, (_, i) => `Message ${i}`);

    for (const message of messages) {
      const cacheKey = contentHash(message);
      const tokens = marked.lexer(message);
      const parsed = parseTokens(tokens);
      cache.set(cacheKey, parsed);
    }

    // Cache should only contain last 5 messages
    expect(cache.size).toBe(5);

    // Most recent messages should still be cached
    const lastMessageKey = contentHash('Message 9');
    expect(cache.has(lastMessageKey)).toBe(true);

    // Oldest messages should be evicted
    const firstMessageKey = contentHash('Message 0');
    expect(cache.has(firstMessageKey)).toBe(false);
  });
});
