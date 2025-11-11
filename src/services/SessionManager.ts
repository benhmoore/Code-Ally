/**
 * SessionManager - Manages conversation session persistence
 *
 * Handles creating, loading, saving, and cleaning up conversation sessions.
 * Sessions are stored as JSON files in .ally-sessions/ within each project directory.
 *
 * Features:
 * - Session CRUD operations
 * - Auto-cleanup of old sessions
 * - Session info retrieval with display names
 * - Current session tracking
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { Session, SessionInfo, Message, IService } from '../types/index.js';
import { generateShortId } from '../utils/id.js';
import type { TodoItem } from './TodoManager.js';
import { SessionTitleGenerator } from './SessionTitleGenerator.js';
import { logger } from './Logger.js';
import { TEXT_LIMITS, BUFFER_SIZES } from '../config/constants.js';

/**
 * Interface for ModelClient methods used by SessionManager
 */
export interface IModelClientForSessionManager {
  send(messages: any[], options?: any): Promise<any>;
  modelName: string;
  endpoint: string;
}

/**
 * Interface for SessionTitleGenerator
 */
export interface ISessionTitleGenerator {
  generateTitleBackground(sessionName: string, firstUserMessage: string, sessionsDir: string): void;
  cleanup?(): Promise<void>;
}

/**
 * Configuration for SessionManager
 */
export interface SessionManagerConfig {
  /** Maximum number of sessions to keep before auto-cleanup */
  maxSessions?: number;
  /** Model client for title generation (optional) */
  modelClient?: IModelClientForSessionManager;
}

/**
 * SessionManager handles all session persistence operations
 */
export class SessionManager implements IService {
  private currentSession: string | null = null;
  private sessionsDir: string;
  private maxSessions: number;
  private titleGenerator: ISessionTitleGenerator | null = null;

  // Write queue to serialize file operations and prevent race conditions
  // Uses pure promise chaining - each new write waits for the previous one to complete
  // This creates a serial queue without explicit locks or busy-wait loops
  private writeQueue: Map<string, Promise<void>> = new Map();

  constructor(config: SessionManagerConfig = {}) {
    // Sessions are stored in .ally-sessions/ within the current working directory
    this.sessionsDir = join(process.cwd(), '.ally-sessions');
    this.maxSessions = config.maxSessions ?? BUFFER_SIZES.MAX_SESSIONS_DEFAULT;
    this.titleGenerator = config.modelClient
      ? new SessionTitleGenerator(config.modelClient)
      : null;
  }

