/**
 * SessionManager unit tests
 *
 * Tests session persistence, CRUD operations, cleanup, and metadata management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionManager } from '../SessionManager.js';
import { Message } from '@shared/index.js';

describe('SessionManager', () => {
  let tempDir: string;
  let sessionManager: SessionManager;
  let originalSessionsDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test sessions
    tempDir = join(tmpdir(), `code-ally-sessions-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Create a new SessionManager instance
    // Note: SessionManager uses process.cwd()/.ally-sessions by default
    const SessionManagerModule = await import('../SessionManager.js');
    sessionManager = new SessionManagerModule.SessionManager({ maxSessions: 3 });

    // Override sessionsDir for testing
    (sessionManager as any).sessionsDir = tempDir;

    await sessionManager.initialize();
  });

  afterEach(async () => {
    await sessionManager.cleanup();

    // Cleanup temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should create sessions directory', async () => {
      await expect(fs.access(tempDir)).resolves.toBeUndefined();
    });

    it('should implement IService interface', () => {
      expect(typeof sessionManager.initialize).toBe('function');
      expect(typeof sessionManager.cleanup).toBe('function');
    });
  });

  describe('generateSessionName', () => {
    it('should generate unique session names', () => {
      const name1 = sessionManager.generateSessionName();
      const name2 = sessionManager.generateSessionName();

      expect(name1).toMatch(/^session_\d{8}T\d{6}_[a-f0-9]{8}$/);
      expect(name2).toMatch(/^session_\d{8}T\d{6}_[a-f0-9]{8}$/);
      expect(name1).not.toBe(name2);
    });
  });

  describe('createSession', () => {
    it('should create a new session with auto-generated name', async () => {
      const sessionName = await sessionManager.createSession();

      expect(sessionName).toMatch(/^session_\d{8}T\d{6}_[a-f0-9]{8}$/);
      expect(await sessionManager.sessionExists(sessionName)).toBe(true);
    });

    it('should create a new session with custom name', async () => {
      const sessionName = await sessionManager.createSession('my-custom-session');

      expect(sessionName).toBe('my-custom-session');
      expect(await sessionManager.sessionExists('my-custom-session')).toBe(true);
    });

    it('should create session with correct structure', async () => {
      const sessionName = await sessionManager.createSession('test-session');
      const session = await sessionManager.loadSession(sessionName);

      expect(session).not.toBeNull();
      expect(session?.id).toBe('test-session');
      expect(session?.name).toBe('test-session');
      expect(session?.messages).toEqual([]);
      expect(session?.metadata).toEqual({});
      expect(session?.created_at).toBeDefined();
      expect(session?.updated_at).toBeDefined();
    });
  });

  describe('loadSession', () => {
    it('should load existing session', async () => {
      const sessionName = await sessionManager.createSession('load-test');
      const session = await sessionManager.loadSession('load-test');

      expect(session).not.toBeNull();
      expect(session?.name).toBe('load-test');
    });

    it('should return null for non-existent session', async () => {
      const session = await sessionManager.loadSession('does-not-exist');
      expect(session).toBeNull();
    });

    it('should handle corrupted JSON gracefully', async () => {
      const sessionPath = join(tempDir, 'corrupted.json');
      await fs.writeFile(sessionPath, 'invalid json{', 'utf-8');

      const session = await sessionManager.loadSession('corrupted');
      expect(session).toBeNull();
    });
  });

  describe('saveSession', () => {
    it('should save messages to existing session', async () => {
      await sessionManager.createSession('save-test');

      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const result = await sessionManager.saveSession('save-test', messages);
      expect(result).toBe(true);

      const session = await sessionManager.loadSession('save-test');
      expect(session?.messages).toEqual(messages);
    });

    it('should create session if it does not exist', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
      ];

      const result = await sessionManager.saveSession('new-save-test', messages);
      expect(result).toBe(true);

      const session = await sessionManager.loadSession('new-save-test');
      expect(session?.messages).toEqual(messages);
    });

    it('should update timestamps', async () => {
      await sessionManager.createSession('timestamp-test');

      const session1 = await sessionManager.loadSession('timestamp-test');
      const originalTimestamp = session1?.updated_at;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      await sessionManager.saveSession('timestamp-test', [
        { role: 'user', content: 'Test' },
      ]);

      const session2 = await sessionManager.loadSession('timestamp-test');
      expect(session2?.updated_at).not.toBe(originalTimestamp);
    });
  });

  describe('sessionExists', () => {
    it('should return true for existing session', async () => {
      await sessionManager.createSession('exists-test');
      expect(await sessionManager.sessionExists('exists-test')).toBe(true);
    });

    it('should return false for non-existent session', async () => {
      expect(await sessionManager.sessionExists('does-not-exist')).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('should list all sessions', async () => {
      await sessionManager.createSession('session-1');
      await sessionManager.createSession('session-2');
      await sessionManager.createSession('session-3');

      const sessions = await sessionManager.listSessions();
      expect(sessions).toContain('session-1');
      expect(sessions).toContain('session-2');
      expect(sessions).toContain('session-3');
      expect(sessions.length).toBe(3);
    });

    it('should return empty array when no sessions exist', async () => {
      const sessions = await sessionManager.listSessions();
      expect(sessions).toEqual([]);
    });

    it('should return sorted sessions', async () => {
      await sessionManager.createSession('zebra');
      await sessionManager.createSession('alpha');
      await sessionManager.createSession('beta');

      const sessions = await sessionManager.listSessions();
      expect(sessions).toEqual(['alpha', 'beta', 'zebra']);
    });
  });

  describe('deleteSession', () => {
    it('should delete existing session', async () => {
      await sessionManager.createSession('delete-test');
      expect(await sessionManager.sessionExists('delete-test')).toBe(true);

      const result = await sessionManager.deleteSession('delete-test');
      expect(result).toBe(true);
      expect(await sessionManager.sessionExists('delete-test')).toBe(false);
    });

    it('should return false for non-existent session', async () => {
      const result = await sessionManager.deleteSession('does-not-exist');
      expect(result).toBe(false);
    });

    it('should clear current session if deleted', async () => {
      await sessionManager.createSession('current-delete-test');
      sessionManager.setCurrentSession('current-delete-test');

      expect(sessionManager.getCurrentSession()).toBe('current-delete-test');

      await sessionManager.deleteSession('current-delete-test');
      expect(sessionManager.getCurrentSession()).toBeNull();
    });
  });

  describe('current session management', () => {
    it('should get and set current session', () => {
      expect(sessionManager.getCurrentSession()).toBeNull();

      sessionManager.setCurrentSession('test-session');
      expect(sessionManager.getCurrentSession()).toBe('test-session');

      sessionManager.setCurrentSession(null);
      expect(sessionManager.getCurrentSession()).toBeNull();
    });
  });

  describe('getSessionMessages', () => {
    it('should get messages from existing session', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ];

      await sessionManager.createSession('msg-test');
      await sessionManager.saveSession('msg-test', messages);

      const retrieved = await sessionManager.getSessionMessages('msg-test');
      expect(retrieved).toEqual(messages);
    });

    it('should return empty array for non-existent session', async () => {
      const messages = await sessionManager.getSessionMessages('does-not-exist');
      expect(messages).toEqual([]);
    });
  });

  describe('getSessionsInfo', () => {
    it('should get display info for all sessions', async () => {
      await sessionManager.createSession('info-test-1');
      await sessionManager.saveSession('info-test-1', [
        { role: 'user', content: 'First message' },
      ]);

      await sessionManager.createSession('info-test-2');
      await sessionManager.saveSession('info-test-2', [
        { role: 'user', content: 'Second message' },
      ]);

      const infos = await sessionManager.getSessionsInfo();

      expect(infos.length).toBe(2);
      expect(infos[0].session_id).toBeDefined();
      expect(infos[0].display_name).toBeDefined();
      expect(infos[0].last_modified_timestamp).toBeDefined();
      expect(infos[0].message_count).toBeGreaterThanOrEqual(0);
    });

    it('should use first message as display name when no title', async () => {
      await sessionManager.createSession('no-title-test');
      await sessionManager.saveSession('no-title-test', [
        { role: 'user', content: 'This is a test message' },
      ]);

      const infos = await sessionManager.getSessionsInfo();
      const info = infos.find(i => i.session_id === 'no-title-test');

      expect(info?.display_name).toBe('This is a test message');
    });

    it('should truncate long messages in display name', async () => {
      const longMessage = 'a'.repeat(100);

      await sessionManager.createSession('long-msg-test');
      await sessionManager.saveSession('long-msg-test', [
        { role: 'user', content: longMessage },
      ]);

      const infos = await sessionManager.getSessionsInfo();
      const info = infos.find(i => i.session_id === 'long-msg-test');

      expect(info?.display_name.length).toBeLessThanOrEqual(43); // 40 + '...'
      expect(info?.display_name).toContain('...');
    });

    it('should prefer title over first message', async () => {
      await sessionManager.createSession('title-test');
      await sessionManager.saveSession('title-test', [
        { role: 'user', content: 'First message' },
      ]);

      // Update metadata with title
      await sessionManager.updateMetadata('title-test', {
        title: 'Custom Title',
      });

      const infos = await sessionManager.getSessionsInfo();
      const info = infos.find(i => i.session_id === 'title-test');

      expect(info?.display_name).toBe('Custom Title');
    });

    it('should sort by modification time (newest first)', async () => {
      await sessionManager.createSession('old');
      await new Promise(resolve => setTimeout(resolve, 10));

      await sessionManager.createSession('middle');
      await new Promise(resolve => setTimeout(resolve, 10));

      await sessionManager.createSession('new');

      const infos = await sessionManager.getSessionsInfo();

      expect(infos[0].session_id).toBe('new');
      expect(infos[2].session_id).toBe('old');
    });
  });

  describe('updateMetadata', () => {
    it('should update session metadata', async () => {
      await sessionManager.createSession('meta-test');

      const result = await sessionManager.updateMetadata('meta-test', {
        title: 'Test Title',
        tags: ['tag1', 'tag2'],
        model: 'qwen2.5-coder',
      });

      expect(result).toBe(true);

      const session = await sessionManager.loadSession('meta-test');
      expect(session?.metadata?.title).toBe('Test Title');
      expect(session?.metadata?.tags).toEqual(['tag1', 'tag2']);
      expect(session?.metadata?.model).toBe('qwen2.5-coder');
    });

    it('should merge metadata with existing values', async () => {
      await sessionManager.createSession('merge-test');
      await sessionManager.updateMetadata('merge-test', {
        title: 'Original Title',
        tags: ['tag1'],
      });

      await sessionManager.updateMetadata('merge-test', {
        model: 'new-model',
      });

      const session = await sessionManager.loadSession('merge-test');
      expect(session?.metadata?.title).toBe('Original Title');
      expect(session?.metadata?.tags).toEqual(['tag1']);
      expect(session?.metadata?.model).toBe('new-model');
    });

    it('should return false for non-existent session', async () => {
      const result = await sessionManager.updateMetadata('does-not-exist', {
        title: 'Test',
      });

      expect(result).toBe(false);
    });
  });

  describe('cleanup old sessions', () => {
    it('should keep only maxSessions most recent sessions', async () => {
      // Create 5 sessions (maxSessions is 3)
      await sessionManager.createSession('session-1');
      await new Promise(resolve => setTimeout(resolve, 10));

      await sessionManager.createSession('session-2');
      await new Promise(resolve => setTimeout(resolve, 10));

      await sessionManager.createSession('session-3');
      await new Promise(resolve => setTimeout(resolve, 10));

      await sessionManager.createSession('session-4');
      await new Promise(resolve => setTimeout(resolve, 10));

      await sessionManager.createSession('session-5');

      const sessions = await sessionManager.listSessions();
      expect(sessions.length).toBe(3);

      // Should keep the 3 most recent
      expect(sessions).toContain('session-3');
      expect(sessions).toContain('session-4');
      expect(sessions).toContain('session-5');
    });

    it('should not delete if under maxSessions limit', async () => {
      await sessionManager.createSession('keep-1');
      await sessionManager.createSession('keep-2');

      const sessions = await sessionManager.listSessions();
      expect(sessions.length).toBe(2);
      expect(sessions).toContain('keep-1');
      expect(sessions).toContain('keep-2');
    });
  });

  describe('working directory tracking', () => {
    it('should store working directory when creating session', async () => {
      const sessionName = await sessionManager.createSession('dir-test');
      const session = await sessionManager.loadSession(sessionName);

      expect(session).not.toBeNull();
      expect(session?.working_dir).toBeDefined();
      expect(session?.working_dir).toBe(process.cwd());
    });

    it('should include working_dir in session info', async () => {
      await sessionManager.createSession('dir-info-test');
      const infos = await sessionManager.getSessionsInfo();
      const info = infos.find(i => i.session_id === 'dir-info-test');

      expect(info).toBeDefined();
      expect(info?.working_dir).toBe(process.cwd());
    });

    it('should filter sessions by working directory', async () => {
      // Create sessions
      await sessionManager.createSession('session-1');
      await sessionManager.createSession('session-2');
      await sessionManager.createSession('session-3');

      // Get sessions for current directory
      const currentDirSessions = await sessionManager.getSessionsInfoByDirectory();

      // All sessions should be from current directory
      expect(currentDirSessions.length).toBe(3);
      currentDirSessions.forEach(session => {
        expect(session.working_dir).toBe(process.cwd());
      });
    });

    it('should return empty array when no sessions match directory', async () => {
      await sessionManager.createSession('test-session');

      // Query with a different directory
      const otherDirSessions = await sessionManager.getSessionsInfoByDirectory('/some/other/directory');

      expect(otherDirSessions.length).toBe(0);
    });
  });

  describe('orphaned patch directory cleanup', () => {
    it('should clean up orphaned patch directories on initialization', async () => {
      // Create a session with patches directory
      const sessionName = 'session_20240101T120000_test1234';
      const sessionJsonPath = join(tempDir, `${sessionName}.json`);
      const sessionDirPath = join(tempDir, sessionName);
      const patchesDirPath = join(sessionDirPath, 'patches');

      // Create the patches directory structure
      await fs.mkdir(patchesDirPath, { recursive: true });
      await fs.writeFile(join(patchesDirPath, 'test.patch'), 'test content');

      // Create the session JSON file
      const session = {
        id: sessionName,
        name: sessionName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        working_dir: process.cwd(),
        messages: [],
        metadata: {},
        active_plugins: [],
      };
      await fs.writeFile(sessionJsonPath, JSON.stringify(session, null, 2));

      // Verify everything exists
      await expect(fs.access(sessionJsonPath)).resolves.toBeUndefined();
      await expect(fs.access(patchesDirPath)).resolves.toBeUndefined();

      // Delete the session JSON (simulating orphaned state)
      await fs.unlink(sessionJsonPath);

      // Create a new SessionManager to trigger cleanup
      const newSessionManager = new SessionManager({ maxSessions: 3 });
      (newSessionManager as any).sessionsDir = tempDir;
      await newSessionManager.initialize();

      // Verify the orphaned directory was cleaned up
      await expect(fs.access(sessionDirPath)).rejects.toThrow();
      await expect(fs.access(patchesDirPath)).rejects.toThrow();

      await newSessionManager.cleanup();
    });

    it('should not delete directories with valid session JSON files', async () => {
      // Create a session with patches directory
      const sessionName = 'session_20240101T120000_test5678';
      const sessionJsonPath = join(tempDir, `${sessionName}.json`);
      const sessionDirPath = join(tempDir, sessionName);
      const patchesDirPath = join(sessionDirPath, 'patches');

      // Create the patches directory structure
      await fs.mkdir(patchesDirPath, { recursive: true });
      await fs.writeFile(join(patchesDirPath, 'test.patch'), 'test content');

      // Create the session JSON file
      const session = {
        id: sessionName,
        name: sessionName,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        working_dir: process.cwd(),
        messages: [],
        metadata: {},
        active_plugins: [],
      };
      await fs.writeFile(sessionJsonPath, JSON.stringify(session, null, 2));

      // Verify everything exists
      await expect(fs.access(sessionJsonPath)).resolves.toBeUndefined();
      await expect(fs.access(patchesDirPath)).resolves.toBeUndefined();

      // Create a new SessionManager to trigger cleanup (session JSON still exists)
      const newSessionManager = new SessionManager({ maxSessions: 3 });
      (newSessionManager as any).sessionsDir = tempDir;
      await newSessionManager.initialize();

      // Verify the directory was NOT deleted
      await expect(fs.access(sessionDirPath)).resolves.toBeUndefined();
      await expect(fs.access(patchesDirPath)).resolves.toBeUndefined();
      await expect(fs.access(sessionJsonPath)).resolves.toBeUndefined();

      await newSessionManager.cleanup();
    });

    it('should skip directories without patches subdirectory', async () => {
      // Create a directory without patches subdirectory
      const dirName = 'some_other_directory';
      const dirPath = join(tempDir, dirName);

      await fs.mkdir(dirPath, { recursive: true });
      await fs.writeFile(join(dirPath, 'somefile.txt'), 'test content');

      // Create a new SessionManager to trigger cleanup
      const newSessionManager = new SessionManager({ maxSessions: 3 });
      (newSessionManager as any).sessionsDir = tempDir;
      await newSessionManager.initialize();

      // Verify the directory was NOT deleted (no patches subdirectory)
      await expect(fs.access(dirPath)).resolves.toBeUndefined();

      await newSessionManager.cleanup();
    });

    it('should skip .quarantine and other hidden directories', async () => {
      // Create hidden directories
      const quarantinePath = join(tempDir, '.quarantine');
      const hiddenPath = join(tempDir, '.hidden');

      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.mkdir(hiddenPath, { recursive: true });

      // Create a new SessionManager to trigger cleanup
      const newSessionManager = new SessionManager({ maxSessions: 3 });
      (newSessionManager as any).sessionsDir = tempDir;
      await newSessionManager.initialize();

      // Verify hidden directories were NOT deleted
      await expect(fs.access(quarantinePath)).resolves.toBeUndefined();
      await expect(fs.access(hiddenPath)).resolves.toBeUndefined();

      await newSessionManager.cleanup();
    });

    it('should handle multiple orphaned directories', async () => {
      // Create multiple orphaned patch directories
      const orphanedSessions = [
        'session_20240101T120000_orphan1',
        'session_20240101T130000_orphan2',
        'session_20240101T140000_orphan3',
      ];

      for (const sessionName of orphanedSessions) {
        const sessionDirPath = join(tempDir, sessionName);
        const patchesDirPath = join(sessionDirPath, 'patches');
        await fs.mkdir(patchesDirPath, { recursive: true });
        await fs.writeFile(join(patchesDirPath, 'test.patch'), 'test content');
      }

      // Verify all directories exist
      for (const sessionName of orphanedSessions) {
        await expect(fs.access(join(tempDir, sessionName, 'patches'))).resolves.toBeUndefined();
      }

      // Create a new SessionManager to trigger cleanup
      const newSessionManager = new SessionManager({ maxSessions: 3 });
      (newSessionManager as any).sessionsDir = tempDir;
      await newSessionManager.initialize();

      // Verify all orphaned directories were cleaned up
      for (const sessionName of orphanedSessions) {
        await expect(fs.access(join(tempDir, sessionName))).rejects.toThrow();
      }

      await newSessionManager.cleanup();
    });
  });
});
