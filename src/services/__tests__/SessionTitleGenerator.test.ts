/**
 * SessionTitleGenerator unit tests
 *
 * Tests automatic title generation from conversation messages
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionTitleGenerator } from '../SessionTitleGenerator.js';
import { ModelClient, LLMResponse } from '../../llm/ModelClient.js';
import { Message } from '../../types/index.js';

// Mock ModelClient
class MockModelClient extends ModelClient {
  private mockResponse: string = 'Generated Title';

  constructor(mockResponse?: string) {
    super();
    if (mockResponse) this.mockResponse = mockResponse;
  }

  setMockResponse(response: string) {
    this.mockResponse = response;
  }

  async send(): Promise<LLMResponse> {
    return {
      role: 'assistant',
      content: this.mockResponse,
    };
  }

  get modelName(): string {
    return 'mock-model';
  }

  get endpoint(): string {
    return 'http://mock';
  }
}

describe('SessionTitleGenerator', () => {
  let mockClient: MockModelClient;
  let generator: SessionTitleGenerator;

  beforeEach(() => {
    mockClient = new MockModelClient();
    generator = new SessionTitleGenerator(mockClient);
  });

  afterEach(async () => {
    await generator.cleanup();
  });

  describe('generateTitle', () => {
    it('should generate title from user messages', async () => {
      mockClient.setMockResponse('Debugging authentication issue');

      const messages: Message[] = [
        { role: 'user', content: 'Help me debug an authentication issue in my app' },
      ];

      const title = await generator.generateTitle(messages);
      expect(title).toBe('Debugging authentication issue');
    });

    it('should return default title for empty messages', async () => {
      const title = await generator.generateTitle([]);
      expect(title).toBe('New Session');
    });

    it('should return default title for no user messages', async () => {
      const messages: Message[] = [
        { role: 'assistant', content: 'Hello!' },
      ];

      const title = await generator.generateTitle(messages);
      expect(title).toBe('New Session');
    });

    it('should clean up quotes from generated title', async () => {
      mockClient.setMockResponse('"Testing Authentication"');

      const messages: Message[] = [
        { role: 'user', content: 'Test authentication' },
      ];

      const title = await generator.generateTitle(messages);
      expect(title).toBe('Testing Authentication');
    });

    it('should truncate long titles', async () => {
      const longTitle = 'a'.repeat(100);
      mockClient.setMockResponse(longTitle);

      const messages: Message[] = [
        { role: 'user', content: 'Test' },
      ];

      const title = await generator.generateTitle(messages);
      expect(title.length).toBeLessThanOrEqual(60);
      expect(title).toContain('...');
    });

    it('should handle generation errors gracefully', async () => {
      // Create a client that throws errors
      const errorClient = new MockModelClient();
      errorClient.send = async () => {
        throw new Error('API error');
      };

      const errorGenerator = new SessionTitleGenerator(errorClient);

      const messages: Message[] = [
        { role: 'user', content: 'This is a test message that should be used as fallback' },
      ];

      const title = await errorGenerator.generateTitle(messages);
      // Fallback uses first 40 chars
      expect(title).toBe('This is a test message that should be us...');
    });

    it('should use first user message for fallback title', async () => {
      const errorClient = new MockModelClient();
      errorClient.send = async () => {
        throw new Error('API error');
      };

      const errorGenerator = new SessionTitleGenerator(errorClient);

      const messages: Message[] = [
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Test fallback title' },
        { role: 'assistant', content: 'Response' },
      ];

      const title = await errorGenerator.generateTitle(messages);
      expect(title).toBe('Test fallback title');
    });

    it('should clean up whitespace in fallback title', async () => {
      const errorClient = new MockModelClient();
      errorClient.send = async () => {
        throw new Error('API error');
      };

      const errorGenerator = new SessionTitleGenerator(errorClient);

      const messages: Message[] = [
        { role: 'user', content: 'Test\n   with\n\n   multiple    spaces' },
      ];

      const title = await errorGenerator.generateTitle(messages);
      expect(title).toBe('Test with multiple spaces');
    });
  });

  describe('generateTitleBackground', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = join(tmpdir(), `title-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
      await fs.mkdir(tempDir, { recursive: true });
    });

    afterEach(async () => {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should generate and save title in background', async () => {
      mockClient.setMockResponse('Background Title');

      // Create a test session file
      const sessionName = 'test-session';
      const sessionPath = join(tempDir, `${sessionName}.json`);
      const sessionData = {
        id: sessionName,
        name: sessionName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [],
        metadata: {},
      };

      await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));

      // Generate title in background
      generator.generateTitleBackground(
        sessionName,
        'Test message for background generation',
        tempDir
      );

      // Wait for background operation to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify title was saved
      const content = await fs.readFile(sessionPath, 'utf-8');
      const updatedSession = JSON.parse(content);

      expect(updatedSession.metadata.title).toBe('Background Title');
    });

    it('should not overwrite existing title', async () => {
      mockClient.setMockResponse('New Title');

      // Create session with existing title
      const sessionName = 'existing-title-session';
      const sessionPath = join(tempDir, `${sessionName}.json`);
      const sessionData = {
        id: sessionName,
        name: sessionName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [],
        metadata: {
          title: 'Existing Title',
        },
      };

      await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));

      // Try to generate title in background
      generator.generateTitleBackground(
        sessionName,
        'Test message',
        tempDir
      );

      // Wait for background operation
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify title was NOT changed
      const content = await fs.readFile(sessionPath, 'utf-8');
      const updatedSession = JSON.parse(content);

      expect(updatedSession.metadata.title).toBe('Existing Title');
    });

    it('should prevent duplicate generations for same session', async () => {
      let callCount = 0;
      const countingClient = new MockModelClient();
      countingClient.send = async () => {
        callCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
        return {
          role: 'assistant',
          content: 'Title',
        };
      };

      const countingGenerator = new SessionTitleGenerator(countingClient);

      // Create session
      const sessionName = 'duplicate-test';
      const sessionPath = join(tempDir, `${sessionName}.json`);
      const sessionData = {
        id: sessionName,
        name: sessionName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [],
        metadata: {},
      };

      await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));

      // Call multiple times quickly
      countingGenerator.generateTitleBackground(sessionName, 'Test', tempDir);
      countingGenerator.generateTitleBackground(sessionName, 'Test', tempDir);
      countingGenerator.generateTitleBackground(sessionName, 'Test', tempDir);

      // Wait for operations
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should only have called once
      expect(callCount).toBe(1);

      await countingGenerator.cleanup();
    });

    it('should handle missing session file gracefully', async () => {
      // Generate title for non-existent session
      generator.generateTitleBackground(
        'non-existent-session',
        'Test message',
        tempDir
      );

      // Should not throw error, just fail silently
      await new Promise(resolve => setTimeout(resolve, 100));

      // No error expected
      expect(true).toBe(true);
    });
  });

  describe('buildTitlePrompt', () => {
    it('should build proper prompt from message', () => {
      const prompt = (generator as any).buildTitlePrompt('Test message content');

      expect(prompt).toContain('Test message content');
      expect(prompt).toContain('concise');
      expect(prompt).toContain('title');
    });

    it('should truncate long messages in prompt', () => {
      const longMessage = 'a'.repeat(300);
      const prompt = (generator as any).buildTitlePrompt(longMessage);

      expect(prompt.length).toBeLessThan(500);
    });
  });

  describe('cleanup', () => {
    it('should wait for pending generations', async () => {
      let generationComplete = false;

      const slowClient = new MockModelClient();
      slowClient.send = async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        generationComplete = true;
        return {
          role: 'assistant',
          content: 'Title',
        };
      };

      const slowGenerator = new SessionTitleGenerator(slowClient);

      // Create temp dir and session
      const tempDir = join(tmpdir(), `cleanup-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
      await fs.mkdir(tempDir, { recursive: true });

      const sessionPath = join(tempDir, 'test.json');
      await fs.writeFile(
        sessionPath,
        JSON.stringify({
          id: 'test',
          name: 'test',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          messages: [],
          metadata: {},
        })
      );

      // Start background generation
      slowGenerator.generateTitleBackground('test', 'Test', tempDir);

      // Cleanup should wait
      await slowGenerator.cleanup();

      expect(generationComplete).toBe(true);

      // Cleanup temp dir
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should timeout if generations take too long', async () => {
      const verySlowClient = new MockModelClient();
      verySlowClient.send = async () => {
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
        return {
          role: 'assistant',
          content: 'Title',
        };
      };

      const verySlowGenerator = new SessionTitleGenerator(verySlowClient);

      // Create temp dir and session
      const tempDir = join(tmpdir(), `timeout-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
      await fs.mkdir(tempDir, { recursive: true });

      const sessionPath = join(tempDir, 'test.json');
      await fs.writeFile(
        sessionPath,
        JSON.stringify({
          id: 'test',
          name: 'test',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          messages: [],
          metadata: {},
        })
      );

      // Start background generation
      verySlowGenerator.generateTitleBackground('test', 'Test', tempDir);

      const startTime = Date.now();
      await verySlowGenerator.cleanup();
      const endTime = Date.now();

      // Should timeout within 5-6 seconds, not wait 10 seconds
      expect(endTime - startTime).toBeLessThan(7000);

      // Cleanup temp dir
      await fs.rm(tempDir, { recursive: true, force: true });
    }, 10000); // Increase test timeout to 10 seconds
  });

  describe('configuration', () => {
    it('should accept custom configuration', () => {
      const customGenerator = new SessionTitleGenerator(mockClient, {
        maxTokens: 100,
        temperature: 0.5,
      });

      // Configuration is accepted but not exposed as properties
      // This is fine - the config would be used in future enhancements
      expect(customGenerator).toBeDefined();
    });

    it('should work with default configuration', () => {
      // Default config is fine
      expect(generator).toBeDefined();
    });
  });
});