  /**
   * Initialize the session manager (creates sessions directory)
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await fs.mkdir(join(this.sessionsDir, '.quarantine'), { recursive: true });

    // Clean up any stale temporary files from previous crashes
    await this.cleanupTempFiles();
  }

  /**
   * Clean up stale temporary files left over from crashes
   */
  private async cleanupTempFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.sessionsDir);
      const tempFiles = files.filter(file => file.includes('.tmp.'));

      for (const tempFile of tempFiles) {
        try {
          const tempPath = join(this.sessionsDir, tempFile);
          await fs.unlink(tempPath);
          logger.debug(`[SESSION] Cleaned up stale temp file: ${tempFile}`);
        } catch (error) {
          // Ignore errors cleaning up temp files
        }
      }

      if (tempFiles.length > 0) {
        logger.info(`[SESSION] Cleaned up ${tempFiles.length} stale temporary file(s)`);
      }
    } catch (error) {
      // Ignore errors during cleanup
      logger.debug('[SESSION] Error during temp file cleanup:', error);
    }
  }

  /**
   * Set the model client for title generation
   * Call this after service model client is created
   */
  setModelClient(modelClient: IModelClientForSessionManager): void {
    this.titleGenerator = new SessionTitleGenerator(modelClient);
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.titleGenerator) {
      await this.titleGenerator.cleanup?.();
    }
  }

  /**
   * Generate a unique session name with timestamp and short UUID
   */
  generateSessionName(): string {
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    const shortUuid = generateShortId();
    return `session_${timestamp}_${shortUuid}`;
  }

  /**
   * Get the file path for a session
   */
  private getSessionPath(sessionName: string): string {
    return join(this.sessionsDir, `${sessionName}.json`);
  }

  /**
   * Quarantine a corrupted session file instead of deleting it
   */
  private async quarantineSession(sessionName: string, reason: string): Promise<void> {
    const sessionPath = this.getSessionPath(sessionName);
    const quarantinePath = join(this.sessionsDir, '.quarantine', `${sessionName}_${Date.now()}.json`);

    try {
      await fs.rename(sessionPath, quarantinePath);
      logger.warn(`Session ${sessionName} quarantined (${reason}): ${quarantinePath}`);
    } catch (error) {
      logger.error(`Failed to quarantine session ${sessionName}:`, error);
      // Only delete if quarantine fails
      try {
        await fs.unlink(sessionPath);
        logger.warn(`Deleted corrupted session file after quarantine failure: ${sessionName}`);
      } catch (deleteError) {
        logger.error(`Failed to delete session ${sessionName} after quarantine failure:`, deleteError);
      }
    }
  }

  /**
   * Create a new session
   *
   * @param sessionName - Optional session name. If omitted, auto-generates one
   * @returns The session name (provided or generated)
   */
  async createSession(sessionName?: string): Promise<string> {
    const name = sessionName ?? this.generateSessionName();

    const session: Session = {
      id: name,
      name,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      working_dir: process.cwd(),
      messages: [],
      metadata: {},
      active_plugins: [], // Initialize with empty array
    };

    await this.saveSessionData(name, session);
    await this.cleanupOldSessions();

    return name;
  }

  /**
   * Load an existing session
   *
   * @param sessionName - Name of the session to load
   * @returns Session data or null if not found
   */
  async loadSession(sessionName: string): Promise<Session | null> {
    const sessionPath = this.getSessionPath(sessionName);

    try {
      const content = await fs.readFile(sessionPath, 'utf-8');

      // Handle empty or corrupted files
      if (!content || content.trim().length === 0) {
        await this.quarantineSession(sessionName, 'empty file');
        return null;
      }

      const session = JSON.parse(content) as Session;
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      // If JSON parse fails, the file is corrupted - quarantine it
      if (error instanceof SyntaxError) {
        await this.quarantineSession(sessionName, 'invalid JSON');
        return null;
      }

      logger.error(`Failed to load session ${sessionName}:`, error);
      return null;
    }
  }

  /**
   * Save session data to disk atomically with write serialization
   *
   * Uses atomic write (temp file + rename) and pure promise chaining to serialize writes.
   * This approach is truly atomic because:
   * 1. We capture the existing write promise synchronously (no race window)
   * 2. We chain our write to complete AFTER the previous one
   * 3. We update the queue with our promise before any async operations begin
   *
   * No locks or busy-wait loops needed - just pure promise chaining.
   *
   * @param sessionName - Name of the session
   * @param session - Complete session object
   */
  private async saveSessionData(sessionName: string, session: Session): Promise<void> {
    // Capture the existing write promise synchronously (before any async operations)
    // This ensures we see the current queue state atomically
    const existingWrite = this.writeQueue.get(sessionName);

    // Create our write promise that chains after the existing one
    const writePromise = (async () => {
      // Wait for the previous write to complete (if there was one)
      // We ignore errors from previous writes - we'll try our write regardless
      if (existingWrite) {
        await existingWrite.catch(() => {
          // Ignore errors from previous writes
        });
      }

      // Now perform our atomic file write
      const sessionPath = this.getSessionPath(sessionName);
      // Generate temp file with timestamp and random suffix (base-36 string starting at index 7)
      const tempPath = `${sessionPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(7)}`;

      try {
        // Write to temporary file first
        await fs.writeFile(tempPath, JSON.stringify(session, null, 2), 'utf-8');

        // Atomic rename - this is the critical operation
        // On POSIX systems, rename() is atomic and will replace the target file
        await fs.rename(tempPath, sessionPath);

        logger.debug(`[SESSION] Saved session ${sessionName} atomically`);
      } catch (error) {
        // Clean up temp file if it exists
        try {
          await fs.unlink(tempPath);
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    })();

    // Update the queue with our promise BEFORE we await it
    // This ensures the next caller will chain after us
    this.writeQueue.set(sessionName, writePromise);

    // Wait for our write to complete
    await writePromise;

    // Clean up our promise from the queue if we're still the current one
    // Another write may have already started and replaced us in the queue
    if (this.writeQueue.get(sessionName) === writePromise) {
      this.writeQueue.delete(sessionName);
    }
  }

  /**
   * Save messages to a session
   *
   * @param sessionName - Name of the session
   * @param messages - Messages to save
   * @returns True if saved successfully
   */
  async saveSession(sessionName: string, messages: Message[]): Promise<boolean> {
    try {
      // Load existing session or create new one
      let session = await this.loadSession(sessionName);

      if (!session) {
        session = {
          id: sessionName,
          name: sessionName,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          working_dir: process.cwd(),
          messages: [],
          metadata: {},
          active_plugins: [], // Initialize with empty array for backward compatibility
        };
      }

      // Update session
      session.messages = messages;
      session.updated_at = new Date().toISOString();

      await this.saveSessionData(sessionName, session);
      await this.cleanupOldSessions();

      return true;
    } catch (error) {
      logger.error(`Failed to save session ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Check if a session exists
   *
   * @param sessionName - Name of the session to check
   * @returns True if session exists
   */
  async sessionExists(sessionName: string): Promise<boolean> {
    const sessionPath = this.getSessionPath(sessionName);
    try {
      await fs.access(sessionPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all available session names
   *
   * @returns Array of session names (without .json extension)
   */
  async listSessions(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.sessionsDir);
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.slice(0, -5)) // Remove .json extension
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Delete a session
   *
   * @param sessionName - Name of the session to delete
   * @returns True if deleted successfully
   */
  async deleteSession(sessionName: string): Promise<boolean> {
    const sessionPath = this.getSessionPath(sessionName);
    const sessionDir = sessionPath.replace('.json', ''); // Directory for session data (e.g., patches)

    try {
      // Delete session file
      await fs.unlink(sessionPath);

      // Delete session directory (if it exists) - includes patches and other session data
      try {
        await fs.rm(sessionDir, { recursive: true, force: true });
        logger.info(`Deleted session directory: ${sessionDir}`);
      } catch (dirError) {
        // Directory might not exist, that's okay
        logger.debug(`No session directory to delete: ${sessionDir}`);
      }

      if (this.currentSession === sessionName) {
        this.currentSession = null;
      }

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false; // Already deleted
      }
      logger.error(`Failed to delete session ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Get the current active session name
   *
   * @returns Current session name or null
   */
  getCurrentSession(): string | null {
    return this.currentSession;
  }

  /**
   * Set the current active session
   *
   * @param sessionName - Session name or null to clear
   */
  setCurrentSession(sessionName: string | null): void {
    this.currentSession = sessionName;
  }

  /**
   * Get messages from a session
   *
   * @param sessionName - Name of the session
   * @returns Array of messages or empty array if not found
   */
  async getSessionMessages(sessionName: string): Promise<Message[]> {
    const session = await this.loadSession(sessionName);
    return session?.messages ?? [];
  }

  /**
   * Get all session data in a single read (optimized for session resume)
   *
   * This method loads the session file once and returns all commonly needed data,
   * avoiding multiple file reads during session resume.
   *
   * @param sessionName - Name of the session
   * @returns Object containing messages, todos, idle messages, and project context
   */
  async getSessionData(sessionName: string): Promise<{
    messages: Message[];
    todos: TodoItem[];
    idleMessages: string[];
    projectContext: Session['project_context'] | null;
  }> {
    const session = await this.loadSession(sessionName);

    if (!session) {
      return {
        messages: [],
        todos: [],
        idleMessages: [],
        projectContext: null,
      };
    }

    return {
      messages: session.messages ?? [],
      todos: session.todos ?? [],
      idleMessages: session.idle_messages ?? [],
      projectContext: session.project_context ?? null,
    };
  }

  /**
   * Get information about all sessions for display
   *
   * @returns Array of SessionInfo objects sorted by modification time (newest first)
   */
  async getSessionsInfo(): Promise<SessionInfo[]> {
    const sessionNames = await this.listSessions();
    const infos: Array<SessionInfo & { timestamp: number }> = [];

    for (const name of sessionNames) {
      const session = await this.loadSession(name);
      if (!session) continue;

      // Determine display name - prefer title, fallback to first message snippet
      let displayName = session.metadata?.title;
      if (!displayName) {
        const firstUserMessage = session.messages.find(msg => msg.role === 'user');
        if (firstUserMessage) {
          const content = firstUserMessage.content.trim();
          const cleanContent = content.replace(/\s+/g, ' ');
          displayName = cleanContent.length > TEXT_LIMITS.COMMAND_DISPLAY_MAX
            ? cleanContent.slice(0, TEXT_LIMITS.COMMAND_DISPLAY_MAX) + '...'
            : cleanContent;
        } else {
          displayName = '(no messages)';
        }
      }

      const updatedAt = new Date(session.updated_at);

      infos.push({
        session_id: session.id,
        display_name: displayName,
        last_modified_timestamp: updatedAt.getTime(),
        message_count: session.messages.length,
        working_dir: session.working_dir,
        timestamp: updatedAt.getTime(),
      });
    }

    // Sort by actual timestamp (newest first)
    infos.sort((a, b) => b.timestamp - a.timestamp);

    // Remove internal sorting timestamp from final result
    return infos.map(({ timestamp, ...info }) => info);
  }

  /**
   * Get information about sessions filtered by working directory
   *
   * @param workingDir - The working directory to filter by (defaults to current directory)
   * @returns Array of SessionInfo objects for sessions in the specified directory, sorted by modification time (newest first)
   */
  async getSessionsInfoByDirectory(workingDir?: string): Promise<SessionInfo[]> {
    const targetDir = workingDir ?? process.cwd();
    const allSessions = await this.getSessionsInfo();
    return allSessions.filter(session => session.working_dir === targetDir);
  }

  /**
   * Clean up old sessions beyond the maximum limit
   *
   * Keeps only the most recently modified sessions up to maxSessions count
   */
  private async cleanupOldSessions(): Promise<void> {
    try {
      const files = await fs.readdir(this.sessionsDir);
      const jsonFiles = files.filter(file => file.endsWith('.json'));

      if (jsonFiles.length <= this.maxSessions) {
        return;
      }

      // Get file stats with modification times
      const fileStats = await Promise.all(
        jsonFiles.map(async file => {
          const filePath = join(this.sessionsDir, file);
          const stats = await fs.stat(filePath);
          return { file, mtime: stats.mtime.getTime(), path: filePath };
        })
      );

      // Sort by modification time (newest first)
      fileStats.sort((a, b) => b.mtime - a.mtime);

      // Delete old sessions beyond the limit
      const toDelete = fileStats.slice(this.maxSessions);
      for (const { path } of toDelete) {
        try {
          await fs.unlink(path);
        } catch (error) {
          logger.error(`Failed to delete old session ${path}:`, error);
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup old sessions:', error);
    }
  }

  /**
   * Update session metadata
   *
   * @param sessionName - Name of the session
   * @param metadata - Partial metadata to merge
   * @returns True if updated successfully
   */
  async updateMetadata(
    sessionName: string,
    metadata: Partial<Session['metadata']>
  ): Promise<boolean> {
    try {
      const session = await this.loadSession(sessionName);
      if (!session) return false;

      session.metadata = {
        ...session.metadata,
        ...metadata,
      };
      session.updated_at = new Date().toISOString();

      await this.saveSessionData(sessionName, session);
      return true;
    } catch (error) {
      logger.error(`Failed to update metadata for ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Update session fields
   *
   * Allows updating arbitrary session fields while maintaining atomic writes.
   * Use this for updating session properties like active_plugins, todos, etc.
   *
   * @param sessionName - Name of the session to update
   * @param updates - Partial session object with fields to update
   * @returns True if update succeeded, false otherwise
   */
  async updateSession(
    sessionName: string,
    updates: Partial<Omit<Session, 'id' | 'name' | 'created_at'>>
  ): Promise<boolean> {
    try {
      const session = await this.loadSession(sessionName);
      if (!session) return false;

      // Apply updates to session
      Object.assign(session, updates);
      session.updated_at = new Date().toISOString();

      await this.saveSessionData(sessionName, session);
      return true;
    } catch (error) {
      logger.error(`Failed to update session ${sessionName}:`, error);
      return false;
    }
  }

  /**
   * Get todos from a session
   *
   * @param sessionName - Name of the session (defaults to current session)
   * @returns Array of todos or empty array if not found
   */
  async getTodos(sessionName?: string): Promise<TodoItem[]> {
    const name = sessionName ?? this.currentSession;
    if (!name) return [];

    const session = await this.loadSession(name);
    return session?.todos ?? [];
  }

  /**
   * Get idle messages from a session
   *
   * @param sessionName - Name of the session (defaults to current session)
   * @returns Array of idle messages
   */
  async getIdleMessages(sessionName?: string): Promise<string[]> {
    const name = sessionName ?? this.currentSession;
    if (!name) return [];

    const session = await this.loadSession(name);
    const messages = session?.idle_messages ?? [];
    logger.debug(`[SESSION] getIdleMessages for ${name}: ${messages.length} messages - ${JSON.stringify(messages.slice(0, 3))}...`);
    return messages;
  }

  /**
   * Get project context from a session
   *
   * @param sessionName - Name of the session (defaults to current session)
   * @returns Project context or null if not found
   */
  async getProjectContext(sessionName?: string): Promise<Session['project_context'] | null> {
    const name = sessionName ?? this.currentSession;
    if (!name) return null;

    const session = await this.loadSession(name);
    return session?.project_context ?? null;
  }

  /**
   * Save todos to a session
   *
   * @param todos - Array of todos to save
   * @param sessionName - Name of the session (defaults to current session)
   * @returns True if saved successfully
   */
  async setTodos(
    todos: TodoItem[],
    sessionName?: string
  ): Promise<boolean> {
    const name = sessionName ?? this.currentSession;
    if (!name) return false;

    try {
      let session = await this.loadSession(name);

      if (!session) {
        // Create new session if it doesn't exist
        session = {
          id: name,
          name,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          working_dir: process.cwd(),
          messages: [],
          todos: [],
          metadata: {},
          active_plugins: [], // Initialize with empty array for backward compatibility
        };
      }

      session.todos = todos;
      session.updated_at = new Date().toISOString();

      await this.saveSessionData(name, session);
      return true;
    } catch (error) {
      logger.error(`Failed to save todos for ${name}:`, error);
      return false;
    }
  }

  /**
   * Auto-save current session (messages and todos)
   *
   * @param messages - Current conversation messages
   * @param todos - Current todos
   * @param idleMessages - Idle message queue
   * @param projectContext - Project context
   * @returns True if saved successfully
   */
  async autoSave(
    messages: Message[],
    todos?: TodoItem[],
    idleMessages?: string[],
    projectContext?: Session['project_context']
  ): Promise<boolean> {
    const name = this.currentSession;
    if (!name) return false;

    // Filter out system messages to avoid duplication on resume
    const filteredMessages = messages.filter(msg => msg.role !== 'system');

    if (filteredMessages.length === 0 && (!todos || todos.length === 0)) {
      return false; // Nothing to save
    }

    try {
      let session = await this.loadSession(name);

      if (!session) {
        session = {
          id: name,
          name,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          working_dir: process.cwd(),
          messages: [],
          todos: [],
          metadata: {},
          active_plugins: [], // Initialize with empty array for backward compatibility
        };
      }

      // Ensure backward compatibility - initialize active_plugins if undefined
      if (session.active_plugins === undefined) {
        session.active_plugins = [];
      }

      session.messages = filteredMessages;
      if (todos !== undefined) {
        session.todos = todos;
      }
      if (idleMessages !== undefined && idleMessages.length > 0) {
        logger.debug(`[SESSION] Saving ${idleMessages.length} idle messages: ${JSON.stringify(idleMessages.slice(0, 3))}...`);
        session.idle_messages = idleMessages;
      }
      if (projectContext !== undefined) {
        session.project_context = projectContext;
      }
      session.updated_at = new Date().toISOString();

      await this.saveSessionData(name, session);

      // Trigger title generation for new sessions
      // Only generate title after BOTH user message AND assistant response
      if (filteredMessages.length > 0 && !session.title && !session.metadata?.title) {
        const firstUserMessage = filteredMessages.find(msg => msg.role === 'user');
        const hasAssistantResponse = filteredMessages.some(msg => msg.role === 'assistant');
        if (firstUserMessage && hasAssistantResponse && this.titleGenerator) {
          this.titleGenerator.generateTitleBackground(
            name,
            firstUserMessage.content,
            this.sessionsDir
          );
        }
      }

      return true;
    } catch (error) {
      logger.error(`Failed to auto-save session ${name}:`, error);
      return false;
    }
  }
}
