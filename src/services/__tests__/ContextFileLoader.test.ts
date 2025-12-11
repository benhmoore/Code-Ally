/**
 * ContextFileLoader Tests
 *
 * Strategic test coverage for loading context files from compaction summaries.
 * Tests focus on file loading, budget management, formatting, and edge cases.
 *
 * Key scenarios covered:
 * - Loading files from summary metadata
 * - Token budget enforcement (15% allocation)
 * - File truncation (100 line limit)
 * - Language detection for syntax highlighting
 * - Graceful handling of missing/unreadable files
 * - Markdown formatting output
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ContextFileLoader } from '../ContextFileLoader.js';
import type { TokenManager } from '../../agent/TokenManager.js';
import type { Message } from '../../types/index.js';

// ============================================================================
// TEST UTILITIES
// ============================================================================

const testDir = join(tmpdir(), `context-loader-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);

/**
 * Create a mock TokenManager
 */
function createMockTokenManager(remainingTokens: number): TokenManager {
  return {
    getRemainingTokens: vi.fn().mockReturnValue(remainingTokens),
    estimateTokens: vi.fn().mockImplementation((text: string) => {
      // Rough estimate: ~4 chars per token
      return Math.ceil(text.length / 4);
    }),
    // Add other required methods as stubs
    getMaxOutputTokens: vi.fn().mockReturnValue(4096),
    getContextUsagePercentage: vi.fn().mockReturnValue(50),
    getContextWindow: vi.fn().mockReturnValue(128000),
    getCurrentUsage: vi.fn().mockReturnValue(50000),
  } as unknown as TokenManager;
}

/**
 * Create a test summary message
 */
function createSummaryMessage(fileReferences: string[]): Message {
  return {
    id: 'summary-1',
    role: 'system',
    content: 'This is a summary of the previous conversation...',
    timestamp: Date.now(),
    metadata: {
      isSummary: true,
      contextFileReferences: fileReferences,
    },
  };
}

/**
 * Create a test file with specified lines
 */
async function createTestFile(path: string, lineCount: number): Promise<void> {
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(`Line ${i}: Some content for testing`);
  }
  await fs.mkdir(join(testDir, 'files'), { recursive: true });
  await fs.writeFile(path, lines.join('\n'), 'utf-8');
}

// ============================================================================
// TESTS
// ============================================================================

