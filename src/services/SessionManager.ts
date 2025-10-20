/**
 * SessionManager - Manages conversation session persistence
 *
 * Handles creating, loading, saving, and cleaning up conversation sessions.
 * Sessions are stored as JSON files in ~/.ally/sessions/
 *
 * Features:
 * - Session CRUD operations
 * - Auto-cleanup of old sessions
 * - Session info retrieval with display names
 * - Current session tracking
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { SESSIONS_DIR } from '../config/paths.js';
import { Session, SessionInfo, Message, IService } from '../types/index.js';
import { generateShortId } from '../utils/id.js';

/**
 * Configuration for SessionManager
 */
export interface SessionManagerConfig {
  /** Maximum number of sessions to keep before auto-cleanup */
  maxSessions?: number;
  /** Model client for title generation (optional) */
  modelClient?: any;
}

/**
 * SessionManager handles all session persistence operations
 */
export class SessionManager implements IService {
  private currentSession: string | null = null;
  private sessionsDir: string;
  private maxSessions: number;
  private titleGenerator: any | null = null;

  constructor(config: SessionManagerConfig = {}) {
    this.sessionsDir = SESSIONS_DIR;
    this.maxSessions = config.maxSessions ?? 10;
    this.titleGenerator = config.modelClient ? null : null; // Will be set later if needed
  }

  /**
   * Initialize the session manager (creates sessions directory)
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
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
      messages: [],
      metadata: {},
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
      const session = JSON.parse(content) as Session;
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      console.error(`Failed to load session ${sessionName}:`, error);
      return null;
    }
  }

  /**
   * Save session data to disk
   *
   * @param sessionName - Name of the session
   * @param session - Complete session object
   */
  private async saveSessionData(sessionName: string, session: Session): Promise<void> {
    const sessionPath = this.getSessionPath(sessionName);
    await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
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
          messages: [],
          metadata: {},
        };
      }

      // Update session
      session.messages = messages;
      session.updated_at = new Date().toISOString();

      await this.saveSessionData(sessionName, session);
      await this.cleanupOldSessions();

      return true;
    } catch (error) {
      console.error(`Failed to save session ${sessionName}:`, error);
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
    try {
      await fs.unlink(sessionPath);
      if (this.currentSession === sessionName) {
        this.currentSession = null;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false; // Already deleted
      }
      console.error(`Failed to delete session ${sessionName}:`, error);
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
          displayName = cleanContent.length > 40
            ? cleanContent.slice(0, 40) + '...'
            : cleanContent;
        } else {
          displayName = '(no messages)';
        }
      }

      // Format date
      const updatedAt = new Date(session.updated_at);
      const formattedDate = updatedAt.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

      infos.push({
        session_id: session.id,
        display_name: displayName,
        last_modified: formattedDate,
        message_count: session.messages.length,
        timestamp: updatedAt.getTime(),
      });
    }

    // Sort by actual timestamp (newest first)
    infos.sort((a, b) => b.timestamp - a.timestamp);

    // Remove timestamp from final result
    return infos.map(({ timestamp, ...info }) => info);
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
          console.error(`Failed to delete old session ${path}:`, error);
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old sessions:', error);
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
      console.error(`Failed to update metadata for ${sessionName}:`, error);
      return false;
    }
  }
}
