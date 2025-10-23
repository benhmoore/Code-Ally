/**
 * Tests for SessionLookupTool and SessionReadTool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionLookupTool } from '../SessionLookupTool.js';
import { SessionReadTool } from '../SessionReadTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { SessionManager } from '../../services/SessionManager.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Session Tools', () => {
  let activityStream: ActivityStream;
  let lookupTool: SessionLookupTool;
  let readTool: SessionReadTool;
  let sessionManager: SessionManager;
  let tempDir: string;

  beforeEach(async () => {
    // Create temp sessions directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-tools-test-'));

    // Create services
    activityStream = new ActivityStream();
    sessionManager = new SessionManager({ maxSessions: 100 });
    (sessionManager as any).sessionsDir = tempDir;
    await sessionManager.initialize();

    // Register in ServiceRegistry
    const registry = ServiceRegistry.getInstance();
    registry.registerInstance('session_manager', sessionManager);

    // Create tools
    lookupTool = new SessionLookupTool(activityStream);
    readTool = new SessionReadTool(activityStream);

    // Create test sessions
    await createTestSessions();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function createTestSessions() {
    // Session 1: Authentication bug fix
    await sessionManager.createSession('auth-fix');
    await sessionManager.saveSession('auth-fix', [
      { role: 'user', content: 'We have an authentication bug where tokens expire too quickly' },
      { role: 'assistant', content: 'I can help fix the authentication token expiration issue. Let me check the token configuration.' },
      { role: 'user', content: 'The tokens are set to expire in 5 minutes' },
      { role: 'assistant', content: 'That is too short. I recommend changing the token expiration to 24 hours for better UX.' },
    ]);

    // Session 2: Database migration
    await sessionManager.createSession('db-migration');
    await sessionManager.saveSession('db-migration', [
      { role: 'user', content: 'Need to migrate the database schema' },
      { role: 'assistant', content: 'I can help with the database migration. What changes do you need?' },
      { role: 'user', content: 'Add a new users table with email and password fields' },
      { role: 'assistant', content: 'Here is the migration script for adding the users table with email and password columns.' },
    ]);

    // Session 3: API endpoint (short session, should be filtered by min_messages)
    await sessionManager.createSession('api-endpoint');
    await sessionManager.saveSession('api-endpoint', [
      { role: 'user', content: 'Create API endpoint' },
    ]);

    // Session 4: Another authentication discussion
    await sessionManager.createSession('auth-refactor');
    await sessionManager.saveSession('auth-refactor', [
      { role: 'user', content: 'Refactor authentication middleware' },
      { role: 'assistant', content: 'The authentication middleware can be improved by adding rate limiting.' },
      { role: 'user', content: 'Good idea, how do we implement rate limiting?' },
      { role: 'assistant', content: 'We can use Redis to track authentication attempts and implement exponential backoff.' },
    ]);
  }

  describe('SessionLookupTool', () => {
    describe('basic properties', () => {
      it('should have correct name', () => {
        expect(lookupTool.name).toBe('session_lookup');
      });

      it('should not require confirmation', () => {
        expect(lookupTool.requiresConfirmation).toBe(false);
      });

      it('should have function definition', () => {
        const def = lookupTool.getFunctionDefinition();
        expect(def.function.name).toBe('session_lookup');
        expect(def.function.parameters.properties).toHaveProperty('keywords');
        expect(def.function.parameters.properties).toHaveProperty('search_mode');
      });
    });

    describe('execute', () => {
      it('should find sessions matching single keyword', async () => {
        const result = await lookupTool.execute({ keywords: ['authentication'] });

        expect(result.success).toBe(true);
        expect(result.sessions).toBeDefined();
        expect(Array.isArray(result.sessions)).toBe(true);
        expect(result.sessions.length).toBeGreaterThan(0);
      });

      it('should find sessions matching multiple keywords with "any" mode', async () => {
        const result = await lookupTool.execute({
          keywords: ['authentication', 'database'],
          search_mode: 'any',
        });

        expect(result.success).toBe(true);
        expect(result.sessions.length).toBeGreaterThan(0);
      });

      it('should find sessions matching all keywords with "all" mode', async () => {
        const result = await lookupTool.execute({
          keywords: ['authentication', 'token'],
          search_mode: 'all',
        });

        expect(result.success).toBe(true);
        // Should only match sessions containing both "authentication" AND "token"
        expect(result.sessions.every((s: any) => s.match_count > 0)).toBe(true);
      });

      it('should return sessions with match count', async () => {
        const result = await lookupTool.execute({ keywords: ['authentication'] });

        expect(result.success).toBe(true);
        const session = result.sessions[0];
        expect(session.session_id).toBeDefined();
        expect(session.match_count).toBeGreaterThan(0);
        expect(session.message_snippets).toBeDefined();
        expect(Array.isArray(session.message_snippets)).toBe(true);
      });

      it('should include message snippets with indices', async () => {
        const result = await lookupTool.execute({ keywords: ['authentication'] });

        expect(result.success).toBe(true);
        const snippet = result.sessions[0].message_snippets[0];
        expect(snippet.message_index).toBeDefined();
        expect(typeof snippet.message_index).toBe('number');
        expect(snippet.role).toBeDefined();
        expect(snippet.content).toBeDefined();
        expect(snippet.match_preview).toBeDefined();
      });

      it('should sort by match count then recency', async () => {
        const result = await lookupTool.execute({ keywords: ['authentication'] });

        expect(result.success).toBe(true);
        expect(result.sessions.length).toBeGreaterThanOrEqual(2);

        // Verify sorting (higher match count or more recent first)
        for (let i = 0; i < result.sessions.length - 1; i++) {
          const current = result.sessions[i];
          const next = result.sessions[i + 1];

          if (current.match_count === next.match_count) {
            expect(current.last_modified_timestamp).toBeGreaterThanOrEqual(
              next.last_modified_timestamp
            );
          } else {
            expect(current.match_count).toBeGreaterThan(next.match_count);
          }
        }
      });

      it('should respect max_results parameter', async () => {
        const result = await lookupTool.execute({
          keywords: ['authentication'],
          max_results: 1,
        });

        expect(result.success).toBe(true);
        expect(result.sessions.length).toBe(1);
      });

      it('should filter by min_messages', async () => {
        const result = await lookupTool.execute({
          keywords: ['API'],
          min_messages: 3,
        });

        expect(result.success).toBe(true);
        // Should not include the short 'api-endpoint' session (1 message)
        expect(result.sessions.every((s: any) => s.session_id !== 'api-endpoint')).toBe(true);
      });

      it('should return empty results for non-matching keywords', async () => {
        const result = await lookupTool.execute({ keywords: ['nonexistent-term-xyz'] });

        expect(result.success).toBe(true);
        expect(result.sessions).toEqual([]);
      });

      it('should return recent sessions when keywords is empty array', async () => {
        const result = await lookupTool.execute({ keywords: [] });

        expect(result.success).toBe(true);
        expect(result.sessions).toBeDefined();
        expect(Array.isArray(result.sessions)).toBe(true);
        expect(result.sessions.length).toBeGreaterThan(0);
      });

      it('should return recent sessions when keywords is omitted', async () => {
        const result = await lookupTool.execute({});

        expect(result.success).toBe(true);
        expect(result.sessions).toBeDefined();
        expect(result.sessions.length).toBeGreaterThan(0);
      });
    });
  });

  describe('SessionReadTool', () => {
    describe('basic properties', () => {
      it('should have correct name', () => {
        expect(readTool.name).toBe('session_read');
      });

      it('should not require confirmation', () => {
        expect(readTool.requiresConfirmation).toBe(false);
      });

      it('should have function definition', () => {
        const def = readTool.getFunctionDefinition();
        expect(def.function.name).toBe('session_read');
        expect(def.function.parameters.required).toContain('session_id');
      });
    });

    describe('execute', () => {
      it('should read full session', async () => {
        const result = await readTool.execute({
          session_id: 'auth-fix',
          load_full: true,
        });

        expect(result.success).toBe(true);
        expect(result.messages).toBeDefined();
        expect(Array.isArray(result.messages)).toBe(true);
        expect(result.messages.length).toBe(4);
        expect(result.total_messages).toBe(4);
      });

      it('should read message range', async () => {
        const result = await readTool.execute({
          session_id: 'auth-fix',
          start_index: 1,
          end_index: 2,
        });

        expect(result.success).toBe(true);
        expect(result.messages.length).toBe(2);
        expect(result.messages[0].content).toContain('help fix');
      });

      it('should read from start_index to end', async () => {
        const result = await readTool.execute({
          session_id: 'auth-fix',
          start_index: 2,
        });

        expect(result.success).toBe(true);
        expect(result.messages.length).toBe(2);
      });

      it('should read first 10 messages by default', async () => {
        const result = await readTool.execute({
          session_id: 'auth-fix',
        });

        expect(result.success).toBe(true);
        expect(result.messages.length).toBeLessThanOrEqual(10);
      });

      it('should include session metadata', async () => {
        const result = await readTool.execute({
          session_id: 'auth-fix',
          load_full: true,
        });

        expect(result.success).toBe(true);
        expect(result.session_id).toBe('auth-fix');
        expect(result.working_dir).toBeDefined();
        expect(result.total_messages).toBeDefined();
      });

      it('should handle non-existent session', async () => {
        const result = await readTool.execute({
          session_id: 'does-not-exist',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });

      it('should validate start_index', async () => {
        const result = await readTool.execute({
          session_id: 'auth-fix',
          start_index: 999,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('out of range');
      });

      it('should validate end_index >= start_index', async () => {
        const result = await readTool.execute({
          session_id: 'auth-fix',
          start_index: 3,
          end_index: 1,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('end_index must be >= start_index');
      });
    });
  });

  describe('Integration', () => {
    it('should work together: lookup then read', async () => {
      // First, lookup sessions
      const lookupResult = await lookupTool.execute({ keywords: ['authentication'] });

      expect(lookupResult.success).toBe(true);
      expect(lookupResult.sessions.length).toBeGreaterThan(0);

      // Then, read the first matching session
      const sessionId = lookupResult.sessions[0].session_id;
      const messageIndex = lookupResult.sessions[0].message_snippets[0].message_index;

      const readResult = await readTool.execute({
        session_id: sessionId,
        start_index: messageIndex,
        end_index: messageIndex + 2,
      });

      expect(readResult.success).toBe(true);
      expect(readResult.messages).toBeDefined();
      expect(readResult.messages.length).toBeGreaterThan(0);
    });
  });
});