describe('ContextFileLoader', () => {
  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Basic Loading', () => {
    it('should load files from summary metadata', async () => {
      const filePath = join(testDir, 'test.ts');
      await fs.writeFile(filePath, 'const x = 1;\nconst y = 2;', 'utf-8');

      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).not.toBeNull();
      expect(result).toContain('## Context Files');
      expect(result).toContain(filePath);
      expect(result).toContain('const x = 1;');
      expect(result).toContain('const y = 2;');
    });

    it('should return null when no file references', async () => {
      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([]);
      const result = await loader.loadFromSummary(message);

      expect(result).toBeNull();
    });

    it('should return null when contextFileReferences is undefined', async () => {
      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message: Message = {
        id: 'msg-1',
        role: 'system',
        content: 'Summary without file refs',
        timestamp: Date.now(),
        metadata: { isSummary: true },
      };

      const result = await loader.loadFromSummary(message);
      expect(result).toBeNull();
    });

    it('should load multiple files', async () => {
      const file1 = join(testDir, 'a.ts');
      const file2 = join(testDir, 'b.py');
      await fs.writeFile(file1, 'export const a = 1;', 'utf-8');
      await fs.writeFile(file2, 'b = 2', 'utf-8');

      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([file1, file2]);
      const result = await loader.loadFromSummary(message);

      expect(result).toContain(file1);
      expect(result).toContain(file2);
      expect(result).toContain('export const a = 1;');
      expect(result).toContain('b = 2');
    });
  });

  describe('Token Budget', () => {
    it('should respect 15% token budget', async () => {
      // Create a large file
      const filePath = join(testDir, 'large.ts');
      const content = 'x'.repeat(10000); // Large content
      await fs.writeFile(filePath, content, 'utf-8');

      // Small remaining tokens = small budget
      const tokenManager = createMockTokenManager(100); // 15% = 15 tokens
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      // Should not load the large file (exceeds budget)
      expect(result).toBeNull();
    });

    it('should return null when no remaining tokens', async () => {
      const filePath = join(testDir, 'test.ts');
      await fs.writeFile(filePath, 'const x = 1;', 'utf-8');

      const tokenManager = createMockTokenManager(0);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).toBeNull();
    });

    it('should load files until budget exhausted', async () => {
      const file1 = join(testDir, 'small.ts');
      const file2 = join(testDir, 'medium.ts');
      const file3 = join(testDir, 'large.ts');

      await fs.writeFile(file1, 'a', 'utf-8'); // ~50 chars with formatting
      await fs.writeFile(file2, 'b'.repeat(100), 'utf-8'); // ~150 chars
      await fs.writeFile(file3, 'c'.repeat(1000), 'utf-8'); // ~1050 chars

      // Budget for ~200 tokens (~800 chars)
      const tokenManager = createMockTokenManager(1400);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([file1, file2, file3]);
      const result = await loader.loadFromSummary(message);

      expect(result).not.toBeNull();
      expect(result).toContain(file1);
      expect(result).toContain(file2);
      // file3 may or may not be included depending on exact token calculation
    });
  });

  describe('File Truncation', () => {
    it('should truncate files longer than 100 lines', async () => {
      const filePath = join(testDir, 'long.ts');
      await createTestFile(filePath, 150);

      const tokenManager = createMockTokenManager(100000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).toContain('first 100 of 150 lines');
      expect(result).toContain('Line 1:');
      expect(result).toContain('Line 100:');
      expect(result).not.toContain('Line 101:');
    });

    it('should not truncate files with exactly 100 lines', async () => {
      const filePath = join(testDir, 'exact100.ts');
      await createTestFile(filePath, 100);

      const tokenManager = createMockTokenManager(100000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).not.toContain('first 100 of');
      expect(result).toContain('Line 100:');
    });

    it('should not truncate files with fewer than 100 lines', async () => {
      const filePath = join(testDir, 'short.ts');
      await createTestFile(filePath, 50);

      const tokenManager = createMockTokenManager(100000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).not.toContain('first 50 of');
      expect(result).toContain('Line 50:');
    });
  });

  describe('Language Detection', () => {
    const languageTests = [
      { ext: '.ts', lang: 'typescript' },
      { ext: '.tsx', lang: 'typescript' },
      { ext: '.js', lang: 'javascript' },
      { ext: '.jsx', lang: 'javascript' },
      { ext: '.py', lang: 'python' },
      { ext: '.sh', lang: 'bash' },
      { ext: '.json', lang: 'json' },
      { ext: '.html', lang: 'html' },
      { ext: '.css', lang: 'css' },
      { ext: '.go', lang: 'go' },
      { ext: '.rs', lang: 'rust' },
      { ext: '.java', lang: 'java' },
      { ext: '.rb', lang: 'ruby' },
      { ext: '.yaml', lang: 'yaml' },
      { ext: '.yml', lang: 'yaml' },
      { ext: '.md', lang: 'markdown' },
      { ext: '.unknown', lang: 'text' },
    ];

    for (const { ext, lang } of languageTests) {
      it(`should detect ${lang} for ${ext} extension`, async () => {
        const filePath = join(testDir, `file${ext}`);
        await fs.writeFile(filePath, 'content', 'utf-8');

        const tokenManager = createMockTokenManager(10000);
        const loader = new ContextFileLoader(tokenManager);

        const message = createSummaryMessage([filePath]);
        const result = await loader.loadFromSummary(message);

        expect(result).toContain(`\`\`\`${lang}`);
      });
    }
  });

  describe('Error Handling', () => {
    it('should skip missing files gracefully', async () => {
      const existingFile = join(testDir, 'exists.ts');
      const missingFile = join(testDir, 'missing.ts');
      await fs.writeFile(existingFile, 'content', 'utf-8');

      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([missingFile, existingFile]);
      const result = await loader.loadFromSummary(message);

      expect(result).not.toBeNull();
      expect(result).toContain(existingFile);
      expect(result).not.toContain(missingFile);
    });

    it('should return null if all files are missing', async () => {
      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([
        join(testDir, 'missing1.ts'),
        join(testDir, 'missing2.ts'),
      ]);
      const result = await loader.loadFromSummary(message);

      expect(result).toBeNull();
    });

    it('should skip unreadable files', async () => {
      const readableFile = join(testDir, 'readable.ts');
      const unreadableFile = join(testDir, 'unreadable.ts');

      await fs.writeFile(readableFile, 'readable content', 'utf-8');
      await fs.writeFile(unreadableFile, 'unreadable', 'utf-8');

      // Make file unreadable (Unix only)
      try {
        await fs.chmod(unreadableFile, 0o000);
      } catch {
        // Skip test on Windows or if chmod fails
        return;
      }

      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([unreadableFile, readableFile]);
      const result = await loader.loadFromSummary(message);

      expect(result).not.toBeNull();
      expect(result).toContain(readableFile);
      expect(result).not.toContain(unreadableFile);

      // Restore permissions for cleanup
      await fs.chmod(unreadableFile, 0o644);
    });
  });

  describe('Output Formatting', () => {
    it('should format output with context files header', async () => {
      const filePath = join(testDir, 'test.ts');
      await fs.writeFile(filePath, 'content', 'utf-8');

      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).toMatch(/^## Context Files \(from compacted conversation\)/);
    });

    it('should format each file with header and code block', async () => {
      const filePath = join(testDir, 'test.ts');
      await fs.writeFile(filePath, 'const x = 1;', 'utf-8');

      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).toContain(`### ${filePath}`);
      expect(result).toContain('```typescript');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('```');
    });

    it('should include truncation indicator in header', async () => {
      const filePath = join(testDir, 'long.ts');
      await createTestFile(filePath, 200);

      const tokenManager = createMockTokenManager(100000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).toContain(`### ${filePath} (first 100 of 200 lines)`);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty file', async () => {
      const filePath = join(testDir, 'empty.ts');
      await fs.writeFile(filePath, '', 'utf-8');

      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).not.toBeNull();
      expect(result).toContain(filePath);
    });

    it('should handle file with only whitespace', async () => {
      const filePath = join(testDir, 'whitespace.ts');
      await fs.writeFile(filePath, '   \n\n   \n', 'utf-8');

      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).not.toBeNull();
    });

    it('should handle file with special characters', async () => {
      const filePath = join(testDir, 'special.ts');
      await fs.writeFile(filePath, 'const emoji = "🚀";\nconst quote = `\``;', 'utf-8');

      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).toContain('🚀');
    });

    it('should handle file path with spaces', async () => {
      const filePath = join(testDir, 'file with spaces.ts');
      await fs.writeFile(filePath, 'content', 'utf-8');

      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      const message = createSummaryMessage([filePath]);
      const result = await loader.loadFromSummary(message);

      expect(result).toContain('file with spaces.ts');
    });

    it('should preserve priority order from file references', async () => {
      const file1 = join(testDir, 'first.ts');
      const file2 = join(testDir, 'second.ts');
      const file3 = join(testDir, 'third.ts');

      await fs.writeFile(file1, '// First file', 'utf-8');
      await fs.writeFile(file2, '// Second file', 'utf-8');
      await fs.writeFile(file3, '// Third file', 'utf-8');

      const tokenManager = createMockTokenManager(10000);
      const loader = new ContextFileLoader(tokenManager);

      // Order: file1 -> file2 -> file3
      const message = createSummaryMessage([file1, file2, file3]);
      const result = await loader.loadFromSummary(message);

      // Files should appear in order
      const file1Index = result!.indexOf('first.ts');
      const file2Index = result!.indexOf('second.ts');
      const file3Index = result!.indexOf('third.ts');

      expect(file1Index).toBeLessThan(file2Index);
      expect(file2Index).toBeLessThan(file3Index);
    });
  });
});
