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

  it('should demonstrate cache performance improvement', () => {
    const cache = new LRUCache<string, ParsedNode[]>(200);

    // Benchmark: WITHOUT cache (parse every time)
    const withoutCacheStart = Date.now();
    for (let render = 0; render < 10; render++) {
      for (const message of SAMPLE_MESSAGES) {
        const tokens = marked.lexer(message);
        parseTokens(tokens);
      }
    }
    const withoutCacheDuration = Date.now() - withoutCacheStart;

    // Benchmark: WITH cache (parse once, reuse)
    const withCacheStart = Date.now();
    for (let render = 0; render < 10; render++) {
      for (const message of SAMPLE_MESSAGES) {
        const cacheKey = contentHash(message);
        let parsed = cache.get(cacheKey);

        if (!parsed) {
          const tokens = marked.lexer(message);
          parsed = parseTokens(tokens);
          cache.set(cacheKey, parsed);
        }
      }
    }
    const withCacheDuration = Date.now() - withCacheStart;

    // Calculate improvement
    const improvement = ((withoutCacheDuration - withCacheDuration) / withoutCacheDuration) * 100;
    const speedup = withoutCacheDuration / withCacheDuration;

    console.log('\n=== Markdown Cache Performance Benchmark ===');
    console.log(`Without cache: ${withoutCacheDuration}ms`);
    console.log(`With cache:    ${withCacheDuration}ms`);
    console.log(`Improvement:   ${improvement.toFixed(1)}% faster`);
    console.log(`Speedup:       ${speedup.toFixed(2)}x`);
    console.log(`Cache hits:    ${cache.size}/${SAMPLE_MESSAGES.length} unique messages`);

    // Assertions
    expect(withCacheDuration).toBeLessThan(withoutCacheDuration);
    expect(improvement).toBeGreaterThan(50); // At least 50% improvement
    expect(cache.size).toBe(SAMPLE_MESSAGES.length); // All messages cached
  });

  it('should demonstrate hash performance', () => {
    const iterations = 10000;
    const content = '# Test Message\n\nWith some **markdown** content.';

    const start = Date.now();
    for (let i = 0; i < iterations; i++) {
      contentHash(content);
    }
    const duration = Date.now() - start;
    const perHash = duration / iterations;

    console.log('\n=== Hash Performance ===');
    console.log(`Iterations: ${iterations}`);
    console.log(`Total time: ${duration}ms`);
    console.log(`Per hash:   ${perHash.toFixed(3)}ms`);

    // Hash should be very fast (< 0.1ms per hash)
    expect(perHash).toBeLessThan(0.1);
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
