/**
 * Tests for content hashing utility
 */

import { describe, it, expect } from 'vitest';
import { contentHash, markdownHash, verifyHashDistribution } from '@utils/contentHash.js';

describe('contentHash', () => {
  describe('basic functionality', () => {
    it('should produce deterministic hashes', () => {
      const hash1 = contentHash('Hello, world!');
      const hash2 = contentHash('Hello, world!');

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', () => {
      const hash1 = contentHash('Hello, world!');
      const hash2 = contentHash('Hello, world?');

      expect(hash1).not.toBe(hash2);
    });

    it('should return 8-character hex string', () => {
      const hash = contentHash('test');

      expect(hash).toMatch(/^[0-9a-f]{8}$/);
      expect(hash.length).toBe(8);
    });

    it('should handle empty string', () => {
      const hash = contentHash('');

      expect(hash).toBe('00000000');
    });
  });

  describe('collision resistance', () => {
    it('should produce different hashes for similar strings', () => {
      const strings = [
        'test',
        'test ',
        ' test',
        'Test',
        'test1',
        'test2',
        'testing',
      ];

      const hashes = strings.map(s => contentHash(s));
      const uniqueHashes = new Set(hashes);

      expect(uniqueHashes.size).toBe(strings.length);
    });

    it('should handle unicode characters differently', () => {
      const hash1 = contentHash('café');
      const hash2 = contentHash('cafe');

      expect(hash1).not.toBe(hash2);
    });

    it('should be sensitive to whitespace', () => {
      const hash1 = contentHash('hello world');
      const hash2 = contentHash('hello  world');
      const hash3 = contentHash('helloworld');

      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash2).not.toBe(hash3);
    });

    it('should be case-sensitive', () => {
      const hash1 = contentHash('Hello');
      const hash2 = contentHash('hello');
      const hash3 = contentHash('HELLO');

      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash2).not.toBe(hash3);
    });
  });

  describe('markdown-specific content', () => {
    it('should hash markdown formatting correctly', () => {
      const md1 = '# Heading\n\nParagraph text';
      const md2 = '## Heading\n\nParagraph text';

      const hash1 = contentHash(md1);
      const hash2 = contentHash(md2);

      expect(hash1).not.toBe(hash2);
    });

    it('should distinguish code blocks', () => {
      const md1 = '```typescript\nconst x = 1;\n```';
      const md2 = '```javascript\nconst x = 1;\n```';

      const hash1 = contentHash(md1);
      const hash2 = contentHash(md2);

      expect(hash1).not.toBe(hash2);
    });

    it('should handle long markdown content', () => {
      const longMarkdown = `
# Large Markdown Document

This is a very long markdown document with multiple sections.

## Section 1

Lorem ipsum dolor sit amet, consectetur adipiscing elit.
${'Multiple paragraphs. '.repeat(100)}

## Section 2

${'More content here. '.repeat(50)}

\`\`\`typescript
function example() {
  return 'code block';
}
\`\`\`

- List item 1
- List item 2
- List item 3

| Table | Headers |
|-------|---------|
| Data  | Values  |
      `.trim();

      const hash = contentHash(longMarkdown);

      expect(hash).toMatch(/^[0-9a-f]{8}$/);
      expect(hash).not.toBe('00000000');

      // Verify same content produces same hash
      const hash2 = contentHash(longMarkdown);
      expect(hash).toBe(hash2);
    });
  });

  describe('edge cases', () => {
    it('should handle special characters', () => {
      const strings = [
        '!@#$%^&*()',
        '<html>',
        '{json: "value"}',
        '[markdown](link)',
        '\\n\\t\\r',
        '※ © ® ™',
      ];

      const hashes = strings.map(s => contentHash(s));
      const uniqueHashes = new Set(hashes);

      expect(uniqueHashes.size).toBe(strings.length);
    });

    it('should handle newlines and line endings', () => {
      const hash1 = contentHash('line1\nline2');
      const hash2 = contentHash('line1\r\nline2');
      const hash3 = contentHash('line1line2');

      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash2).not.toBe(hash3);
    });

    it('should handle very long strings efficiently', () => {
      const veryLongString = 'a'.repeat(100000);

      const start = Date.now();
      const hash = contentHash(veryLongString);
      const duration = Date.now() - start;

      expect(hash).toMatch(/^[0-9a-f]{8}$/);
      expect(duration).toBeLessThan(100); // Should be fast (< 100ms)
    });

    it('should handle emoji and multi-byte characters', () => {
      const hash1 = contentHash('Hello 👋');
      const hash2 = contentHash('Hello 👍');
      const hash3 = contentHash('Hello');

      expect(hash1).not.toBe(hash2);
      expect(hash1).not.toBe(hash3);
    });
  });

  describe('markdownHash', () => {
    it('should be an alias for contentHash', () => {
      const content = '# Markdown Content\n\nParagraph';
      const hash1 = contentHash(content);
      const hash2 = markdownHash(content);

      expect(hash1).toBe(hash2);
    });
  });

  describe('verifyHashDistribution', () => {
    it('should detect no collisions in similar strings', () => {
      const testStrings = [
        'test',
        'test ',
        ' test',
        'Test',
        'TEST',
      ];

      const noCollisions = verifyHashDistribution(testStrings);

      expect(noCollisions).toBe(true);
    });

    it('should return true for empty array', () => {
      const noCollisions = verifyHashDistribution([]);

      expect(noCollisions).toBe(true);
    });

    it('should return true for single string', () => {
      const noCollisions = verifyHashDistribution(['test']);

      expect(noCollisions).toBe(true);
    });

    it('should detect collision if duplicate strings provided', () => {
      const testStrings = [
        'test',
        'different',
        'test', // Duplicate - will have same hash
      ];

      const noCollisions = verifyHashDistribution(testStrings);

      expect(noCollisions).toBe(false);
    });

    it('should work with large sets of strings', () => {
      // Generate 1000 unique strings
      const testStrings = Array.from({ length: 1000 }, (_, i) => `string_${i}`);

      const noCollisions = verifyHashDistribution(testStrings);

      expect(noCollisions).toBe(true);
    });
  });

  describe('performance characteristics', () => {
    it('should hash small strings quickly', () => {
      const content = 'Short string';

      const iterations = 10000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        contentHash(content);
      }

      const duration = Date.now() - start;
      const perHash = duration / iterations;

      expect(perHash).toBeLessThan(1); // Should be < 1ms per hash
    });

    it('should hash typical markdown content quickly', () => {
      const content = `
# Heading

This is a typical message with some **bold** and *italic* text.

\`\`\`typescript
const code = 'example';
\`\`\`

- List item 1
- List item 2
      `.trim();

      const iterations = 1000;
      const start = Date.now();

      for (let i = 0; i < iterations; i++) {
        contentHash(content);
      }

      const duration = Date.now() - start;
      const perHash = duration / iterations;

      expect(perHash).toBeLessThan(1); // Should be < 1ms per hash
    });
  });
});
